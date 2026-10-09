import { describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, harness, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

describe('arguments', () => {
  it('--drop <projet:lot> et --stop-after-current', () => {
    expect(parseOrchestrateArgs(['--drop', 'ccc:L29', '--wave', 'w1'])).toMatchObject({ drop: [{ project: 'ccc', lot: 'L29' }], wave: 'w1', stopAfterCurrent: false });
    expect(parseOrchestrateArgs(['--stop-after-current'])).toMatchObject({ stopAfterCurrent: true, drop: [] });
    expect(() => parseOrchestrateArgs(['--drop'])).toThrow(/attend une valeur/);
  });
});

describe('demandes en cours de vague (RunStore)', () => {
  it('les demandes s\'ajoutent au dossier de la vague et se relisent ; sans demande : rien', () => {
    const store = new RunStore(tempDir(), 'w1');
    expect(store.control()).toEqual({ drops: [], stopAfterCurrent: false });
    store.requestDrop('ccc:L29');
    store.requestStopAfterCurrent();
    store.requestDrop('ccc:L30');
    expect(store.control()).toEqual({ drops: ['ccc:L29', 'ccc:L30'], stopAfterCurrent: true });
    store.clearStopRequest(); // --resume : l'arrêt s'efface, les retraits restent
    expect(store.control()).toEqual({ drops: ['ccc:L29', 'ccc:L30'], stopAfterCurrent: false });
    expect(store.lots()).toEqual([]); // le fichier de demandes n'est pas pris pour un lot
  });
});

describe('cycle', () => {
  it('un lot retiré avant son départ est rendu sans aucune session ni raf start', async () => {
    const h = harness();
    h.store.requestDrop('demo:L1');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/retiré de la vague \(--drop\)/);
    expect(h.calls).toEqual([]);
    expect(h.plan().lot('L1').status).toBe('todo');
  });

  it('un lot retiré pendant une session : la session finit, aucune suivante, lot rendu', async () => {
    const h = harness({ script: { implement: [() => { h.store.requestDrop('demo:L1'); return claudeOut(workReport({ commits: [commitFile(h.repo, 'a.txt', 'feat(L1): a')] })); }] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/retiré de la vague/);
  });

  it('--stop-after-current : la session en cours finit, aucune suivante, lot reprenable', async () => {
    const h = harness({ script: { implement: [() => { h.store.requestStopAfterCurrent(); return claudeOut(workReport({ commits: [commitFile(h.repo, 'a.txt', 'feat(L1): a')] })); }] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement']);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.outcome).toMatch(/arrêt demandé \(--stop-after-current\)/);
  });
});

function parentWith(names: string[], lots = 1) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < lots; i++) plan.add('lot', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
  }
  return parent;
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

function deps(onSession: (kind: string, cwd: string) => Promise<void> | void) {
  const calls: { cwd: string; kind: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    calls.push({ cwd: o.cwd, kind });
    await onSession(kind, o.cwd);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind === 'implement' || kind === 'fix') {
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
    }
    return claudeOut(reviewReport());
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  return { d, calls };
}

describe('orchestrate --drop / --stop-after-current sur une vague vivante', () => {
  it('--drop écarte un lot qui n\'a pas démarré ; l\'autre lot va à son terme', async () => {
    const parent = parentWith(['a', 'b']);
    let dropped = '';
    const { d, calls } = deps(async (kind) => {
      if (kind === 'implement' && !dropped) {
        const r = io(parent);
        expect(await orchestrate(['--drop', 'b:L1'], r.io, d)).toBe(0);
        dropped = r.out.join('\n');
      }
    });
    const r = io(parent);
    const code = await orchestrate(['a:L1', 'b:L1', '--max-sessions', '1'], r.io, d);
    expect(dropped).toMatch(/b:L1 : retrait demandé/);
    expect(calls.every((c) => c.cwd.endsWith('/a'))).toBe(true);
    expect(code).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readLot('b', 'L1')!.status).toBe('handed-back');
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
  });

  it('--stop-after-current : aucune nouvelle session ni lot, la vague est reprenable (interrupted)', async () => {
    const parent = parentWith(['a', 'b']);
    let asked = false;
    const { d, calls } = deps(async (kind) => {
      if (kind === 'implement' && !asked) {
        asked = true;
        expect(await orchestrate(['--stop-after-current'], io(parent).io, d)).toBe(0);
      }
    });
    const r = io(parent);
    const code = await orchestrate(['a:L1', 'b:L1', '--max-sessions', '1'], r.io, d);
    expect(calls.map((c) => c.kind)).toEqual(['implement']);
    expect(code).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readWave()!.status).toBe('interrupted');
    expect(store.readLot('a', 'L1')!.status).toBe('suspended');
    expect(store.readLot('b', 'L1')!.status).toBe('suspended');
  });

  it('refus (code 2) : aucune vague vivante, lot inconnu ou déjà fini', async () => {
    const parent = parentWith(['a']);
    const none = io(parent);
    const { d } = deps(() => {});
    expect(await orchestrate(['--drop', 'a:L1'], none.io, d)).toBe(2);
    expect(none.err.join('\n')).toMatch(/aucune vague en cours/);
    expect(await orchestrate(['--stop-after-current'], io(parent).io, d)).toBe(2);

    let unknown = '';
    const dd = deps(async (kind) => {
      if (kind === 'implement') {
        const r = io(parent);
        expect(await orchestrate(['--drop', 'a:L9'], r.io, dd.d)).toBe(2);
        unknown = r.err.join('\n');
      }
    });
    await orchestrate(['a:L1'], io(parent).io, dd.d);
    expect(unknown).toMatch(/a:L9 : lot inconnu dans la vague/);
    const finished = io(parent);
    expect(await orchestrate(['--drop', 'a:L1'], finished.io, dd.d)).toBe(2); // la vague est finie : plus rien à retirer
  });
});

describe('--resume avec --drop / --stop-after-current (L79, revue)', () => {
  /** Une vague arrêtée par --stop-after-current : a:L1 et b:L1 suspendus. */
  async function stoppedWave() {
    const parent = parentWith(['a', 'b']);
    let asked = false;
    const first = deps(async (kind) => {
      if (kind === 'implement' && !asked) {
        asked = true;
        expect(await orchestrate(['--stop-after-current'], io(parent).io, first.d)).toBe(0);
      }
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '1'], io(parent).io, first.d);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('suspended');
    expect(store.readLot('b', 'L1')!.status).toBe('suspended');
    return { parent, store };
  }

  it('--resume --drop b:L1 : b:L1 n\'est pas rejoué, il est rendu au lead ; a:L1 va à son terme', async () => {
    const { parent, store } = await stoppedWave();
    const second = deps(() => {});
    const r = io(parent);
    expect(await orchestrate(['--resume', '--drop', 'b:L1'], r.io, second.d)).toBe(1);
    expect(second.calls.every((c) => c.cwd.endsWith('/a'))).toBe(true);
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('b', 'L1')!.status).toBe('handed-back');
    expect(store.readLot('b', 'L1')!.outcome).toMatch(/retiré de la vague/);
    expect(store.readWave()!.status).toBe('done');
  });

  it('--resume --drop d\'un lot inconnu ou déjà fini est refusé (code 2) avant de jouer quoi que ce soit', async () => {
    const { parent, store } = await stoppedWave();
    const second = deps(() => {});
    const unknown = io(parent);
    expect(await orchestrate(['--resume', '--drop', 'b:L9'], unknown.io, second.d)).toBe(2);
    expect(unknown.err.join('\n')).toMatch(/--drop b:L9 : lot inconnu dans la vague/);
    expect(second.calls).toEqual([]);
    expect(store.control().drops).toEqual([]);
  });

  it('--resume --stop-after-current et --status avec --drop / --stop-after-current sont refusés', async () => {
    const parent = parentWith(['a']);
    const { d } = deps(() => {});
    await expect(orchestrate(['--resume', '--stop-after-current'], io(parent).io, d)).rejects.toThrow(/--resume ne se combine pas avec --stop-after-current/);
    await expect(orchestrate(['--status', '--drop', 'a:L1'], io(parent).io, d)).rejects.toThrow(/--status ne se combine pas avec --drop \/ --stop-after-current/);
    await expect(orchestrate(['--status', '--stop-after-current'], io(parent).io, d)).rejects.toThrow(/--status ne se combine pas/);
  });

  it('--resume après --stop-after-current rejoue les lots suspendus (l\'arrêt demandé est oublié)', async () => {
    const { parent, store } = await stoppedWave();
    expect(store.control().stopAfterCurrent).toBe(true);
    const second = deps(() => {});
    expect(await orchestrate(['--resume', '--max-sessions', '1'], io(parent).io, second.d)).toBe(0);
    expect(store.control().stopAfterCurrent).toBe(false);
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('b', 'L1')!.status).toBe('ready');
    expect(store.readWave()!.status).toBe('done');
  });
});

describe('--drop d\'un lot en question (L79, revue)', () => {
  it('a:L1 pose une question pendant que b:L1 tourne, --drop a:L1 : a:L1 est rendu au lead et la vague finit « done »', async () => {
    const parent = parentWith(['a', 'b']);
    const sessions: string[] = [];
    let store: RunStore | undefined;
    const claude: ClaudeFn = async (args, o) => {
      const kind = kindOf(args);
      sessions.push(`${o.cwd.split('/').pop()}:${kind}`);
      if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
      if (o.cwd.endsWith('/a')) return claudeOut(workReport({ questions: ['Quelle base ?'] }));
      // b tourne : on attend que a:L1 ait posé sa question, puis on demande son retrait depuis un autre terminal
      store = RunStore.last(parent)!;
      for (let i = 0; i < 200 && store.readLot('a', 'L1')?.status !== 'question'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(store.readLot('a', 'L1')!.status).toBe('question');
      expect(await orchestrate(['--drop', 'a:L1'], io(parent).io, d)).toBe(0);
      return claudeOut(workReport({ commits: [commitFile(o.cwd, 'b.txt', 'feat(L1): b')] }));
    };
    const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    const r = io(parent);
    expect(await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], r.io, d)).toBe(1);
    expect(store!.readLot('a', 'L1')!.status).toBe('handed-back');
    expect(store!.readLot('a', 'L1')!.outcome).toMatch(/retiré de la vague/);
    expect(store!.readLot('b', 'L1')!.status).toBe('ready');
    expect(store!.readWave()!.status).toBe('done');
  });

  it('--resume --drop d\'un lot en question le rend au lieu de le laisser en question', async () => {
    const parent = parentWith(['a']);
    const first = deps(() => {});
    const asking: OrchestrateDeps = { ...first.d, claude: async (args, o) => (kindOf(args) === 'implement' ? claudeOut(workReport({ questions: ['Quelle base ?'] })) : first.d.claude(args, o)) };
    expect(await orchestrate(['a:L1'], io(parent).io, asking)).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('question');
    const second = deps(() => {});
    expect(await orchestrate(['--resume', '--drop', 'a:L1'], io(parent).io, second.d)).toBe(1);
    expect(second.calls).toEqual([]);
    expect(store.readLot('a', 'L1')!.status).toBe('handed-back');
    expect(store.readWave()!.status).toBe('done');
  });
});
