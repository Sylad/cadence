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

function parentWith(names: string[]) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    plan.add('lot', '2026-10-01', { estimate: 1 });
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
