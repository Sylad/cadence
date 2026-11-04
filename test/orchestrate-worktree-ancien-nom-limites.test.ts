import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { keptBranchesOfLot, legacyLotSlug, lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { lotSlug } from '../src/orchestrate/state.js';
import { commitFile, git } from './orchestrate-harness.js';
import { fake, run, setup } from './orchestrate-worktree-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// L581 (issue #38) — sondes aux bords : projet « . », deux branches du lot, HEAD détaché, deux appels, forme ancienne dégénérée.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function kept(repo: string, wave: string, project: string, lot: string, n: number, created: number): { branch: string; dir: string } {
  const dir = lotTreeDir(join(repo, '..', `.cadence-${wave}`), project, lot);
  const branch = lotBranch(wave, project, lot);
  const made = prepareTree({ repo, dir, branch, base: 'main', lot: `${project}:${lot}` });
  if (!made.ok) throw new Error(made.cause);
  for (let i = 0; i < n; i++) commitFile(dir, `${wave}-${lot}-${i}.txt`, `feat(${lot}): travail ${i}`);
  git(repo, 'config', '--local', `branch.${branch}.cadence-created`, String(created));
  return { branch, dir };
}

describe('R2 — le --dry-run au bord', () => {
  it('R2 — projet « . » (racine du dépôt) : la branche gardée cadence/<vague>/_--L1 est dite par le --dry-run', async () => {
    const { repo } = setup();
    const old = kept(repo, 'w1', '.', 'L1', 2, 1000);
    expect(old.branch).toBe('cadence/w1/_--L1');
    const r = await run(repo, ['.:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${old.branch} d'une vague précédente (2 commit(s) non intégré(s))`);
  });
  it('R2 — deux branches non intégrées du lot : la plus récente est reprise, l\'autre dit laquelle la devance', async () => {
    const { parent, repo } = setup();
    const older = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const newer = kept(repo, 'w2', 'a', 'L1', 2, 2000);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${newer.branch} d'une vague précédente (2 commit(s) non intégré(s)) : reprise par la vague`);
    expect(r.out).toContain(`branche ${older.branch} d'une vague précédente (1 commit(s) non intégré(s)) : n'est pas reprise, une branche plus récente du lot (${newer.branch}) l'est`);
  });
  it('R2 — HEAD détaché du dépôt : la cause le dit', async () => {
    const { parent, repo } = setup();
    const old = kept(repo, 'w1', 'a', 'L1', 1, 1000);
    git(repo, 'checkout', '-q', '--detach');
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toContain(`branche ${old.branch} d'une vague précédente (1 commit(s) non intégré(s)) : n'est pas reprise, le dépôt est en HEAD détaché`);
  });
  it('R2 — deux --dry-run de suite : même sortie, aucune branche ni worktree touché', async () => {
    const { parent, repo } = setup();
    kept(repo, 'w1', 'a', 'L1', 1, 1000);
    const before = git(repo, 'worktree', 'list') + git(repo, 'branch', '--list', 'cadence/*');
    const a = await run(parent, ['a:L1', '--dry-run'], fake());
    const b = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(a.out);
    removeDryRunBriefs(b.out);
    expect(b.out.split('\n').filter((l) => l.includes("d'une vague précédente"))).toEqual(a.out.split('\n').filter((l) => l.includes("d'une vague précédente")));
    expect(git(repo, 'worktree', 'list') + git(repo, 'branch', '--list', 'cadence/*')).toBe(before);
  });
  it('R2 — un lot dont une branche porte un autre lot de même suffixe (L1 / XL1) : pas de confusion', async () => {
    const { parent, repo } = setup();
    kept(repo, 'w1', 'a', 'XL1', 1, 1000);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).not.toContain("d'une vague précédente");
  });
});

describe('R1 — la recherche des deux formes au bord', () => {
  it('R1 — projet « org/a » : keptBranchesOfLot trouve les deux formes, la plus récente d\'abord', () => {
    const { repo } = setup();
    const legacy = kept(repo, 'w1', 'a', 'L1', 1, 3000);
    const current = kept(repo, 'w2', 'org/a', 'L1', 1, 2000);
    const found = keptBranchesOfLot(repo, lotBranch('w3', 'org/a', 'L1'), [lotSlug('org/a', 'L1'), legacyLotSlug('org/a', 'L1') as string]);
    expect(found.map((t) => t.branch)).toEqual([legacy.branch, current.branch]);
  });
  it('R1 — projet « . » : keptBranchesOfLot avec la forme actuelle du projet trouve la branche _--L1', () => {
    const { repo } = setup();
    const k = kept(repo, 'w1', '.', 'L1', 1, 1000);
    const found = keptBranchesOfLot(repo, lotBranch('w2', '.', 'L1'), [lotSlug('.', 'L1')]);
    expect(found.map((t) => t.branch)).toEqual([k.branch]);
  });
  it('R1 — dates de création égales (ou absentes) : l\'ordre est stable, la branche au nom le plus grand d\'abord', () => {
    const { repo } = setup();
    const a = kept(repo, 'w1', 'a', 'L1', 1, 0);
    const b = kept(repo, 'w2', 'org/a', 'L1', 1, 0);
    const found = keptBranchesOfLot(repo, lotBranch('w3', 'org/a', 'L1'), ['org__a--L1', 'a--L1']);
    expect(found.map((t) => t.branch)).toEqual([a.branch, b.branch].sort().reverse());
  });
});
