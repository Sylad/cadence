import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L557 (issue #26) — un --drop déjà appliqué est consommé par un --integrate explicite du même lot : le lot retiré, repris à la main puis revu, est intégré.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

/** Une vague dont L1 est rendu sur une revue non conforme, puis retiré (`drop` déjà dans control.log) ; le lead corrige et revoit dans le worktree. */
async function droppedThenReviewed(extraDrops: string[] = []) {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] }) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  const s = store(parent);
  for (const k of ['a:L1', ...extraDrops, 'a:L1']) s.requestDrop(k);
  const dir = lotTreeDir(s.dir, 'a', 'L1', repo);
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  plan.save();
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
  return { parent, repo, s };
}

describe('R1 — un --integrate explicite l\'emporte sur un --drop déjà appliqué', () => {
  it('R1 — lot retiré puis repris à la main et revu : --integrate l\'intègre, sans rejouer « retiré de la vague (--drop) »', async () => {
    const { parent, repo } = await droppedThenReviewed();
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.err).toBe('');
    expect(r.out).toContain('a:L1 → suspended — intégration reprise (--resume --integrate)');
    expect(r.out).not.toContain('retiré de la vague (--drop)');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(existsSync(join(repo, 'lead.txt'))).toBe(true);
  });
  it('R1 — le retrait de ce lot est consommé (toutes ses lignes), celui d\'un autre lot reste', async () => {
    const { parent, s } = await droppedThenReviewed(['a:L2']);
    await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(s.control().drops).toEqual(['a:L2']);
  });
  it('R1 — un --integrate refusé ne consomme pas le retrait', async () => {
    const { parent, s } = await droppedThenReviewed();
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L9'], fake());
    expect(r.code).toBe(2);
    expect(s.control().drops).toEqual(['a:L1', 'a:L1']);
  });
  it('R1 — --drop et --integrate du même lot dans une même commande restent refusés, le retrait déjà là est gardé', async () => {
    const { parent, s } = await droppedThenReviewed();
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1', '--drop', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain('lot aussi retiré par --drop');
    expect(readFileSync(join(s.dir, 'control.log'), 'utf8')).toBe('drop a:L1\ndrop a:L1\n');
  });
});
