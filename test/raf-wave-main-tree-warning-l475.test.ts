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

// L475 — raf add / note / done avertissent quand une session de vague tient l'arbre principal du dépôt : un commit de plan du lead pendant une revue rend le lot (cas du 30-10, cadence L458).

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

const WARN = /vague w9 .*travaille dans l'arbre principal.*demo:L1/s;
const WRITES: string[][] = [['add', 'deux'], ['note', 'L1', 'x'], ['done', 'L1', '--force']];

describe('raf add / note / done pendant qu\'une session de vague tient l\'arbre principal (L475)', () => {
  it('R1 — lot en implémentation sans worktree : add, note et done avertissent sur stderr et écrivent', () => {
    for (const argv of WRITES) {
      const dir = vague('implementing');
      const r = raf(dir, {}, ...argv);
      expect(r.code, argv[0]).toBe(0);
      expect(r.err, argv[0]).toMatch(WARN);
      expect(r.err, argv[0]).toContain('rendrait');
    }
  });
  it('R1 — l\'avertissement n\'empêche pas l\'écriture', () => {
    const dir = vague('implementing');
    expect(raf(dir, {}, 'note', 'L1', 'bonjour').err).toMatch(WARN);
    expect(raf(dir, {}, 'show', 'L1').out).toContain('bonjour');
  });
  it('R2 — revue et correction dans l\'arbre principal : avertissement (le cas du 30-10 est une revue)', () => {
    for (const status of ['reviewing', 'fixing'] as const) expect(raf(vague(status), {}, 'note', 'L1', 'x').err).toMatch(WARN);
  });
  it('R3 — lot en file, en question, prêt ou rendu : aucune session n\'écrit dans l\'arbre, aucun avertissement', () => {
    for (const status of ['queued', 'question', 'ready', 'handed-back', 'failed', 'suspended'] as const) expect(raf(vague(status), {}, 'note', 'L1', 'x').err, status).not.toMatch(/arbre principal/);
  });
  it('R4 — lot qui joue dans son worktree : aucun avertissement', () => {
    for (const status of ['implementing', 'reviewing', 'fixing'] as const) expect(raf(vague(status, { worktree: true }), {}, 'note', 'L1', 'x').err, status).not.toMatch(/arbre principal/);
  });
  it('R5 — verrou d\'un porteur mort : aucun avertissement', () => {
    expect(raf(vague('implementing', { alive: false }), {}, 'note', 'L1', 'x').err).not.toMatch(/arbre principal/);
  });
  it('R6 — sans vague dans le dépôt : aucun avertissement', () => {
    const dir = gitRepo();
    raf(dir, {}, 'init', '--project', 'demo', '--no-hook');
    raf(dir, {}, 'add', 'un');
    expect(raf(dir, {}, 'note', 'L1', 'x').err).toBe('');
  });
  it('R7 — depuis un worktree du dépôt : aucun avertissement, seul l\'arbre principal est tenu', () => {
    const dir = vague('implementing');
    const tree = join(tempDir(), 'wt');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'lot', tree], { stdio: 'ignore' });
    try {
      expect(raf(tree, {}, 'note', 'L1', 'x').err).not.toMatch(/arbre principal/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
  it('R8 — depuis une session de la vague (CADENCE_ORCHESTRATED) : aucun avertissement, c\'est elle qui tient l\'arbre', () => {
    expect(raf(vague('implementing'), { CADENCE_ORCHESTRATED: 'w9' }, 'note', 'L1', 'x').err).not.toMatch(/arbre principal/);
  });
  it('R9 — état de la vague illisible : aucun avertissement et aucune erreur', () => {
    const dir = vague('implementing');
    const r = raf(dir, {}, 'note', 'L1', 'x');
    expect(r.code).toBe(0);
    rmSync(join(process.env.CADENCE_HOME!, 'waves'), { recursive: true, force: true });
    const r2 = raf(dir, {}, 'note', 'L1', 'y');
    expect(r2.code).toBe(0);
    expect(r2.err).not.toMatch(/arbre principal/);
  });
});
