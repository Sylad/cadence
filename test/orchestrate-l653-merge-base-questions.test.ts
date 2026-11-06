import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L653 (issue #48) — un merge de la base ne rend pas le lot pour « plan modifié » ; les questions de la session sont gardées.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});
const PLAN = '.cadence/raf.yaml';

/** Une session qui commite le plan elle-même, puis fusionne la base (qui porte un commit de plan du programme). */
const touchThenMerge = (repo: string, questions: unknown) =>
  fake({
    implement: async (cwd, brief) => {
      const lot = lotOf(brief);
      if (lot !== 'L1') return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      appendFileSync(join(cwd, PLAN), '# note de la session\n');
      git(cwd, 'add', '--', PLAN);
      git(cwd, 'commit', '-q', '-m', 'feat(L1): touche le plan');
      const p = Plan.load(join(repo, PLAN));
      p.note('L1', 'une note du programme', '2026-10-04');
      p.save();
      git(repo, 'add', '--', PLAN);
      git(repo, 'commit', '-q', '-m', 'plan: L1 une note');
      git(cwd, 'merge', '--no-edit', '-q', '-X', 'ours', 'main');
      return claudeOut({ ...workReport({ commits: [] }), questions } as never);
    },
  });

describe('L653 — bords', () => {
  it('L653 — la session commite le plan elle-même puis fusionne la base : toujours rendue pour plan modifié', async () => {
    const { parent, repo } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], touchThenMerge(repo, []));
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toContain('modifié le plan');
  });
  it('L653 — questions vides ou « aucune question » : rien de gardé, pas de suffixe', async () => {
    const { parent, repo } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], touchThenMerge(repo, ['', '  ', 'aucune question']));
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).not.toContain('questions de la session');
    expect(l1.questions ?? []).toEqual([]);
  });
  it('L653 — questions absentes ou d\'un mauvais type (chaîne) : pas de plantage, rien de gardé', async () => {
    const { parent, repo } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], touchThenMerge(repo, 'une seule ?'));
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toContain('modifié le plan');
    expect(l1.outcome).not.toContain('questions de la session');
  });
  it('L653 — plusieurs questions dont une vide : les vraies gardées dans l\'ordre, la vide écartée', async () => {
    const { parent, repo } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], touchThenMerge(repo, ['Un ?', '', 'Deux ?']));
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.questions).toEqual(['Un ?', 'Deux ?']);
    expect(l1.outcome).toContain('questions de la session : « Un ? » / « Deux ? »');
  });
});
