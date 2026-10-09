import { describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { waveReadsControl } from '../src/orchestrate/snapshot.js';
import { registerWave } from '../src/orchestrate/registry.js';
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

  it('--resume --drop b:L1 avec le dépôt de b sale : le lot retiré ne subit pas les contrôles de reprise, a:L1 est rejoué', async () => {
    const { parent, store } = await stoppedWave();
    writeFileSync(join(parent, 'b/cadence.yaml'), 'orchestrate:\n  precheck: false\n# modifié\n');
    const second = deps(() => {});
    const r = io(parent);
    expect(await orchestrate(['--resume', '--drop', 'b:L1'], r.io, second.d)).toBe(1);
    expect(r.err.join('\n')).not.toMatch(/arbre sale/);
    expect(second.calls.length).toBeGreaterThan(0);
    expect(second.calls.every((c) => c.cwd.endsWith('/a'))).toBe(true);
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('b', 'L1')!.status).toBe('handed-back');
    expect(store.readLot('b', 'L1')!.outcome).toMatch(/retiré de la vague/);
    expect(store.readWave()!.status).toBe('done');
  });

  it('--resume --drop b:L1 refusé à cause d\'un AUTRE lot (arbre sale de a) : rien n\'est écrit dans control.log, b:L1 reste suspendu', async () => {
    const { parent, store } = await stoppedWave();
    writeFileSync(join(parent, 'a/cadence.yaml'), 'orchestrate:\n  precheck: false\n# modifié\n');
    const second = deps(() => {});
    const r = io(parent);
    expect(await orchestrate(['--resume', '--drop', 'b:L1'], r.io, second.d)).toBe(2);
    expect(r.err.join('\n')).toMatch(/a : arbre sale/);
    expect(second.calls).toEqual([]);
    expect(store.control().drops).toEqual([]);
    expect(store.readLot('b', 'L1')!.status).toBe('suspended');
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

  it('un lot qui dépend (after) d\'un lot en question retiré est rendu aussi, la vague finit « done »', async () => {
    const parent = parentWith(['a', 'b']);
    const planFile = join(parent, 'a/docs/plan/raf.yaml');
    const plan = Plan.load(planFile);
    plan.add('suite', '2026-10-01', { estimate: 1, after: ['L1'] });
    plan.save();
    git(join(parent, 'a'), 'add', '--', 'docs/plan/raf.yaml');
    git(join(parent, 'a'), 'commit', '-q', '-m', 'chore: plan L2');
    let store: RunStore | undefined;
    const claude: ClaudeFn = async (args, o) => {
      const kind = kindOf(args);
      if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
      if (o.cwd.endsWith('/a')) return claudeOut(workReport({ questions: ['Quelle base ?'] }));
      store = RunStore.last(parent)!;
      for (let i = 0; i < 200 && store.readLot('a', 'L1')?.status !== 'question'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(await orchestrate(['--drop', 'a:L1'], io(parent).io, d)).toBe(0);
      return claudeOut(workReport({ commits: [commitFile(o.cwd, 'b.txt', 'feat(L1): b')] }));
    };
    const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    expect(await orchestrate(['a:L1', 'a:L2', 'b:L1', '--max-sessions', '2'], io(parent).io, d)).toBe(1);
    expect(store!.readLot('a', 'L1')!.status).toBe('handed-back');
    expect(store!.readLot('a', 'L2')!.status).toBe('handed-back');
    expect(store!.readLot('a', 'L2')!.outcome).toMatch(/dépendance non prête dans la vague : L1/);
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

describe('--continue et --stop-after-current (L79, revue)', () => {
  it('l\'arrêt demandé pendant la dernière session : aucune manche tirée, la cause dit « arrêt demandé »', async () => {
    const parent = parentWith(['a'], 3);
    let asked = false;
    const { d, calls } = deps(async (kind) => {
      if (kind.startsWith('review') && !asked) {
        asked = true;
        expect(await orchestrate(['--stop-after-current'], io(parent).io, d)).toBe(0);
      }
    });
    const r = io(parent);
    await orchestrate(['a:L1', '--continue', '--max-sessions', '1'], r.io, d);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(calls.filter((c) => c.kind === 'implement')).toHaveLength(1);
    const text = r.out.join('\n');
    expect(text).not.toMatch(/continue : tire/);
    expect(text).toMatch(/continue : arrêt — arrêt demandé \(--stop-after-current\)/);
    expect(text).not.toMatch(/vague interrompue \(incident ou signal\)/);
    expect(store.readWave()!.lots).toEqual(['a:L1']);
  });
});

describe('refus de --drop / --stop-after-current (L79, revue)', () => {
  const control = ['--drop', 'a:L1'];

  it.each([
    ['des lots à lancer', ['b:L1']],
    ['--continue', ['--continue']],
    ['--dry-run', ['--dry-run']],
    ['--budget', ['--budget', '1M']],
    ['--answer', ['--answer', 'a:L1', 'oui']],
  ])('ne se combine pas avec %s (RafError, donc code 2 au CLI)', async (_name, extra) => {
    const parent = parentWith(['a', 'b']);
    const { d, calls } = deps(() => {});
    for (const flags of [control, ['--stop-after-current']]) {
      await expect(orchestrate([...flags, ...extra], io(parent).io, d)).rejects.toThrow(/ne se combinent pas avec des lots à lancer, --continue, --dry-run, --budget ou --answer/);
    }
    expect(calls).toEqual([]);
  });

  it('plusieurs vagues tournent depuis ce dossier : précisez --wave (code 2) ; --wave en désigne une', async () => {
    const parent = parentWith(['a']);
    const saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = tempDir();
    try {
      // process.ppid : un second processus vivant, pour une seconde vague inscrite au registre
      registerWave(process.env.CADENCE_HOME, { pid: process.pid, wave: 'w1', started: '2026-10-04T10:00:00Z', cwd: parent, repos: [] });
      registerWave(process.env.CADENCE_HOME, { pid: process.ppid, wave: 'w2', started: '2026-10-04T10:01:00Z', cwd: parent, repos: [] });
      const { d } = deps(() => {});
      const r = io(parent);
      expect(await orchestrate(['--drop', 'a:L1'], r.io, d)).toBe(2);
      expect(r.err.join('\n')).toMatch(/plusieurs vagues tournent depuis ce dossier \(w1, w2\) : précisez --wave/);
      const one = io(parent);
      expect(await orchestrate(['--stop-after-current', '--wave', 'w9'], one.io, d)).toBe(2);
      expect(one.err.join('\n')).toMatch(/aucune vague en cours \(w9\)/);
    } finally {
      process.env.CADENCE_HOME = saved;
    }
  });

  /** Une vague vivante à deux projets : a:L1 est prêt quand `request` tourne (dans la session de b). Les constats se font après la vague : une assertion levée dans une session ferait échouer le lot en silence. */
  async function withLiveWave(flags: string[]) {
    const parent = parentWith(['a', 'b']);
    let seen: { code: number; err: string; drops: string[] } | undefined;
    const { d } = deps(async (kind, cwd) => {
      if (kind !== 'implement' || !cwd.endsWith('/b')) return;
      const store = RunStore.last(parent)!;
      for (let i = 0; i < 300 && store.readLot('a', 'L1')?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
      const r = io(parent);
      const code = await orchestrate(flags, r.io, d);
      seen = { code, err: r.err.join('\n'), drops: store.control().drops };
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, d);
    expect(RunStore.last(parent)!.readLot('b', 'L1')!.status).toBe('ready'); // la vague est allée à son terme
    return seen!;
  }

  it('--drop L1 sans projet alors que deux projets portent L1 : refusé (code 2), rien d\'écrit', async () => {
    const seen = await withLiveWave(['--drop', 'L1']);
    expect(seen.code).toBe(2);
    expect(seen.err).toMatch(/--drop L1 : plusieurs projets portent ce lot, précisez projet:lot/);
    expect(seen.drops).toEqual([]);
  });

  it('--drop d\'un lot déjà fini : refusé (code 2) avec son état', async () => {
    const seen = await withLiveWave(['--drop', 'a:L1']);
    expect(seen.code).toBe(2);
    expect(seen.err).toMatch(/--drop a:L1 : le lot est déjà fini \(ready\)/);
    expect(seen.drops).toEqual([]);
  });

  it('--drop L1 sans projet est accepté quand un seul projet porte ce lot', async () => {
    const parent = parentWith(['a']);
    let seen: { code: number; out: string } | undefined;
    const { d } = deps(async (kind) => {
      if (kind !== 'implement' || seen) return;
      const r = io(parent);
      seen = { code: await orchestrate(['--drop', 'L1'], r.io, d), out: r.out.join('\n') };
    });
    await orchestrate(['a:L1'], io(parent).io, d);
    expect(seen!.code).toBe(0);
    expect(seen!.out).toMatch(/a:L1 : retrait demandé/);
  });
});

describe('vague d\'avant L79 (L79, revue)', () => {
  it('la demande est écrite, mais on avertit que la vague ne lit pas les demandes de contrôle', async () => {
    const parent = parentWith(['a']);
    let seen: { code: number; err: string; drops: string[] } | undefined;
    const { d } = deps(async (kind) => {
      if (kind !== 'implement') return;
      const store = RunStore.last(parent)!;
      // l'instantané de cette vague : un dist/ sans control.log, comme avant L79
      mkdirSync(join(store.dir, 'tool', 'bin'), { recursive: true });
      mkdirSync(join(store.dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
      writeFileSync(join(store.dir, 'tool', 'bin', 'cadence.js'), '');
      writeFileSync(join(store.dir, 'tool', 'dist', 'orchestrate', 'state.js'), '// avant L79\n');
      const r = io(parent);
      const code = await orchestrate(['--drop', 'a:L1'], r.io, d);
      seen = { code, err: r.err.join('\n'), drops: store.control().drops };
    });
    await orchestrate(['a:L1'], io(parent).io, d);
    expect(seen!.code).toBe(0);
    expect(seen!.drops).toEqual(['a:L1']);
    expect(seen!.err).toMatch(/la vague .* ne lit pas les demandes de contrôle/);
  });

  it('un instantané qui connaît control.log, ou pas d\'instantané : pas d\'avertissement', async () => {
    const dir = tempDir();
    expect(waveReadsControl(dir)).toBe(true);
    mkdirSync(join(dir, 'tool', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
    writeFileSync(join(dir, 'tool', 'bin', 'cadence.js'), '');
    writeFileSync(join(dir, 'tool', 'dist', 'orchestrate', 'state.js'), "join(this.dir, 'control.log')\n");
    expect(waveReadsControl(dir)).toBe(true);
  });
});
