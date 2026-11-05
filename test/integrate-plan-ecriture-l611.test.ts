import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { indentedSeq } from '../src/plan-ids.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L611 — la résolution d'un conflit de plan écrit comme Plan.save : lignes longues non repliées, « - » des lots gardés en colonne ou indentés.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));
const LONG = 'mot '.repeat(60).trim();

async function handedBack() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] }) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  return { parent, repo, dir: lotTreeDir(store(parent).dir, 'a', 'L1', repo) };
}


async function conflict(flush: boolean) {
  const { parent, repo, dir } = await handedBack();
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead');
  const file = join(dir, '.cadence/raf.yaml');
  const plan = Plan.load(file);
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  plan.note('L1', LONG, '2026-10-27');
  plan.save();
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
  const mp = planOf(repo);
  mp.note('L1', 'note de main', '2026-10-27');
  mp.save();
  const mf = join(repo, '.cadence/raf.yaml');
  if (flush) {
    const t = readFileSync(mf, 'utf8');
    writeFileSync(mf, t.replace(/^lots:\n([\s\S]*)$/m, (_m, body: string) => 'lots:\n' + body.replace(/^ {2}/gm, '')));
  }
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'plan: écriture du lead sur main');
  const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
  // le plan tel que le commit résolu l'a écrit : le commit suivant (revue enregistrée) passe par Plan.save et remet les lignes à plat
  const sha = git(repo, 'log', '-1', '--format=%H', '--grep=^plan: revue du lead L1$');
  return { r, resolved: git(repo, 'show', `${sha}:.cadence/raf.yaml`) };
}

describe('R1 — la taille du plan après résolution', () => {
  it('R1 — indentedSeq : lots en colonne → false, lots indentés → true, commentaires avant le « - » tolérés, aucun « lots: » → true', () => {
    expect(indentedSeq('a: 1\nlots:\n- id: L1\n')).toBe(false);
    expect(indentedSeq('a: 1\nlots:\n# c\n# d\n- id: L1\n')).toBe(false);
    expect(indentedSeq('a: 1\nlots:\n  - id: L1\n')).toBe(true);
    expect(indentedSeq('')).toBe(true);
    expect(indentedSeq('a: 1\n')).toBe(true);
  });
  it('R1 — une note longue (> 80 colonnes) : la ligne reste sur une ligne après résolution, pas de repliement', async () => {
    const { r, resolved: text } = await conflict(false);
    expect(r.err).toBe('');
    expect(text).toContain(LONG);
    expect(text.split('\n').filter((l) => l.includes('mot mot')).length).toBe(1);
  });
  it('R1 — plan de main aux « - » en colonne : la résolution les garde en colonne', async () => {
    const { r, resolved: text } = await conflict(true);
    expect(r.err).toBe('');
    expect(text).toMatch(/^lots:\n- id: L1/m);
    expect(text).toContain(LONG);
  });
  it('R1 — plan de main aux « - » indentés : la résolution les garde indentés', async () => {
    const { r, resolved } = await conflict(false);
    expect(r.err).toBe('');
    expect(resolved).toMatch(/^lots:\n {2}- id: L1/m);
  });
  it('R1 — le plan résolu est identique octet pour octet à ce que Plan.save réécrit', async () => {
    const { r, resolved } = await conflict(false);
    expect(r.err).toBe('');
    const f = join(tempDir(), 'raf.yaml');
    writeFileSync(f, resolved + '\n'); // git() rogne le saut de ligne final
    Plan.load(f).save();
    expect(readFileSync(f, 'utf8')).toBe(resolved + '\n');
  });
});
