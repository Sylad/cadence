import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { baseBranchOf, legacyLotSlug, lotBranch, lotTreeDir, prepareTree, recoverTree } from '../src/orchestrate/worktree.js';
import { commitFile, git } from './orchestrate-harness.js';
import { fake, run, setup } from './orchestrate-worktree-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// L581 (issue #38) — la branche gardée d'un lot sous l'ancien nom du projet (`<repo>--<lot>`) est retrouvée sous le nom actuel (`<org>__<repo>--<lot>`).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Une branche gardée d'une vague passée, du projet `project`, avec `n` commits de travail. */
function kept(repo: string, wave: string, project: string, lot: string, n: number, created: number, base = 'main'): { branch: string; dir: string } {
  const dir = lotTreeDir(join(repo, '..', `.cadence-${wave}`), project, lot);
  const branch = lotBranch(wave, project, lot);
  const made = prepareTree({ repo, dir, branch, base, lot: `${project}:${lot}` });
  if (!made.ok) throw new Error(made.cause);
  for (let i = 0; i < n; i++) commitFile(dir, `${wave}-${lot}-${i}.txt`, `feat(${lot}): travail ${i}`);
  git(repo, 'config', '--local', `branch.${branch}.cadence-created`, String(created));
  return { branch, dir };
}

describe('R1 — la forme ancienne du nom de branche est celle du projet sans son organisation', () => {
  it('R1 — « org/repo » : l\'ancienne forme est « repo--lot » ; un id de lot avec « / » devient « __ » comme dans la forme actuelle', () => {
    expect(legacyLotSlug('org/repo', 'L1')).toBe('repo--L1');
    expect(legacyLotSlug('org/repo', 'Q4/accueil-4')).toBe('repo--Q4__accueil-4');
    expect(legacyLotSlug('a/b/c', 'L1')).toBe('c--L1');
  });
  it('R1 — projet sans « / » (ou « . » de la racine) : pas d\'ancienne forme distincte', () => {
    expect(legacyLotSlug('a', 'L1')).toBeNull();
    expect(legacyLotSlug('.', 'L1')).toBeNull();
  });
});

describe('R1 — une nouvelle vague retrouve la branche gardée sous l\'ancien nom du projet', () => {
  it('R1 — branche cadence/w1/a--L1 gardée, projet « org/a » : recoverTree la renomme au nom de la nouvelle vague, worktree déplacé, commits compris', () => {
    const { repo, parent } = setup();
    const old = kept(repo, 'w1', 'a', 'L1', 5, 1000);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'org/a', 'L1');
    const branch = lotBranch('w2', 'org/a', 'L1');
    expect(branch).toBe('cadence/w2/org__a--L1');
    expect(recoverTree(repo, branch, dir, 'main', { planFiles: new Set(), alsoSlugs: [legacyLotSlug('org/a', 'L1') as string] })).toEqual({ from: old.branch, unintegrated: 5 });
    expect(baseBranchOf(repo, branch)).toBe('main');
    expect(existsSync(old.dir)).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(existsSync(join(dir, 'w1-L1-4.txt'))).toBe(true);
  });
  it('R1 — sans l\'ancienne forme donnée, la branche ancienne n\'est pas reprise (le comportement d\'avant, par défaut)', () => {
    const { repo, parent } = setup();
    kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'org/a', 'L1');
    expect(recoverTree(repo, lotBranch('w2', 'org/a', 'L1'), dir, 'main')).toBeNull();
  });
  it('R1 — les deux formes gardées : la plus récente par date de création gagne, quelle que soit sa forme', () => {
    const { repo, parent } = setup();
    const legacyNewer = kept(repo, 'w1', 'a', 'L1', 1, 3000);
    const current = kept(repo, 'w2', 'org/a', 'L1', 2, 2000);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w3'), 'org/a', 'L1');
    expect(recoverTree(repo, lotBranch('w3', 'org/a', 'L1'), dir, 'main', { planFiles: new Set(), alsoSlugs: ['a--L1'] })?.from).toBe(legacyNewer.branch);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').split('\n').sort()).toEqual([current.branch, 'cadence/w3/org__a--L1'].sort());
  });
  it('R1 — les deux formes gardées, la forme actuelle plus récente : c\'est elle qui est reprise', () => {
    const { repo, parent } = setup();
    kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const current = kept(repo, 'w2', 'org/a', 'L1', 2, 2000);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w3'), 'org/a', 'L1');
    expect(recoverTree(repo, lotBranch('w3', 'org/a', 'L1'), dir, 'main', { planFiles: new Set(), alsoSlugs: ['a--L1'] })?.from).toBe(current.branch);
  });
  it('R1 — l\'ancienne forme d\'un autre lot, ou intégrée, ou partie d\'une autre branche : rien à reprendre', () => {
    const { repo, parent } = setup();
    kept(repo, 'w1', 'a', 'L2', 1, 1000); // un autre lot
    const done = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    git(repo, 'merge', '--ff-only', '-q', done.branch); // intégrée
    kept(repo, 'w1', 'a', 'L3', 1, 1000, 'main');
    git(repo, 'config', '--local', `branch.${lotBranch('w1', 'a', 'L3')}.cadence-base`, 'develop'); // partie d'une autre branche
    const at = (lot: string) => recoverTree(repo, lotBranch('w2', 'org/a', lot), lotTreeDir(join(parent, 'w2'), 'org/a', lot), 'main', { planFiles: new Set(), alsoSlugs: [`a--${lot}`] });
    expect(at('L1')).toBeNull();
    expect(at('L3')).toBeNull();
    expect(at('L4')).toBeNull();
  });
  it('R1 — la branche de la nouvelle vague existe déjà : l\'ancienne forme n\'est pas touchée', () => {
    const { repo, parent } = setup();
    const old = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const own = kept(repo, 'w2', 'org/a', 'L1', 0, 2000);
    expect(recoverTree(repo, own.branch, lotTreeDir(join(parent, 'w2'), 'org/a', 'L1'), 'main', { planFiles: new Set(), alsoSlugs: ['a--L1'] })).toBeNull();
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/w1/*').trim()).toBe(old.branch);
  });
});

describe('R2 — le --dry-run dit qu\'une branche ancienne du lot existe, et si elle est reprise', () => {
  it('R2 — branche gardée partie de la branche du dépôt : « serait reprise » avec son nombre de commits, rien n\'est déplacé', async () => {
    const { parent, repo } = setup();
    const old = kept(repo, 'w1', 'a', 'L1', 3, 1000);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${old.branch} d'une vague précédente (3 commit(s) non intégré(s)) : reprise par la vague`);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim()).toBe(old.branch);
  });
  it('R2 — branche gardée partie d\'une autre branche : « n\'est pas reprise » avec la cause', async () => {
    const { parent, repo } = setup();
    git(repo, 'branch', 'develop');
    const old = kept(repo, 'w1', 'a', 'L1', 2, 1000, 'develop');
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${old.branch} d'une vague précédente (2 commit(s) non intégré(s)) : n'est pas reprise, elle est partie de develop et le dépôt est sur main`);
  });
  it('R2 — orchestrate.worktrees absent : la branche ancienne n\'est pas reprise, la cause le dit', async () => {
    const { parent, repo } = setup([{ title: 'un' }], '');
    const old = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${old.branch} d'une vague précédente (1 commit(s) non intégré(s)) : n'est pas reprise, orchestrate.worktrees n'est pas actif`);
  });
  it('R2 — aucune branche ancienne, une branche intégrée ou d\'un autre lot : le --dry-run n\'en parle pas', async () => {
    const { parent, repo } = setup();
    const done = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    git(repo, 'merge', '--ff-only', '-q', done.branch);
    kept(repo, 'w1', 'a', 'L2', 1, 1000);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).not.toContain("d'une vague précédente");
  });
});
