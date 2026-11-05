import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { lotWallMs, wallCapMs } from '../src/orchestrate/wall-cap.js';
import { convergeBrief, wallReason } from '../src/orchestrate/cycle/converge.js';
import { resumeNext } from '../src/orchestrate/ajout.js';
import { isNonConformingVerdict } from '../src/audit.js';
import { loadTemplates } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { type LotState, type StepState } from '../src/orchestrate/state.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';

// L622 (issue #41) : les revues convergent. Dès la revue de code 2, un majeur marqué `inchange: true` (absent de la revue précédente, hors de l'objectif du lot et des lignes qu'il change)
// va en suite proposée et n'achète pas de passe ; un bloquant en achète toujours une. Un lot qui a passé deux fois sa durée attendue est rendu avec ses constats au lieu d'une passe de plus.
type K = { gravite: string; texte: string; fichier?: string; ligne?: number; inchange?: unknown };
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const rev = (constats: K[]): Handler => () => {
  const n = (g: string) => constats.filter((k) => k.gravite === g).length;
  return claudeOut(reviewReport({ bloquants: n('bloquant'), majeurs: n('majeur'), mineurs: n('mineur'), constats, verdict: 'non conforme' }));
};
const maj = (texte: string, extra: Partial<K> = {}): K => ({ gravite: 'majeur', texte, ...extra });
const first = rev([maj('premier défaut', { fichier: 'a.txt', ligne: 1 })]);
const suiteCode = (c: { lot: { proposals: string[] } }) => c.lot.proposals.filter((p) => p.startsWith('[suite code]'));

async function run(second: Handler, third: Handler[] = []) {
  const h = harness({ script: { implement: [impl], review: [first, second, ...third], fix: [fix('b.txt'), fix('c.txt')] } });
  const c = h.lot('L1');
  await runLot(c);
  return { h, c };
}

describe('R1 — un majeur marqué ne compte plus à partir de la revue de code 2', () => {
  it('R1 — revue 2, un seul majeur marqué inchange: true : la revue est conforme, aucune passe de plus, le constat est en suite « [suite code] »', async () => {
    const { h, c } = await run(rev([maj('autre fichier', { fichier: 'z.txt', ligne: 9, inchange: true })]));
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.code?.conforme).toBe(true);
    expect(c.lot.pass).toBe(1);
    expect(suiteCode(c)).toEqual(['[suite code] z.txt:9 — autre fichier']);
    expect(c.lot.code?.verdict).toContain('1 majeur sur un point inchangé en suite pour le lead');
  });
  it('R1 — revue 2, majeur marqué et totaux annoncés majeurs: 1 : conforme quand même', async () => {
    const { c } = await run(() => claudeOut(reviewReport({ majeurs: 1, constats: [maj('x', { inchange: true })], verdict: 'non conforme' })));
    expect(c.lot.code?.conforme).toBe(true);
  });
  it('R1 — revue 2, un majeur marqué et un majeur non marqué : non conforme, seul le non marqué est renvoyé à la correction', async () => {
    const { h, c } = await run(rev([maj('marqué', { inchange: true }), maj('non marqué')]), [ok]);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    const brief = h.calls.filter((x) => x.kind === 'fix')[1].brief;
    expect(brief).toContain('non marqué');
    expect(brief).not.toContain('[majeur] marqué');
    expect(suiteCode(c)).toHaveLength(1);
  });
  it('R1 — revue 1, majeur marqué inchange: true : il compte comme avant (rien à comparer à une revue précédente)', async () => {
    const h = harness({ script: { implement: [impl], review: [rev([maj('x', { inchange: true })]), ok], fix: [fix('b.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
  });
  it('R1 — revue 2, verdict rédigé « non conforme : 1 majeur » avec le seul majeur marqué : le verdict enregistré ne dit plus « non conforme » (raf done et l\'audit le lisent conforme)', async () => {
    const { c } = await run(() => claudeOut(reviewReport({ majeurs: 1, constats: [maj('hors lot', { fichier: 'z.txt', ligne: 3, inchange: true })], verdict: 'non conforme : 1 majeur' })));
    expect(c.lot.code?.conforme).toBe(true);
    expect(isNonConformingVerdict(c.lot.code!.verdict)).toBe(false);
    expect(c.lot.code?.verdict).toMatch(/^conforme, 1 majeur sur un point inchangé en suite pour le lead : hors lot/);
  });
  it('R1 — revue 2, verdict de l\'agent conforme avec le majeur marqué : le verdict de l\'agent est gardé, suivi de la suite', async () => {
    const { c } = await run(() => claudeOut(reviewReport({ constats: [maj('hors lot', { inchange: true })], verdict: 'conforme : un point hors lot en suite' })));
    expect(c.lot.code?.verdict).toBe('conforme : un point hors lot en suite — conforme, 1 majeur sur un point inchangé en suite pour le lead : hors lot');
  });
  it('R1 — revue 2, majeur marqué qui répète un constat de la revue 1 (même fichier, même texte) : la marque est fausse, il compte, une passe suit, pas de suite', async () => {
    const { h, c } = await run(rev([maj('premier défaut', { fichier: 'a.txt', ligne: 1, inchange: true })]), [ok]);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
    expect(c.lot.warnings.some((w) => w.includes('premier défaut') && w.includes('revue précédente'))).toBe(true);
  });
  it("R1 — revue 2, majeur avec inchange 'true' (texte), null ou 1 : il compte", async () => {
    for (const inchange of ['true', null, 1]) {
      const { h, c } = await run(rev([maj('x', { inchange })]), [ok]);
      expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
      expect(suiteCode(c)).toEqual([]);
    }
  });
});

describe('R2 — un bloquant achète toujours une passe', () => {
  it('R2 — revue 2, bloquant marqué inchange: true : non conforme, une passe de correction suit', async () => {
    const { h, c } = await run(rev([{ gravite: 'bloquant', texte: 'perte de données', inchange: true }]), [ok]);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.pass).toBe(2);
    expect(suiteCode(c)).toEqual([]);
  });
});

describe('R3 — le brief de la revue 2 demande la marque, celui de la revue 1 non', () => {
  it('R3 — revue 1 : pas de consigne inchange ; revue 2 : consigne, avec le bloquant qui bloque toujours', async () => {
    const { h } = await run(ok);
    const reviews = h.calls.filter((x) => x.kind === 'review');
    expect(reviews[0].brief).not.toContain('inchange');
    expect(reviews[1].brief).toContain('inchange: true');
    expect(reviews[1].brief).toMatch(/blocking finding.*data loss.*security.*red test suite.*always/is);
  });
  it('R3 — la revue 2 reçoit les constats de la revue précédente (le relecteur peut juger « absent de la revue précédente ») et les suites déjà mises de côté', async () => {
    const { h } = await run(rev([maj('autre fichier', { fichier: 'z.txt', ligne: 9, inchange: true }), maj('non marqué', { fichier: 'b.txt', ligne: 2 })]), [ok]);
    const reviews = h.calls.filter((x) => x.kind === 'review');
    expect(reviews[0].brief).not.toContain('previous review');
    expect(reviews[1].brief).toContain('Findings of the previous review that the author had to fix:');
    expect(reviews[1].brief).toContain('- [majeur] a.txt:1 — premier défaut');
    expect(reviews[2].brief).toContain('- [majeur] b.txt:2 — non marqué');
    expect(reviews[2].brief).not.toContain('- [majeur] a.txt:1 — premier défaut');
    expect(reviews[2].brief).toContain('already set aside as follow-ups for the lead');
    expect(reviews[2].brief).toContain('z.txt:9 — autre fichier');
  });
  it('R3 — convergeBrief : revue courte de rang 2 (une revue conforme compte, reviewCounts [0]) : consigne ; revue 1 et UX : vide', () => {
    const l = (reviewCounts?: number[]) => ({ reviewCounts, constats: [], proposals: [] }) as unknown as LotState;
    expect(convergeBrief('review-small', l([0]))).toContain('inchange: true');
    expect(convergeBrief('review', l([0]))).toContain('inchange: true');
    expect(convergeBrief('review', l([]))).toBe('');
    expect(convergeBrief('review', l())).toBe('');
    expect(convergeBrief('ux', l([1]))).toBe('');
  });
  it('R3 — les trois gabarits de revue de code portent {{converge}} ; la revue courte après la passe des mineurs (review-recheck) demande la marque et montre les mineurs confiés', async () => {
    const t = loadTemplates();
    for (const k of ['review', 'review-small', 'review-recheck'] as const) expect(t[k], k).toContain('{{converge}}');
    const minor = { gravite: 'mineur', texte: 'nommage', fichier: 'a.txt', ligne: 1 };
    const h = harness({ script: { implement: [impl], review: [() => claudeOut(reviewReport({ mineurs: 1, constats: [minor] }))], fix: [fix('b.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small']);
    const small = h.calls.find((x) => x.kind === 'review-small')!.brief;
    expect(small).toContain('short re-review');
    expect(small).toContain('inchange: true');
    expect(small).toContain('- [mineur] a.txt:1 — nommage');
  });
});

describe('R4 — plafond de mur : deux fois la durée attendue de l\'estimate', () => {
  const step = (started: string, ended?: string): StepState => ({ n: 1, kind: 'implement', model: 'sonnet', status: ended ? 'done' : 'running', started, ended } as StepState);
  const t0 = Date.parse('2026-11-05T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();

  it('R4 — la durée attendue est celle de workTimeoutMs : 45 min à 0,25 j, le double à 0,5 j, bornée à 4 fois ; le plafond en est le double', () => {
    expect(wallCapMs(45 * 60_000, 0.25, false)).toBe(90 * 60_000);
    expect(wallCapMs(45 * 60_000, 0.5, false)).toBe(180 * 60_000);
    expect(wallCapMs(45 * 60_000, 10, false)).toBe(360 * 60_000);
    expect(wallCapMs(45 * 60_000, undefined, false)).toBe(90 * 60_000);
  });
  it('R4 — le mur est la somme des durées des étapes : une pause entre deux étapes (lot suspendu) ne compte pas, une étape en cours compte jusqu\'à maintenant', () => {
    expect(lotWallMs([step(at(0), at(10)), step(at(1000), at(1020))], t0)).toBe(30 * 60_000);
    expect(lotWallMs([step(at(0), at(10)), step(at(20))], t0 + 25 * 60_000)).toBe(15 * 60_000);
    expect(lotWallMs([], t0)).toBe(0);
    expect(lotWallMs([step('pas une date', at(5))], t0)).toBe(0);
  });
  it('R4 — une étape interrompue (Ctrl-C, reprise après crash : sans fin, status interrupted) compte pour 0, comme dans le tableau : la nuit avant --resume n\'est pas du mur', () => {
    const interrupted = { ...step(at(0)), status: 'interrupted' } as StepState;
    expect(lotWallMs([interrupted], t0 + 12 * 60 * 60_000)).toBe(0);
    expect(lotWallMs([interrupted, step(at(0), at(10))], t0 + 12 * 60 * 60_000)).toBe(10 * 60_000);
  });

  const ctxOf = (over: Partial<LotState>): LotCtx =>
    ({ wave: { id: 'W2', store: { writeLot: () => {} }, log: () => {} }, lot: { project: 'a', lot: 'L1', repo: '/x/a', status: 'handed-back', next: 'fix', pass: 2, steps: [], answers: [], questions: [], warnings: [], constats: [], proposals: [], budget: 100, estimate: 0.25, ...over }, config: { timeouts: { work: 45 * 60_000 } }, loadPlan: () => ({ lot: () => ({ visible: false }) }) }) as unknown as LotCtx;
  it('R4 — un lot rendu au plafond de mur (110 min sur 90) repris par --add : le mur repart de zéro comme les passes, la correction est jouée au lieu d\'un second rendu', () => {
    const code = { source: 'code', gravite: 'majeur', fichier: 'f.ts', ligne: 1, texte: 'à corriger' } as const;
    const old = ctxOf({ steps: [step(at(0), at(60)), step(at(70), at(120))], constats: [code], outcome: 'revue non conforme après 0 passe(s) de correction ; plafond de mur : 110 min sur 90 (2 × la durée attendue de l\'estimate), le lot est rendu avec ses constats au lieu d\'une passe de plus' });
    expect(wallReason(old, t0 + 130 * 60_000)).toMatch(/^plafond de mur : 110 min sur 90/);
    const fresh = ctxOf({ status: 'queued', next: null, outcome: null, pass: 0 });
    expect(resumeNext(fresh, old)).toBe('correction');
    expect(fresh.lot.status).toBe('queued');
    expect(fresh.lot.next).toBe('fix');
    expect(fresh.lot.outcome).toBeNull();
    expect(fresh.lot.pass).toBe(1);
    expect(fresh.lot.steps).toHaveLength(2);
    expect(wallReason(fresh, t0 + 130 * 60_000)).toBeUndefined();
    // les étapes de la reprise comptent, elles : 100 min de plus et le plafond joue de nouveau
    fresh.lot.steps.push(step(at(200), at(300)));
    expect(wallReason(fresh, t0 + 310 * 60_000)).toMatch(/^plafond de mur : 100 min sur 90/);
  });

  const slow = (minutes: number): Handler => (call) => {
    const c = cOf.current!;
    c.lot.steps[c.lot.steps.length - 1]!.started = new Date(Date.now() - minutes * 60_000).toISOString();
    return impl(call);
  };
  const cOf: { current?: ReturnType<ReturnType<typeof harness>['lot']> } = {};

  it("R4 — un lot de 1 j (plafond 360 min) qui a mis 400 min avant sa première revue non conforme est rendu avec ses constats, sans passe de correction", async () => {
    const h = harness({ script: { implement: [slow(400)], review: [first], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { estimate: 1 });
    cOf.current = c;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/^revue non conforme après 0 passe\(s\) de correction ; plafond de mur : 4\d\d min sur 360/);
    expect(c.lot.constats.map((k) => k.texte)).toEqual(['premier défaut']);
  });
  it('R4 — sous le plafond (300 min sur 360) la passe de correction est lancée', async () => {
    const h = harness({ script: { implement: [slow(300)], review: [first, ok], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { estimate: 1 });
    cOf.current = c;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.status).not.toBe('handed-back');
  });
  it("R4 — un bloquant passé le plafond est rendu aussi : le plafond borne le mur, la passe d'un bloquant n'y échappe pas", async () => {
    const h = harness({ script: { implement: [slow(400)], review: [rev([{ gravite: 'bloquant', texte: 'sécurité' }])], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { estimate: 1 });
    cOf.current = c;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('handed-back');
  });
});
