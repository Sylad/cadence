import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { sharedStateDir } from '../src/state.js';
import { gitRepo, tempDir } from './helpers.js';

// L521 — raf done pendant qu'une session de vague tient l'arbre principal : l'écriture du plan est différée (refus), sinon le lot suivant est rendu « dépôt sale après implement » (01-11, avatar L57 après L56).

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function raf(dir: string, env: Record<string, string> = {}, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-31', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-31T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt avec un plan (L1 en cours) et une vague vivante qui tient son verrou ; `worktree` : le lot joue dans son worktree (dossier présent). */
function vague(status: LotState['status'], opts: { worktree?: boolean; alive?: boolean } = {}) {
  const dir = gitRepo();
  raf(dir, {}, 'init', '--project', 'demo', '--no-hook');
  raf(dir, {}, 'add', 'un');
  raf(dir, {}, 'start', 'L1');
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'plan'], { stdio: 'ignore' });
  const launch = tempDir();
  const store = RunStore.reserve(launch, 'w9')!;
  store.writeWave({ id: 'w9', status: 'running', created: 'x', lots: ['demo:L1'] } as never);
  store.writeLot({ ...newLot({ project: 'demo', repo: dir, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  if (opts.worktree) mkdirSync(lotTreeDir(store.dir, 'demo', 'L1', dir), { recursive: true });
  mkdirSync(sharedStateDir(dir), { recursive: true });
  const pid = opts.alive === false ? 2 ** 22 + 12345 : process.pid;
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid, wave: 'w9', started: 'x' }));
  registerWave(process.env.CADENCE_HOME!, { pid: process.pid, wave: 'w9', started: 'x', cwd: launch, repos: [dir] });
  return dir;
}

const REFUSED = /vague w9 .*travaille dans l'arbre principal.*demo:L1/s;
const planStatus = (dir: string) => raf(dir, {}, 'show', 'L1').out;

describe('raf done pendant qu\'une session de vague tient l\'arbre principal (L521)', () => {
  it('R1 — lot en implémentation sans worktree : done est refusé (code 2, erreur nommée), le plan n\'est pas écrit, le message dit l\'ordre sûr', () => {
    const dir = vague('implementing');
    const before = planStatus(dir);
    const r = raf(dir, {}, 'done', 'L1', '--force');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(REFUSED);
    expect(r.err).toContain('--now');
    expect(r.err).toContain('fin de leur étape');
    expect(planStatus(dir)).toBe(before);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  });
  it('R2 — revue et correction dans l\'arbre principal : refus aussi', () => {
    for (const status of ['reviewing', 'fixing'] as const) expect(raf(vague(status), {}, 'done', 'L1', '--force').code, status).toBe(2);
  });
  it('R3 — --now écrit quand même, en avertissant (le lot de la session sera rendu)', () => {
    const dir = vague('implementing');
    const r = raf(dir, {}, 'done', 'L1', '--force', '--now');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/arbre principal/);
    expect(planStatus(dir)).toContain('done');
  });
  it('R4 — sous-tâche : refusée de même (elle écrit le plan)', () => {
    const dir = vague('implementing');
    const r = raf(dir, {}, 'done', 'L1/1');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(REFUSED);
  });
  it('R5 — worktree, lot prêt, verrou mort : done écrit sans refus', () => {
    const cases: Array<[string, () => string, Record<string, string>]> = [
      ['worktree', () => vague('implementing', { worktree: true }), {}],
      ['prêt', () => vague('ready'), {}],
      ['verrou mort', () => vague('implementing', { alive: false }), {}],
    ];
    for (const [name, make, env] of cases) {
      const r = raf(make(), env, 'done', 'L1', '--force');
      expect(r.code, name).toBe(0);
      expect(r.err, name).not.toMatch(/arbre principal/);
    }
  });
  it('R6 — état de la vague illisible : done écrit (on ne refuse que sur une vague lue)', () => {
    const dir = vague('implementing');
    rmSync(join(process.env.CADENCE_HOME!, 'waves'), { recursive: true, force: true });
    expect(raf(dir, {}, 'done', 'L1', '--force').code).toBe(0);
  });
  it('R7 — start, drop, note et add ne sont pas refusés (seul done est différé)', () => {
    for (const argv of [['note', 'L1', 'x'], ['add', 'deux'], ['drop', 'L1']]) expect(raf(vague('implementing'), {}, ...argv).code, argv[0]).toBe(0);
  });
});
