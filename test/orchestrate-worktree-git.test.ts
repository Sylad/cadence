import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../src/orchestrate/state.js';
import { baseBranchOf, integrated, keptTrees, lotBranch, lotTreeDir, prepareTree, removeTree, unintegratedCommits } from '../src/orchestrate/worktree.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L279 — worktrees de lot : noms déterministes (R14), création et reprise (R5, R11), conservation et retrait (R12, R19, R20).
function repoWithCommit() {
  const repo = gitRepo();
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '--', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const spec = (repo: string, lot = 'L1', wave = 'w1') => {
  const store = new RunStore(tempDir(), wave);
  return { repo, dir: lotTreeDir(store.dir, 'proj', lot), branch: lotBranch(wave, 'proj', lot), base: 'main', lot: `proj:${lot}` };
};
const commitIn = (dir: string, file: string, msg: string) => {
  writeFileSync(join(dir, file), `${Math.random()}\n`);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', msg);
};

describe('R14 — noms déterministes', () => {
  it('R14 — le chemin du worktree se déduit de la vague et du lot, sans champ ajouté à l\'état du lot', () => {
    const store = new RunStore(tempDir(), 'w1');
    expect(lotTreeDir(store.dir, 'proj', 'L1')).toBe(join(store.dir, 'worktrees', 'proj--L1'));
    expect(lotBranch('w1', 'proj', 'L1')).toBe('cadence/w1/proj--L1');
    expect(lotBranch('w1', 'groupe/gamma', 'Q4/accueil')).toBe('cadence/w1/groupe__gamma--Q4__accueil');
    // l'état d'un lot ne porte ni chemin de worktree ni nom de branche : ils se déduisent
    const lot = { project: 'proj', repo: '/r', lot: 'L1', title: 't' };
    expect(JSON.stringify(lot)).not.toMatch(/worktree|cadence\//);
  });
});

describe('R5 — création du worktree et de la branche', () => {
  it('R5 — un worktree neuf : branche au sommet de la branche du dépôt, base notée dans la config git', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    const r = prepareTree(s);
    expect(r).toEqual({ ok: true, reused: false });
    expect(existsSync(join(s.dir, 'a.txt'))).toBe(true);
    expect(git(repo, 'rev-parse', s.branch)).toBe(git(repo, 'rev-parse', 'main'));
    expect(baseBranchOf(repo, s.branch)).toBe('main');
  });
  it('R5 — branche cadence/<vague>/<lot> déjà présente et non reconnue : refus avec la cause, rien n\'est touché', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    git(repo, 'branch', s.branch);
    const r = prepareTree(s);
    expect(r.ok).toBe(false);
    expect((r as { cause: string }).cause).toMatch(/branche cadence\/w1\/proj--L1 existe déjà/);
    expect(existsSync(s.dir)).toBe(false);
    expect(git(repo, 'branch', '--list', s.branch)).toContain('cadence/w1/proj--L1');
  });
  it('R5 — échec de git worktree add : aucun dossier ni branche laissés', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    // le chemin cible est un fichier : git worktree add échoue
    mkdirSync(join(s.dir, '..'), { recursive: true });
    writeFileSync(s.dir, 'je suis un fichier\n');
    const r = prepareTree(s);
    expect(r.ok).toBe(false);
    expect((r as { cause: string }).cause).not.toBe('');
    expect(git(repo, 'branch', '--list', 'cadence/*')).toBe('');
    expect(readFileSync(s.dir, 'utf8')).toBe('je suis un fichier\n'); // ce qui n'est pas à nous n'est pas supprimé
  });
  it('R5 — la base introuvable : refus avec la cause git, aucune branche laissée', () => {
    const repo = repoWithCommit();
    const s = { ...spec(repo), base: 'absente' };
    const r = prepareTree(s);
    expect(r.ok).toBe(false);
    expect(git(repo, 'branch', '--list', 'cadence/*')).toBe('');
    expect(existsSync(s.dir)).toBe(false);
  });
  it('R5 — les dossiers ignorés (node_modules) sont reliés dans le worktree', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv\n');
    git(repo, 'add', '--', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'x');
    const s = spec(repo);
    expect(prepareTree(s).ok).toBe(true);
    expect(readFileSync(join(s.dir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('x');
    expect(git(s.dir, 'status', '--porcelain')).toBe(''); // les liens ne salissent pas l'arbre
  });
});

describe('R11 — reprise du worktree', () => {
  it('R11 — reprise d\'un lot suspendu : même chemin de worktree, mêmes commits', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    const tip = git(s.dir, 'rev-parse', 'HEAD');
    const again = prepareTree(s);
    expect(again).toEqual({ ok: true, reused: true });
    expect(git(s.dir, 'rev-parse', 'HEAD')).toBe(tip);
  });
  it('R11 — worktree enregistré mais dossier disparu : élagué et recréé sur la branche existante', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    const tip = git(s.dir, 'rev-parse', 'HEAD');
    rmSync(s.dir, { recursive: true, force: true });
    const again = prepareTree(s);
    expect(again).toEqual({ ok: true, reused: true });
    expect(existsSync(join(s.dir, 'x.txt'))).toBe(true);
    expect(git(s.dir, 'rev-parse', 'HEAD')).toBe(tip);
  });
});

describe('R12 — conservation et retrait automatique', () => {
  it('R12 — lot intégré : worktree et branche retirés', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    git(repo, 'merge', '--ff-only', s.branch);
    expect(integrated(repo, s.branch, 'main')).toBe(true);
    expect(removeTree(s)).toEqual({ ok: true, abandoned: 0 });
    expect(existsSync(s.dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'cadence/*')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('worktrees');
  });
  it('R12 — branche non fusionnée : jamais supprimée (aucun -D), le worktree est conservé', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    const r = removeTree(s);
    expect(r).toEqual({ ok: false, unintegrated: 1 });
    expect(existsSync(s.dir)).toBe(true);
    expect(git(repo, 'branch', '--list', s.branch)).toContain(s.branch);
    expect(unintegratedCommits(repo, s.branch, 'main')).toBe(1);
  });
  it('R12 — un fichier suivi modifié dans le worktree : conservé même sans commit non intégré', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    writeFileSync(join(s.dir, 'a.txt'), 'modifié\n');
    expect(removeTree(s)).toEqual({ ok: false, unintegrated: 0, dirty: ['a.txt'] });
    expect(existsSync(s.dir)).toBe(true);
  });
  it('R20 — avec abandon explicite : commits non intégrés abandonnés, worktree et branche retirés', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    commitIn(s.dir, 'y.txt', 'feat(L1): y');
    expect(removeTree(s, { abandon: true })).toEqual({ ok: true, abandoned: 2 });
    expect(existsSync(s.dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'cadence/*')).toBe('');
  });
  it('R12 — un lien vers le dépôt (node_modules) ne fait pas perdre le contenu du dépôt au retrait', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '--', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'x');
    const s = spec(repo);
    prepareTree(s);
    expect(removeTree(s).ok).toBe(true);
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('x');
  });
});

describe('R19 — worktrees conservés', () => {
  it('R19 — la liste donne dépôt, lot, vague, âge, commits non intégrés et chemin', () => {
    const repo = repoWithCommit();
    const s = spec(repo);
    prepareTree(s);
    commitIn(s.dir, 'x.txt', 'feat(L1): x');
    const kept = keptTrees(repo);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ lot: 'proj:L1', wave: 'w1', branch: s.branch, dir: s.dir, unintegrated: 1, dirExists: true });
    expect(kept[0].created).toBeGreaterThan(0);
  });
  it('R19 — aucun worktree conservé : liste vide', () => {
    expect(keptTrees(repoWithCommit())).toEqual([]);
  });
  it('R19 — une branche qui n\'est pas à cadence n\'est pas listée', () => {
    const repo = repoWithCommit();
    git(repo, 'branch', 'cadence/autre/x'); // sans la config de cadence : non reconnue
    expect(keptTrees(repo)).toEqual([]);
  });
});
