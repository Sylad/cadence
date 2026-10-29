import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedStateDir } from '../src/state.js';
import { Mutex } from '../src/orchestrate/mutex.js';
import { advance, INTEGRATION_LOCK, mergeBase, patchId, rebaseOnto, repoBranch, takeRepoWrite } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L279 — intégration d'un lot à la branche du dépôt : file et verrou (R10, R25), rebase (R6), patch-id (R9), avance (R8, R24).
function repoWith(files: Record<string, string>) {
  const repo = gitRepo();
  for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, f), text);
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
function tree(repo: string, lot = 'L1') {
  const store = new RunStore(tempDir(), 'w1');
  const t = { repo, dir: lotTreeDir(store.dir, 'p', lot), branch: lotBranch('w1', 'p', lot), base: 'main', lot: `p:${lot}` };
  expect(prepareTree(t).ok).toBe(true);
  return t;
}
const write = (dir: string, file: string, text: string, msg: string) => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', msg);
};
const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';

describe('R10 — file en mémoire', () => {
  it('R10 — deux lots du même processus demandent le verrou ensemble : l\'un attend l\'autre en mémoire, aucun n\'est pris pour le porteur', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.acquire().then(async (release) => {
      order.push('a entre');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a sort');
      release!();
    });
    const b = m.acquire().then((release) => {
      order.push('b entre');
      release!();
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a entre', 'a sort', 'b entre']);
  });
  it('R10 — un demandeur qui renonce au délai laisse passer le suivant', async () => {
    const m = new Mutex();
    const first = (await m.acquire())!;
    const gaveUp = await m.acquire(20);
    expect(gaveUp).toBeNull();
    const next = m.acquire();
    first();
    expect(await next).toBeTypeOf('function');
  });
});

describe('R10 / R25 — verrou d\'intégration du dépôt', () => {
  it('R10 — deux lots prêts en même temps : intégrés l\'un après l\'autre', async () => {
    const repo = repoWith({ a: 'a\n' });
    const order: string[] = [];
    const run = async (name: string) => {
      const g = await takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 5_000, pollMs: 10 });
      expect(g.ok).toBe(true);
      if (!g.ok) return;
      order.push(`${name} entre`);
      expect(existsSync(join(sharedStateDir(repo), INTEGRATION_LOCK))).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name} sort`);
      g.release();
    };
    await Promise.all([run('x'), run('y')]);
    expect(order).toEqual(['x entre', 'x sort', 'y entre', 'y sort']);
    expect(existsSync(join(sharedStateDir(repo), INTEGRATION_LOCK))).toBe(false);
  });
  it('L425 — un lot attend derrière un autre lot de la même vague plus longtemps que la borne : il passe à son tour, il n\'est pas rendu', async () => {
    const repo = repoWith({ a: 'a\n' });
    const first = await takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 100, pollMs: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 100, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 350)); // 3,5 fois la borne : le porteur est un lot de ce processus, il libérera
    first.release();
    const g = await second;
    expect(g.ok).toBe(true);
    if (g.ok) g.release();
  });
  it('R10 — verrou d\'intégration d\'un pid mort : retiré, l\'intégration passe', async () => {
    const repo = repoWith({ a: 'a\n' });
    writeFileSync(join(sharedStateDir(repo), INTEGRATION_LOCK), JSON.stringify({ pid: 2 ** 22 + 12345, wave: 'morte', started: '2026-10-01T00:00:00Z' }));
    const g = await takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 1_000, pollMs: 10 });
    expect(g.ok).toBe(true);
    if (g.ok) g.release();
  });
  it('R25 — verrou tenu plus que la borne : refus avec le porteur (vague, pid), le verrou de l\'autre n\'est pas touché', async () => {
    const repo = repoWith({ a: 'a\n' });
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
      writeFileSync(file, JSON.stringify({ pid: sleeper.pid, wave: 'autre', started: '2026-10-24T00:00:00Z' }));
      const t0 = Date.now();
      const g = await takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 150, pollMs: 20 });
      expect(g.ok).toBe(false);
      expect(g.ok === false && g.holder).toMatchObject({ wave: 'autre', pid: sleeper.pid });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
      expect(JSON.parse(readFileSync(file, 'utf8')).wave).toBe('autre');
    } finally {
      sleeper.kill();
    }
  });
  it('R25 — verrou libéré avant la borne : le lot s\'intègre', async () => {
    const repo = repoWith({ a: 'a\n' });
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
      writeFileSync(file, JSON.stringify({ pid: sleeper.pid, wave: 'autre', started: '2026-10-24T00:00:00Z' }));
      setTimeout(() => sleeper.kill(), 60); // le porteur meurt : son verrou est périmé
      const g = await takeRepoWrite(repo, { wave: 'w1' }, { waitMs: 5_000, pollMs: 20 });
      expect(g.ok).toBe(true);
      if (g.ok) g.release();
    } finally {
      sleeper.kill();
    }
  });
});

describe('R6 — rebase d\'intégration', () => {
  it('R6 — sommet inchangé depuis le départ : rien à rebaser (fast-forward pur)', () => {
    const repo = repoWith({ a: 'a\n' });
    const t = tree(repo);
    write(t.dir, 'x', 'x\n', 'feat(L1): x');
    expect(rebaseOnto(t.dir, 'main')).toEqual({ kind: 'forwarded' });
  });
  it('R6 — sommet déplacé sans conflit : rebasé, shas avant et après', () => {
    const repo = repoWith({ a: 'a\n' });
    const t = tree(repo);
    write(t.dir, 'x', 'x\n', 'feat(L1): x');
    const before = git(t.dir, 'rev-parse', 'HEAD');
    write(repo, 'y', 'y\n', 'autre');
    const r = rebaseOnto(t.dir, 'main');
    expect(r.kind).toBe('rebased');
    expect(r.kind === 'rebased' && r.before).toBe(before);
    expect(git(t.dir, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(git(t.dir, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
  });
  it('R6 — deux lots modifient la même ligne : conflit, fichiers listés, rebase abandonné, branche du dépôt et worktree intacts', () => {
    const repo = repoWith({ 'f.txt': lines(5) });
    const t = tree(repo);
    write(t.dir, 'f.txt', lines(5).replace('l2', 'l2 du lot'), 'feat(L1): lot');
    const tip = git(t.dir, 'rev-parse', 'HEAD');
    write(repo, 'f.txt', lines(5).replace('l2', 'l2 de main'), 'autre lot');
    const main = git(repo, 'rev-parse', 'main');
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'conflict', files: ['f.txt'] });
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    expect(git(t.dir, 'rev-parse', 'HEAD')).toBe(tip);
    // aucun rebase en cours dans le worktree
    const gitDir = git(t.dir, 'rev-parse', '--git-dir');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('R9 — patch-id stable', () => {
  it('R9 — même diff, contexte déplacé : même patch-id avant et après le rebase', () => {
    const repo = repoWith({ 'f.txt': lines(30) });
    const t = tree(repo);
    write(t.dir, 'f.txt', lines(30).replace('l20\n', 'l20 modifiée\n'), 'feat(L1): modif');
    const old = git(t.dir, 'rev-parse', 'HEAD');
    const before = patchId(t.dir, mergeBase(t.dir, old, 'main'), old);
    write(repo, 'f.txt', 'en tête 1\nen tête 2\n' + lines(30), 'autre : lignes ajoutées en tête');
    expect(rebaseOnto(t.dir, 'main').kind).toBe('rebased');
    const after = patchId(t.dir, 'main', 'HEAD');
    expect(before).not.toBe('');
    expect(after).toBe(before);
  });
  it('R9 — diff différent : patch-id différent', () => {
    const repo = repoWith({ 'f.txt': lines(10) });
    const t = tree(repo);
    write(t.dir, 'f.txt', lines(10).replace('l5\n', 'l5 a\n'), 'feat(L1): a');
    const a = patchId(t.dir, 'main', 'HEAD');
    write(t.dir, 'f.txt', lines(10).replace('l5\n', 'l5 b\n'), 'feat(L1): b');
    expect(patchId(t.dir, 'main', 'HEAD')).not.toBe(a);
  });
  it('R23 — le patch-id ignore le plan : deux plans différents sur la branche du dépôt, même patch-id', () => {
    const repo = repoWith({ 'f.txt': lines(10), 'plan.yaml': 'lots: []\n' });
    const t = tree(repo);
    write(t.dir, 'f.txt', lines(10).replace('l5\n', 'l5 x\n'), 'feat(L1): x');
    const old = git(t.dir, 'rev-parse', 'HEAD');
    const before = patchId(t.dir, mergeBase(t.dir, old, 'main'), old);
    write(repo, 'plan.yaml', 'lots: [un, deux]\n', 'plan: L1 démarré');
    write(repo, 'plan.yaml', 'lots: [un, deux, trois]\n', 'plan: L2 démarré');
    expect(rebaseOnto(t.dir, 'main').kind).toBe('rebased');
    expect(patchId(t.dir, 'main', 'HEAD')).toBe(before);
  });
});

describe('R8 / R24 — avance de la branche du dépôt', () => {
  it('R8 — arbre propre : branche avancée en fast-forward', () => {
    const repo = repoWith({ a: 'a\n' });
    const t = tree(repo);
    write(t.dir, 'x', 'x\n', 'feat(L1): x');
    advance(repo, t.branch);
    expect(git(repo, 'rev-parse', 'main')).toBe(git(t.dir, 'rev-parse', 'HEAD'));
    expect(existsSync(join(repo, 'x'))).toBe(true);
  });
  it('R24 — repoBranch : la branche courante, null en HEAD détaché', () => {
    const repo = repoWith({ a: 'a\n' });
    expect(repoBranch(repo)).toBe('main');
    git(repo, 'checkout', '-q', '--detach');
    expect(repoBranch(repo)).toBeNull();
  });
});
