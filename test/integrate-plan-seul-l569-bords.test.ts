import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L569 (probe : bords) — un conflit de rebase qui ne porte que sur le plan se fusionne seul : la version du dépôt + les écritures du lot (revue, notes, état).
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
const handedBackStill = (parent: string) => store(parent).readLot('a', 'L1')!.status === 'handed-back';

describe('R1 bords — le plan seul en conflit', () => {
  it('R1 bord — la même note identique des deux côtés : fusion sans doublon', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.note('L1', 'même note', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'même note', '2026-10-27'));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(handedBackStill(parent)).toBe(false);
    expect(planOf(repo).lot('L1').notes.map((n) => n.text)).toEqual(['même note']);
  });
  it('R1 bord — la tête du plan (acknowledged) change sur main, le lot n\'écrit que sa revue : la tête de main est gardée', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir);
    mainPlan(repo, (p) => p.acknowledge({ subject: 'chore: bruit', date: '2026-10-27' } as never));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(handedBackStill(parent)).toBe(false);
    expect(planOf(repo).acknowledged.map((a) => a.subject)).toContain('chore: bruit');
    expect(planOf(repo).lot('L1').review!.verdict).toContain('relu par le lead');
  });
  it('R1 bord — main change la revue de L1 à une autre valeur que le lot : conflit, dépôt intact', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir);
    mainPlan(repo, (p) => p.recordReview('L1', 'non conforme : main', '2026-10-28', null));
    const before = git(repo, 'rev-parse', 'HEAD');
    const r = await integrate(parent);
    expect(handedBackStill(parent)).toBe(true);
    expect(r.out).toContain('conflit en rebasant');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });
  it('R1 bord — la revue du lot sur L1 et une note du lot sur L2 : les deux sont reprises', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.note('L2', 'note lot sur L2', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(planOf(repo).lot('L2').notes.map((n) => n.text)).toEqual(['note lot sur L2']);
    expect(planOf(repo).lot('L1').notes.map((n) => n.text)).toEqual(['note de main']);
  });
  it('R1 bord — deux notes de main puis une du lot : ordre conservé', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.note('L1', 'lot', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'm1', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'm2', '2026-10-27'));
    const r = await integrate(parent);
    expect(r.err).toBe('');
    expect(planOf(repo).lot('L1').notes.map((n) => n.text)).toEqual(['m1', 'm2', 'lot']);
  });
  it('R1 bord — le lot ajoute une note et change l\'estimation d\'un AUTRE lot : conflit', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => { p.note('L1', 'lot', '2026-10-27'); p.setEstimate('L2', 5); });
    mainPlan(repo, (p) => p.note('L1', 'm1', '2026-10-27'));
    const r = await integrate(parent);
    expect(handedBackStill(parent)).toBe(true);
    expect(r.out).toContain('conflit en rebasant');
  });
  it('R1 bord — main retire L2 du plan : conflit (un lot manque à la branche du dépôt)', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir);
    const file = join(repo, '.cadence/raf.yaml');
    const text = readFileSync(file, 'utf8');
    const cut = text.replace(/(\n  - id: L2\n(?:    .*\n|\n)*)/, '\n');
    if (cut === text) throw new Error('L2 introuvable');
    writeFileSync(file, cut);
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'plan: retire L2');
    const r = await integrate(parent);
    expect(handedBackStill(parent)).toBe(true);
    expect(r.out).toContain('conflit en rebasant');
  });
  it('R1 bord — le plan résolu reste un plan valide (rechargeable) et sans marqueur de conflit', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir, (p) => p.note('L1', 'note du lot', '2026-10-27'));
    mainPlan(repo, (p) => p.note('L1', 'note de main', '2026-10-27'));
    await integrate(parent);
    const text = readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8');
    expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(planOf(repo).lots().map((l) => l.id)).toEqual(['L1', 'L2']);
  });
  it('R1 bord — deux intégrations de suite : la seconde ne casse rien', async () => {
    const { parent, repo, dir } = await handedBack();
    leadReviews(dir);
    mainPlan(repo, (p) => p.note('L1', 'm', '2026-10-27'));
    await integrate(parent);
    const head = git(repo, 'rev-parse', 'HEAD');
    await integrate(parent);
    expect(planOf(repo).lot('L1').notes.map((n) => n.text)).toEqual(['m']);
    expect(git(repo, 'status', '--porcelain', '--', '.cadence/raf.yaml')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });
});
