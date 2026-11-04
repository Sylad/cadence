import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_RESERVE, runLot } from '../src/orchestrate/cycle.js';
import { readOrchestrateConfig } from '../src/config.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const finding = (gravite: 'bloquant' | 'majeur', n: number) => ({ gravite, fichier: 'a.txt', ligne: n, texte: `constat ${n}` });
const nonConforme = (...constats: ReturnType<typeof finding>[]): Handler => () =>
  claudeOut(reviewReport({ bloquants: constats.filter((k) => k.gravite === 'bloquant').length, majeurs: constats.filter((k) => k.gravite === 'majeur').length, constats, verdict: 'non conforme' }));
const conforme: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Chaque session compte 1 500 tokens dans le harnais : après implement, review, fix, review = 6 000. Le budget qui refuse la seconde correction de 1 token. */
const SPENT_BEFORE_2ND_FIX = 6_000;
const REFUSING = SPENT_BEFORE_2ND_FIX + REVIEW_RESERVE;

/** Deux majeurs puis un seul : la revue converge. */
const converging = (third: Handler = conforme) => ({ implement: [impl], review: [nonConforme(finding('majeur', 1), finding('majeur', 2)), nonConforme(finding('majeur', 1)), third], fix: [fix('b.txt'), fix('c.txt')] });

describe("budget de lot : prélèvement à la dernière passe (L584)", () => {
  it("R1 — une revue qui converge (0 bloquant, majeurs en baisse, 2 au plus) et un budget trop juste : la réserve est prélevée, la correction et la revue courte sont jouées", async () => {
    const h = harness({ script: converging() });
    const c = h.lot('L1', { budget: REFUSING });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).not.toBe('handed-back');
    expect(c.lot.budget).toBe(REFUSING + 1);
    expect(c.lot.budgetTopUp).toBe(1);
    expect(c.lot.warnings.join('\n')).toContain('budget du lot relevé de 1 token(s)');
  });

  it("R2 — le prélèvement ne couvre que le manque : le budget relevé paie exactement la réserve, un budget confortable n'est pas touché", async () => {
    const h = harness({ script: converging() });
    const c = h.lot('L1', { budget: 1_000_000 });
    await runLot(c);
    expect(c.lot.budget).toBe(1_000_000);
    expect(c.lot.budgetTopUp).toBeUndefined();
  });

  it("R3 — un bloquant dans la dernière revue : pas de prélèvement, le lot est rendu « correction non jouée (budget) »", async () => {
    const h = harness({ script: { ...converging(), review: [nonConforme(finding('majeur', 1), finding('majeur', 2)), nonConforme(finding('bloquant', 1)), conforme] } });
    const c = h.lot('L1', { budget: REFUSING });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
    expect(c.lot.budgetTopUp).toBeUndefined();
  });

  it("R4 — majeurs qui ne baissent pas (2 puis 2), ou une seule revue : pas de prélèvement", async () => {
    const stable = harness({ script: { ...converging(), review: [nonConforme(finding('majeur', 1), finding('majeur', 2)), nonConforme(finding('majeur', 1), finding('majeur', 2)), conforme] } });
    const a = stable.lot('L1', { budget: REFUSING });
    await runLot(a);
    expect(a.lot.outcome).toContain('correction non jouée (budget)');
    // Une seule revue : la première correction, refusée, n'a pas de « baisse » à invoquer.
    const once = harness({ script: converging() });
    const b = once.lot('L1', { budget: 3_000 + REVIEW_RESERVE });
    await runLot(b);
    expect(kinds(once)).toEqual(['implement', 'review']);
    expect(b.lot.outcome).toContain('correction non jouée (budget)');
  });

  it("R5 — plus de 2 majeurs restants, même en baisse (4 puis 3) : pas de prélèvement", async () => {
    const four = [1, 2, 3, 4].map((n) => finding('majeur', n));
    const h = harness({ script: { ...converging(), review: [nonConforme(...four), nonConforme(...four.slice(0, 3)), conforme] } });
    const c = h.lot('L1', { budget: REFUSING });
    await runLot(c);
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
  });

  it("R6 — le plafond orchestrate.budgetTopUp borne le total prélevé sur le lot : atteint, le lot est rendu ; 0 désactive", async () => {
    const reached = harness({ script: converging() });
    const a = reached.lot('L1', { budget: REFUSING, budgetTopUp: 300_000 });
    await runLot(a);
    expect(a.lot.outcome).toContain('correction non jouée (budget)');
    const off = harness({ script: converging() });
    const b = off.lot('L1', { budget: REFUSING }, { budgetTopUp: 0 });
    await runLot(b);
    expect(b.lot.outcome).toContain('correction non jouée (budget)');
    const room = harness({ script: converging() });
    const c = room.lot('L1', { budget: REFUSING, budgetTopUp: 299_999 });
    await runLot(c);
    expect(c.lot.budgetTopUp).toBe(300_000);
    expect(kinds(room)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
  });

  it("R7 — la part de l'escalade reste retenue : le prélèvement couvre le manque hors cette part", async () => {
    const h = harness({ script: converging() });
    const c = h.lot('L1', { budget: REFUSING + 175_000, escalationReserve: 175_000 }, { escalation: { model: 'fable' } });
    await runLot(c);
    expect(c.lot.budgetTopUp).toBe(1);
    expect(c.lot.budget).toBe(REFUSING + 175_000 + 1);
  });

  it("R8 — des tests rouges (passe fix sans revue) ne sont pas une revue qui converge : pas de prélèvement", async () => {
    const h = harness({ script: converging() });
    const c = h.lot('L1', { budget: 100_000, pass: 3, next: 'fix', reviewCounts: [2, 1], constats: [{ source: 'tests', gravite: 'majeur', texte: 'rouge' }] });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.budgetTopUp).toBeUndefined();
  });

  it("R9 — le budget restant de la vague doit payer la réserve : sinon le lot est rendu", async () => {
    const h = harness({ script: converging(), budget: SPENT_BEFORE_2ND_FIX + REVIEW_RESERVE - 1 });
    const c = h.lot('L1', { budget: REFUSING });
    await runLot(c);
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
    expect(c.lot.budgetTopUp).toBeUndefined();
  });

  it("R10 — orchestrate.budgetTopUp : 300000 par défaut, un entier ≥ 0, refusé sinon", () => {
    const read = (yaml: string) => {
      const f = join(tempDir(), 'cadence.yaml');
      writeFileSync(f, yaml);
      return readOrchestrateConfig(f);
    };
    expect(readOrchestrateConfig('/nope').budgetTopUp).toBe(300_000);
    expect(read('orchestrate:\n  budgetTopUp: 120000\n').budgetTopUp).toBe(120_000);
    expect(read('orchestrate:\n  budgetTopUp: 0\n').budgetTopUp).toBe(0);
    for (const bad of ['-1', '1.5', '"300k"', 'true']) expect(() => read(`orchestrate:\n  budgetTopUp: ${bad}\n`), bad).toThrow(/budgetTopUp/);
  });
});
