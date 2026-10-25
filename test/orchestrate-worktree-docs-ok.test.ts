import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, inWorktree, lotOf, run, setup, type Handler } from './orchestrate-worktree-harness.js';

// L320 — l'acquittement docs_ok (raf docs-ok, L317) posé par la session DANS le worktree du lot est lu par la porte docs.sync.
const SYNC = 'docs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n';

/** L1 touche src-a.txt sans la doc ; L2 est indépendant. */
const implement: Handler = (cwd, brief) => {
  const lot = lotOf(brief);
  return claudeOut(workReport({ commits: [commitFile(cwd, lot === 'L1' ? 'src-a.txt' : 'L2.txt', `feat(${lot}): travail`)] }));
};

function repoWithSync() {
  const w = setup();
  writeFileSync(join(w.repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  worktrees: true\n${SYNC}`);
  git(w.repo, 'add', '--', 'cadence.yaml');
  git(w.repo, 'commit', '-q', '-m', 'chore: docs.sync', '--', 'cadence.yaml');
  return w;
}

describe('L320 — docs_ok en mode worktree', () => {
  it('l\'écart acquitté par le lead dans le dépôt principal avant la vague est lu pour un lot joué dans un worktree : pas de passe du bibliothécaire, la revue part', async () => {
    const { parent, repo } = repoWithSync();
    const plan = Plan.load(join(repo, '.cadence', 'raf.yaml'));
    plan.setDocsOk('L1', 'la page décrit déjà ce comportement', '2026-10-25');
    plan.save();
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'chore(L1): docs-ok', '--', '.cadence/raf.yaml');
    const f = fake({ implement });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(f.calls.filter((c) => c.lot === 'L1').map((c) => c.kind)).toEqual(['implement', 'review']);
    expect(f.calls.every((c) => inWorktree(c.cwd))).toBe(true);
    expect(r.out).not.toContain('documentation en retard');
  });

  it('sans acquittement, la passe du bibliothécaire du worktree ne reçoit pas la consigne d\'écrire le plan (le programme seul l\'écrit) et nomme le lead', async () => {
    const { parent } = repoWithSync();
    const noop: Handler = () => claudeOut(workReport({ resume: 'rien à écrire' }));
    const f = fake({ implement, fix: noop, review: () => claudeOut(reviewReport()) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const fix = f.calls.find((c) => c.lot === 'L1' && c.kind === 'fix');
    expect(fix?.brief).not.toContain('then commit the plan file alone');
    expect(fix?.brief).toContain('the lead');
    expect(fix?.brief).toContain('raf docs-ok L1 --reason');
    expect(f.calls.filter((c) => c.lot === 'L1').map((c) => c.kind)).toEqual(['implement', 'fix']);
    expect(r.out).toContain('documentation en retard');
  });
});
