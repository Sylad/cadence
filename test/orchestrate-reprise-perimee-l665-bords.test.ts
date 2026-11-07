import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchStaleness, lotBranch, lotTreeDir, prepareTree, recoverTree, recoveryRefusal } from '../src/orchestrate/worktree.js';
import { commitFile, git } from './orchestrate-harness.js';
import { fake, run, setup } from './orchestrate-worktree-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// L665 — bords de la reprise périmée : plusieurs conflits, noms de fichiers inhabituels, conflit modify/delete, --dry-run.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function oldBranch(repo: string, files: Record<string, string>): { branch: string; dir: string } {
  const dir = lotTreeDir(join(repo, '..', '.cadence-w1'), 'a', 'L1');
  const branch = lotBranch('w1', 'a', 'L1');
  const made = prepareTree({ repo, dir, branch, base: 'main', lot: 'a:L1' });
  if (!made.ok) throw new Error(made.cause);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
    git(dir, 'add', '--', f);
  }
  git(dir, 'commit', '-q', '-m', 'feat(L1): travail');
  return { branch, dir };
}
function mainWrites(repo: string, files: Record<string, string>): void {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body);
    git(repo, 'add', '--', f);
  }
  git(repo, 'commit', '-q', '-m', 'feat: main');
}
const newDir = (parent: string) => lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'a', 'L1');

describe('R3 — les conflits au bord', () => {
  it('R3 — plusieurs fichiers en conflit : tous nommés, sans doublon', () => {
    const { repo } = setup();
    const old = oldBranch(repo, { 'a.txt': 'lot\n', 'dir/b.txt': 'lot\n' });
    mainWrites(repo, { 'a.txt': 'main\n', 'dir/b.txt': 'main\n' });
    const got = branchStaleness(repo, old.branch, 'main');
    expect(got.behind).toBe(1);
    expect([...got.conflicts].sort()).toEqual(['a.txt', 'dir/b.txt']);
  });
  it('R3 — nom de fichier avec espace en conflit : le nom est rendu tel quel', () => {
    const { repo } = setup();
    const old = oldBranch(repo, { 'mon fichier.txt': 'lot\n' });
    mainWrites(repo, { 'mon fichier.txt': 'main\n' });
    expect(branchStaleness(repo, old.branch, 'main').conflicts).toEqual(['mon fichier.txt']);
  });
  it('R3 — nom de fichier accentué en conflit : le nom n\'est pas échappé en octal', () => {
    const { repo } = setup();
    const old = oldBranch(repo, { 'été.txt': 'lot\n' });
    mainWrites(repo, { 'été.txt': 'main\n' });
    expect(branchStaleness(repo, old.branch, 'main').conflicts).toEqual(['été.txt']);
  });
  it('R3 — fichier accentué du plan touché par la branche : le refus le nomme tel quel', () => {
    const { repo } = setup();
    const old = oldBranch(repo, { 'plan-é.md': 'lot\n' });
    const found = { branch: old.branch, dir: null } as Parameters<typeof recoveryRefusal>[1];
    expect(recoveryRefusal(repo, found, 'main', new Set(['plan-é.md']))).toBe('un de ses commits modifie le plan (plan-é.md)');
  });
  it('R3 — conflit modify/delete (main supprime ce que le lot modifie) : refusé', () => {
    const { repo, parent } = setup();
    commitFile(repo, 'cible.txt', 'chore: cible');
    const old = oldBranch(repo, { 'cible.txt': 'modifié par le lot\n' });
    git(repo, 'rm', '-q', 'cible.txt');
    git(repo, 'commit', '-q', '-m', 'chore: supprime');
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main');
    expect(got).toEqual({ from: old.branch, refused: expect.stringMatching(/cible\.txt.*périmée/) });
  });
  it('R3 — branche inconnue : ni retard ni conflit, sans lever', () => {
    const { repo } = setup();
    expect(branchStaleness(repo, 'cadence/absente/a--L9', 'main')).toEqual({ behind: 0, conflicts: [] });
  });
  it('R3 — branche déjà fusionnée dans main : 0 retard, 0 conflit', () => {
    const { repo } = setup();
    const old = oldBranch(repo, { 'x.txt': 'lot\n' });
    git(repo, 'merge', '-q', '--no-edit', old.branch);
    expect(branchStaleness(repo, old.branch, 'main')).toEqual({ behind: 0, conflicts: [] });
  });
  it('R2 — refus par le rebase raté : la branche et son worktree restent, aucun worktree n\'apparaît au nouvel emplacement', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, { 'x.txt': 'lot\n' });
    commitFile(repo, 'x.txt', 'chore: x');
    for (let i = 0; i < 101; i++) commitFile(repo, `m-${i}.txt`, `chore: ${i}`);
    expect(recoverTree(repo, lotBranch('w2', 'a', 'L1'), newDir(parent), 'main')).toHaveProperty('refused');
    expect(existsSync(old.dir)).toBe(true);
    expect(existsSync(newDir(parent))).toBe(false);
  });
});

describe('R4 — le --dry-run applique le même refus', () => {
  it('R4 — branche en conflit : le dry-run dit qu\'elle n\'est pas reprise et nomme le fichier', async () => {
    const { parent, repo } = setup();
    const old = oldBranch(repo, { 'partage.txt': 'lot\n' });
    mainWrites(repo, { 'partage.txt': 'main\n' });
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toMatch(new RegExp(`branche ${old.branch.replace(/\//g, '\\/')} .*n'est pas reprise, main a 1 commit\\(s\\) d'avance et 1 conflit\\(s\\) \\(partage\\.txt\\)`));
  });
  it('R4 — branche à plus de 100 commits : le dry-run dit qu\'elle n\'est pas reprise telle quelle et les deux issues du rebase', async () => {
    const { parent, repo } = setup();
    const old = oldBranch(repo, { 'x.txt': 'lot\n' });
    for (let i = 0; i < 101; i++) commitFile(repo, `m-${i}.txt`, `chore: ${i}`);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toMatch(new RegExp(`branche ${old.branch.replace(/\//g, '\\/')} .*n'est pas reprise, main a 101 commit\\(s\\).*tente d'abord un rebase sur main : réussi, le lot repart de son travail, échoué, le lot est rendu sans session`));
  });
});
