import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L464 — l'intégration (L370) ne résout pas seule un conflit de plan dont le commit rejoué change aussi un champ d'extension déclaré.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

async function handedBack() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  writeFileSync(join(repo, 'cadence.yaml'), `${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}plan:\n  extras:\n    theme: { enum: [infra, ui] }\n`);
  git(repo, 'add', '--', 'cadence.yaml');
  git(repo, 'commit', '-q', '-m', 'chore: plan.extras');
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] }) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  return { parent, repo, dir: lotTreeDir(store(parent).dir, 'a', 'L1', repo) };
}

describe('R8 — un champ d\'extension changé par le commit rejoué n\'est pas perdu en silence', () => {
  it('R8 — revue du lead et theme: posé à la main dans le même commit de plan, plan du dépôt bougé : le conflit reste un conflit', async () => {
    const { parent, repo, dir } = await handedBack();
    commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
    const file = join(dir, '.cadence/raf.yaml');
    const wt = Plan.load(file);
    wt.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
    wt.save();
    writeFileSync(file, readFileSync(file, 'utf8').replace(/(- id: L1\n)/, '$1    theme: ui\n'));
    git(dir, 'add', '--', '.cadence/raf.yaml');
    git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1 et theme');
    const plan = planOf(repo);
    plan.note('L1', 'à garder pour la suite', '2026-10-27');
    plan.save();
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'plan: note du lead sur L1');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(r.out).toContain('conflit en rebasant');
  });
});
