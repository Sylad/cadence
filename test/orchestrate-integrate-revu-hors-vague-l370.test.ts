import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, subjects, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L370 — `--resume --integrate` accepte un lot rendu hors de l'étape d'intégration (budget, revue non conforme) quand le lead a fait corriger
// puis revoir le travail hors vague : `raf review` conforme dont le commit est le dernier commit du lot dans son worktree.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

/** Une vague dont L1 est rendu sur une revue non conforme (la revue reste non conforme après les passes de correction). */
async function handedBack() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] }) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  const l = store(parent).readLot('a', 'L1')!;
  return { parent, repo, l, dir: lotTreeDir(store(parent).dir, 'a', 'L1', repo) };
}

/** Le lead corrige dans le worktree, puis y enregistre sa revue avec `raf review` (le plan du worktree, commité : une reprise refuse un fichier suivi modifié). */
function leadFixes(dir: string, review: boolean) {
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
  if (!review) return;
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  plan.save();
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
}

describe('R1 — un lot revu conforme hors vague est intégré par --integrate', () => {
  it('R1 — lot rendu sur revue non conforme, corrigé puis revu par le lead : rebase, avance, verdict du lead gardé, lot prêt', async () => {
    const { parent, repo, l, dir } = await handedBack();
    expect(l.status).toBe('handed-back');
    expect(l.next ?? null).toBeNull();
    leadFixes(dir, true);
    writeFileSync(join(repo, 'autre.txt'), 'le lead avance\n');
    git(repo, 'add', '--', 'autre.txt');
    git(repo, 'commit', '-q', '-m', 'chore: le lead avance'); // le rebase a quelque chose à faire
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.err).toBe('');
    expect(r.out).toContain('a:L1 → suspended — intégration reprise (--resume --integrate)');
    const after = store(parent).readLot('a', 'L1')!;
    expect(after.status).toBe('ready');
    expect(subjects(repo).some((s) => s.startsWith('fix(L1): correction du lead hors vague'))).toBe(true);
    expect(existsSync(join(repo, 'lead.txt'))).toBe(true);
    const review = planOf(repo).lot('L1').review!;
    expect(review.verdict).toContain('relu par le lead');
    expect(review.commit).toBe(git(repo, 'log', '-n1', '--format=%H', '--grep=correction du lead')); // verdict reporté au sha rebasé
    expect(review.verdict).toContain('revue courte du diff rebasé'); // le commit de plan du worktree change le diff relu : revue courte, pas de report
  });
});

describe('R2 — sans revue du lead plus récente que le dernier commit, le refus reste', () => {
  it('R2 — aucune revue enregistrée : refus d\'avant, rien n\'est écrit', async () => {
    const { parent, repo, dir } = await handedBack();
    leadFixes(dir, false);
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain("--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration");
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });
  it('R2 — un commit postérieur à la revue du lead : refus', async () => {
    const { parent, repo, dir } = await handedBack();
    leadFixes(dir, true);
    commitFile(dir, 'apres.txt', 'fix(L1): encore un commit');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain("--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration");
  });
  it('R2 — --replay ne prend pas ce chemin', async () => {
    const { parent, repo, dir } = await handedBack();
    leadFixes(dir, true);
    const r = await run(parent, ['--resume', WAVE, '--replay', 'a:L1'], fake());
    expect(r.code).toBe(2);
  });
});
