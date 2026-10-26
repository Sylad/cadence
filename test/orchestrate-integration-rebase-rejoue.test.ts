import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store, subjects } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L364 — main avance pendant l'intégration (commit de plan du lead, autre lot) : le rebase et les contrôles sont rejoués au nouveau sommet, deux fois au plus.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
const edit = (cwd: string, n: number, lot: string) => {
  writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
  git(cwd, 'add', '--', 'f.txt');
  git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
  return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
};
/** Le lead commite un fichier à lui sur main (arbre propre ensuite) pendant la revue courte du second lot intégré, `times` fois au plus. */
async function leadCommitsDuringIntegration(times: number) {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
  let moved = 0;
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      return edit(cwd, lot === 'L1' ? 4 : 7, lot);
    },
    'review-small': async () => {
      if (moved < times) {
        moved++;
        writeFileSync(join(repo, `plan-lead-${moved}.txt`), 'x\n');
        git(repo, 'add', '--', `plan-lead-${moved}.txt`);
        git(repo, 'commit', '-q', '-m', `plan: commit du lead ${moved}`);
      }
      return claudeOut(reviewReport({ verdict: 'rebase sans dégât' }));
    },
  });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  return { parent, repo, r, reviews: f.calls.filter((c) => c.kind === 'review-small').length, lot: f.calls.find((c) => c.kind === 'review-small')!.lot };
}

describe('L364 — main a avancé pendant l\'intégration', () => {
  it('R1 — un commit du lead sur main pendant les contrôles : rebase et contrôles rejoués au nouveau sommet, le lot est intégré sans être rendu', async () => {
    const { parent, repo, r, reviews, lot } = await leadCommitsDuringIntegration(1);
    expect(r.code).toBe(0);
    expect(store(parent).readLot('a', lot)!.status).toBe('ready');
    expect(reviews).toBe(2); // la revue courte du diff rebasé est rejouée au nouveau sommet
    const log = git(repo, 'log', '--format=%s', 'main').split('\n');
    expect(log).toContain('plan: commit du lead 1'); // le commit du lead n'est pas perdu
    expect(log).toContain(`feat(${lot}): travail`);
    expect(r.out).toContain(`a:${lot} main a avancé pendant l'intégration, rebase rejoué`);
  });
  it('R2 — main n\'a pas bougé : aucune ligne « rebase rejoué »', async () => {
    const { r } = await leadCommitsDuringIntegration(0);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('rebase rejoué');
  });
  it('R3 — main avance encore au second essai : un troisième tour passe, et le journal compte deux rebases rejoués', async () => {
    const { r, parent, lot } = await leadCommitsDuringIntegration(2);
    expect(r.code).toBe(0);
    expect(store(parent).readLot('a', lot)!.status).toBe('ready');
    expect(r.out.split("main a avancé pendant l'intégration, rebase rejoué")).toHaveLength(3);
  });
  it('R4 — main avance à chaque tour : après deux rebases rejoués le lot est rendu next: integrate, la branche du dépôt garde les commits du lead et rien du lot', async () => {
    const { parent, repo, r, lot } = await leadCommitsDuringIntegration(3);
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', lot)!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/^intégration refusée : main a encore avancé après 2 rebases rejoués ; branche du dépôt inchangée par le lot, worktree conservé : /);
    expect(subjects(repo).some((s) => s.startsWith(`feat(${lot})`))).toBe(false);
    expect(subjects(repo)).toContain('plan: commit du lead 3');
  });
});
