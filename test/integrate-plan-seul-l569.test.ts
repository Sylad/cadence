import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L569 — un conflit de rebase qui ne porte que sur le plan se fusionne seul : la version du dépôt + les écritures du lot (revue, notes, état).
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
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] }) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  return { parent, repo, dir: lotTreeDir(store(parent).dir, 'a', 'L1', repo) };
}

/** Le lead corrige dans le worktree puis y commite son plan : la revue plus ce que `write` y ajoute. */
function leadReviews(dir: string, write: (plan: Plan) => void = () => {}, raw: (file: string) => void = () => {}) {
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
  const file = join(dir, '.cadence/raf.yaml');
  const plan = Plan.load(file);
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  write(plan);
  plan.save();
  raw(file);
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
}

/** Un commit de plan sur la branche du dépôt. */
function mainPlan(repo: string, write: (plan: Plan) => void) {
  const plan = planOf(repo);
  write(plan);
  plan.save();
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'plan: écriture du lead sur main');
}

/** Pose `started:` de L1 à la main (aucune commande du plan n'écrit ce seul champ). */
function setStarted(file: string, day: string) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/(- id: L1\n(?:    .*\n)*?)    started: .*\n/, `$1    started: ${day}\n`);
  if (next === text) throw new Error('started: introuvable sur L1');
  writeFileSync(file, next);
}

const integrate = (parent: string) => run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());

describe('R1 — le plan seul en conflit se fusionne : dépôt + écritures du lot', () => {
  it('R1 — une note posée des deux côtés sur L1 : les deux notes sont gardées, celle de main d\'abord', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.note('L1', 'note du lot', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    const notes = planOf(repo).lot('L1').notes.map((n) => n.text);
    expect(notes).toEqual(['note de main', 'note du lot']);
  });
  it('R1 — l\'état du lot (started) écrit par le lot, le dépôt change autre chose de L1 : les deux sont gardés', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, undefined, (file) => setStarted(file, '2026-10-01'));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    const lot = planOf(repo).lot('L1');
    expect(lot.started).toBe('2026-10-01');
    expect(lot.notes.map((n) => n.text)).toContain('note de main');
    expect(lot.review!.verdict).toContain('relu par le lead');
  });
});

describe('R2 — ce que le lot n\'écrit pas ne se fusionne pas', () => {
  it('R2 — le lot change l\'estimation de L1 et le dépôt bouge le plan : le conflit reste un conflit, le dépôt n\'est pas touché', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.setEstimate('L1', 3));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    const r = await integrate(parent);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(r.out).toContain('conflit en rebasant');
    expect(planOf(repo).lot('L1').estimate).not.toBe(3);
  });
  it('R2 — le lot et le dépôt écrivent des valeurs différentes du même champ d\'état : conflit', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, undefined, (file) => setStarted(file, '2026-10-01'));
    setStarted(join(repo, '.cadence/raf.yaml'), '2026-10-05');
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'plan: started de main');
    const r = await integrate(parent);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(r.out).toContain('conflit en rebasant');
  });
  it('R2 — un lot ajouté par le lot : conflit', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.add('nouveau', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    const r = await integrate(parent);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(r.out).toContain('conflit en rebasant');
  });
});

// L611 — la résolution réécrit le plan comme `Plan.save` : lignes non repliées, « - » des lots en colonne 0 quand le plan du dépôt les y met.
describe('R611 — la taille du plan après résolution', () => {
  it('R611 — une note longue des deux côtés : le plan résolu garde une ligne par note et ses « - » en colonne 0, sans gonfler', async () => {
    const { parent, repo, dir } = await handedBack();
    const longue = (m: string) => `${m} ${'mot '.repeat(60)}fin`;
    leadReviews(dir, (p) => p.note('L1', longue('du lot'), '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', longue('de main'), '2026-10-27'));
    const file = join(repo, '.cadence/raf.yaml');
    const [tete, lots] = readFileSync(file, 'utf8').split(/^lots:\n/m);
    writeFileSync(file, `${tete}lots:\n${lots.replace(/^ {2}/gm, '')}`); // le plan du dépôt met ses « - » en colonne 0
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'plan: « - » en colonne 0');
    const avant = readFileSync(file, 'utf8').split('\n').length;
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    const texte = readFileSync(file, 'utf8');
    expect(texte.split('\n').filter((l) => l.includes('mot mot mot mot')).length).toBe(2);
    expect(texte.split('\n').length - avant).toBeLessThan(15);
    expect(texte).toMatch(/^lots:\n- id: L1/m);
  });
});
