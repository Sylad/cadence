import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchStaleness, lotBranch, lotTreeDir, prepareTree, recoverTree } from '../src/orchestrate/worktree.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, WAVE } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L665 — reprise d'une branche périmée : refus au lancement, âge et conflits dans la ligne « branche reprise ».
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Une branche de lot d'une vague passée, avec un commit qui écrit `file` (contenu `body`). */
function oldBranch(repo: string, file = 'w1-L1.txt', body = 'travail\n'): { branch: string; dir: string } {
  const dir = lotTreeDir(join(repo, '..', '.cadence-w1'), 'a', 'L1');
  const branch = lotBranch('w1', 'a', 'L1');
  const made = prepareTree({ repo, dir, branch, base: 'main', lot: 'a:L1' });
  if (!made.ok) throw new Error(made.cause);
  writeFileSync(join(dir, file), body);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', 'feat(L1): travail', '--', file);
  return { branch, dir };
}

/** `n` commits de plus sur main, chacun sur un fichier à part. */
function advanceMain(repo: string, n: number): void {
  for (let i = 0; i < n; i++) commitFile(repo, `main-${i}.txt`, `chore: main ${i}`);
}

const newDir = (parent: string) => lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'a', 'L1');

describe('R1 — l\'âge de la branche : les commits de main qu\'elle n\'a pas', () => {
  it('R1 — branchStaleness compte les commits de main absents de la branche, sans conflit quand les fichiers diffèrent', () => {
    const { repo } = setup();
    const old = oldBranch(repo);
    advanceMain(repo, 3);
    expect(branchStaleness(repo, old.branch, 'main')).toEqual({ behind: 3, conflicts: [] });
  });
  it('R1 — branche à jour sur main : 0 commit de retard, 0 conflit', () => {
    const { repo } = setup();
    const old = oldBranch(repo);
    expect(branchStaleness(repo, old.branch, 'main')).toEqual({ behind: 0, conflicts: [] });
  });
});

describe('R2 — plus de 100 commits de main d\'avance : la reprise rebase d\'abord (L676)', () => {
  it('R2 — 101 commits de main d\'avance sans conflit : le rebase réussit, la branche est reprise sur le sommet de main, ses commits gardés', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo);
    advanceMain(repo, 101);
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main');
    expect(got).toEqual({ from: old.branch, unintegrated: 1, behind: 0, conflicts: [] });
    expect(git(repo, 'rev-list', '--count', 'main..cadence/w2/a--L1')).toBe('1');
    expect(git(repo, 'rev-list', '--count', 'cadence/w2/a--L1..main')).toBe('0');
    expect(existsSync(newDir(parent))).toBe(true);
  });
  it('R2 — le rebase échoue (même fichier écrit des deux côtés, plus de 100 commits de retard) : refusée, la branche garde son sommet, sans rebase en cours', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'partage.txt', 'version du lot\n');
    const tip = git(repo, 'rev-parse', old.branch);
    commitFile(repo, 'partage.txt', 'feat: partage');
    advanceMain(repo, 100);
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main');
    expect(got).toEqual({ from: old.branch, refused: expect.stringMatching(/plus de 100.*le rebase sur main a échoué \(conflit sur partage\.txt\).*branche laissée intacte/) });
    expect(git(repo, 'rev-parse', old.branch)).toBe(tip);
    expect(existsSync(old.dir)).toBe(true);
    expect(git(old.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(join(old.dir, '.git')) && git(old.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(old.branch);
    expect(existsSync(newDir(parent))).toBe(false);
  });
  it('R2 — worktree disparu : le rebase se fait dans un worktree jetable, retiré ensuite', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo);
    advanceMain(repo, 101);
    git(repo, 'worktree', 'remove', '--force', old.dir);
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main');
    expect(got).toEqual({ from: old.branch, unintegrated: 1, behind: 0, conflicts: [] });
    expect(git(repo, 'worktree', 'list')).not.toContain('cadence-rebase-');
  });
  it('R2 — 100 commits de main d\'avance (la borne) : reprise, l\'âge est rendu', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo);
    advanceMain(repo, 100);
    expect(recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main')).toEqual({ from: old.branch, unintegrated: 1, behind: 100, conflicts: [] });
  });
});

describe('R3 — merge-tree donne des conflits : le rebase échoue, la reprise est refusée et nomme les fichiers', () => {
  it('R3 — main a réécrit le fichier que le lot a écrit : refusée, le fichier en conflit est dans la cause, branche intacte', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'partage.txt', 'version du lot\n');
    writeFileSync(join(repo, 'partage.txt'), 'version de main\n');
    git(repo, 'add', '--', 'partage.txt');
    git(repo, 'commit', '-q', '-m', 'feat: partage', '--', 'partage.txt');
    expect(branchStaleness(repo, old.branch, 'main')).toEqual({ behind: 1, conflicts: ['partage.txt'] });
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main');
    expect(got).toEqual({ from: old.branch, refused: expect.stringMatching(/1 conflit\(s\).*partage\.txt/) });
    expect(existsSync(old.dir)).toBe(true);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim()).toBe(old.branch);
  });
  it('R3 — main a touché un autre fichier que le lot : pas de conflit, reprise', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'partage.txt', 'version du lot\n');
    commitFile(repo, 'autre.txt', 'feat: autre');
    expect(recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main')).toEqual({ from: old.branch, unintegrated: 1, behind: 1, conflicts: [] });
  });
  it('R3 — le plan l\'emporte sur l\'âge : une branche périmée qui touche aussi le plan donne un seul refus, celui du plan', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo);
    commitFile(old.dir, '.cadence/raf.yaml', 'feat(L1): plan');
    advanceMain(repo, 101);
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main', { planFiles: new Set(['.cadence/raf.yaml']), alsoSlugs: [] });
    expect(got).toEqual({ from: old.branch, refused: expect.stringContaining('modifie le plan') });
  });
});

describe('R4 — la ligne « branche reprise » du journal dit l\'âge et les conflits', () => {
  const nonConforme = reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'f.txt', ligne: 1, texte: 'cassé' }], verdict: 'non conforme' });
  async function handedBack() {
    const { parent, repo } = setup();
    const f1 = fake({ review: async (_cwd, brief) => claudeOut(lotOf(brief) === 'L1' ? nonConforme : reviewReport()) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f1);
    return { parent, repo };
  }
  it('R4 — reprise : la ligne dit « main a N commit(s) d\'avance, 0 conflit »', async () => {
    const { parent, repo } = await handedBack();
    commitFile(repo, 'depuis.txt', 'feat: depuis');
    const r = await run(parent, ['a:L1'], fake({ fix: async (cwd) => claudeOut(workReport({ commits: [commitFile(cwd, 'L1-suite.txt', 'fix(L1): suite')] })) }));
    expect(r.out).toMatch(new RegExp(`branche cadence/${WAVE}/a--L1 d'une vague précédente reprise \\(\\d+ commit\\(s\\) non intégré\\(s\\), main a \\d+ commit\\(s\\) d'avance et 0 conflit\\(s\\)\\)`));
  });
  it('R4 — refus : la ligne « non reprise » porte la cause (conflit), le lot est rendu sans session et la branche reste', async () => {
    const { parent, repo } = await handedBack();
    const kept = git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim().split('\n')[0];
    const tip = git(repo, 'rev-parse', kept);
    writeFileSync(join(repo, 'L1-implement.txt'), 'main a écrit le même fichier\n');
    git(repo, 'add', '--', 'L1-implement.txt');
    git(repo, 'commit', '-q', '-m', 'feat: même fichier', '--', 'L1-implement.txt');
    const f = fake();
    const r = await run(parent, ['a:L1'], f);
    expect(r.out).toMatch(new RegExp(`branche ${kept.replace(/\//g, '\\/')} d'une vague précédente non reprise : main a \\d+ commit\\(s\\) d'avance et 1 conflit\\(s\\) \\(L1-implement\\.txt\\).*le rebase sur main a échoué.*lot rendu sans session, branche intacte`));
    expect(r.out).not.toContain('repart de zéro');
    expect(f.calls).toEqual([]);
    expect(git(repo, 'rev-parse', kept)).toBe(tip);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim().split('\n')).toEqual([kept]);
  });
  it('R4 — plus de 100 commits de retard sans conflit : le rebase réussit, la ligne dit la reprise et le lot repart de son travail', async () => {
    const { parent, repo } = await handedBack();
    advanceMain(repo, 101);
    const r = await run(parent, ['a:L1'], fake({ fix: async (cwd) => claudeOut(workReport({ commits: [commitFile(cwd, 'L1-suite.txt', 'fix(L1): suite')] })) }));
    expect(r.out).toMatch(/d'une vague précédente reprise \(\d+ commit\(s\) non intégré\(s\), main a 0 commit\(s\) d'avance et 0 conflit\(s\)\) : le lot repart de son travail/);
  });
});
