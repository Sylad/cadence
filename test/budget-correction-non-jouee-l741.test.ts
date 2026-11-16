import { describe, expect, it } from 'vitest';
import { ESCALATION_RESERVE, REVIEW_RESERVE, runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b.txt')] }));
const conforme: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const majeur = (n: number) => ({ source: 'code' as const, gravite: 'majeur', fichier: 'a.txt', ligne: n, texte: `constat ${n}` });
const spentStep = (counted: number) => ({ n: 1, kind: 'implement', model: 'sonnet', status: 'done', tokens: { counted } }) as never;

interface Cas {
  lot: string;
  spent: number;
  /** Budget du lot, part de l'escalade comprise (`budget` de l'état). */
  budget: number;
  held: number;
  reviewCounts: number[];
  majeurs: number;
  escalation?: { model: string; stage: 'fix' };
  answer?: string;
}

/**
 * Les dix lots rendus « correction non jouée (budget) » dans les journaux `.cadence/runs` du 03-11 au 07-11 (les seuls : aucune vague orchestrate depuis),
 * chiffres relevés dans la ligne `→ handed-back` et l'état du lot (`budget`, `escalationReserve`, `escalation`, `reviewCounts`). La vague 2026-11-07-0800 que
 * l'inspection du 16-11 relevait (97,6 min de reprise du lead) est L676 : 08:25:46 rendu, 10:03:23 reprise de l'intégration après le correctif du lead.
 */
const CAS: Cas[] = [
  { lot: 'cadence:L554', spent: 619_623, budget: 925_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'claude-code-codex:L38', spent: 915_112, budget: 1_225_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'cadence:L469', spent: 1_084_017, budget: 1_225_000, held: ESCALATION_RESERVE, reviewCounts: [2, 1], majeurs: 1 },
  { lot: 'cadence:L566', spent: 534_251, budget: 775_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'cadence:L470', spent: 450_752, budget: 775_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'cadence:L563', spent: 902_044, budget: 1_225_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'cadence:L579', spent: 747_906, budget: 875_000, held: ESCALATION_RESERVE, reviewCounts: [1, 2], majeurs: 2, escalation: { model: 'fable', stage: 'fix' }, answer: 'Ne modifie pas vitest.config.ts dans L579.' },
  { lot: 'cadence:L592', spent: 901_783, budget: 1_225_000, held: ESCALATION_RESERVE, reviewCounts: [3, 3], majeurs: 3 },
  { lot: 'cadence:L662', spent: 591_324, budget: 775_000, held: ESCALATION_RESERVE, reviewCounts: [1, 2], majeurs: 2 },
  { lot: 'cadence:L676', spent: 559_676, budget: 775_000, held: ESCALATION_RESERVE, reviewCounts: [2, 5], majeurs: 5 },
];

function lotOf(k: Cas, over: Partial<Cas> = {}) {
  const x = { ...k, ...over };
  const h = harness({ script: { fix: [fix], review: [conforme] } });
  const c = h.lot('L1', {
    budget: x.budget,
    escalationReserve: x.held,
    pass: x.escalation ? 3 : 2,
    next: 'fix' as const,
    reviewCounts: [...x.reviewCounts],
    steps: [spentStep(x.spent)],
    constats: Array.from({ length: x.majeurs }, (_, i) => majeur(i + 1)),
    ...(x.escalation ? { escalation: x.escalation } : {}),
    ...(x.answer ? { pendingAnswer: x.answer } : {}),
  }, { escalation: { model: 'fable' } });
  return { h, c };
}

describe('correction non jouée : la vague joue la correction que le lead reprenait à la main (L741)', () => {
  it.each(CAS)('mesure — $lot : la correction refusée hier est jouée par la vague aujourd\'hui', async (k) => {
    const { h, c } = lotOf(k);
    await runLot(c);
    expect(kinds(h)[0]).toBe('fix');
    expect(c.lot.outcome ?? '').not.toContain('correction non jouée (budget)');
  });

  it("R1 — cas L579 : escalade engagée, réponse du lead à jouer, 27 907 tokens de manque, revue qui ne converge pas : le manque est prélevé sur la vague et la réponse est jouée", async () => {
    const k = CAS.find((x) => x.lot === 'cadence:L579')!;
    const { h, c } = lotOf(k);
    await runLot(c);
    const shortfall = k.spent + REVIEW_RESERVE + 1 - k.budget;
    expect(shortfall).toBe(27_907);
    expect(kinds(h)[0]).toBe('fix');
    expect(h.calls[0]!.brief).toContain(k.answer!);
    expect(c.lot.budgetTopUp).toBe(shortfall);
    expect(c.lot.warnings.join('\n')).toContain(`budget du lot relevé de ${shortfall} token(s) à la dernière passe (la correction joue la réponse du lead)`);
  });

  it('R2 — sans réponse du lead, le même lot reste rendu « correction non jouée (budget) » : la revue ne converge pas, la part de l\'escalade est déjà libérée', async () => {
    const { h, c } = lotOf(CAS.find((x) => x.lot === 'cadence:L579')!, { answer: undefined });
    await runLot(c);
    expect(kinds(h)).toEqual([]);
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
    expect(c.lot.budgetTopUp).toBeUndefined();
  });

  it("R3 — réponse du lead à jouer et part de l'escalade qui couvre le manque : la part de l'escalade paie (L682), la vague ne prélève rien", async () => {
    const { h, c } = lotOf(CAS.find((x) => x.lot === 'cadence:L676')!, { answer: 'Les deux, dans cet ordre.' });
    await runLot(c);
    expect(kinds(h)[0]).toBe('fix');
    expect(c.lot.budgetTopUp).toBeUndefined();
    expect(c.lot.escalationReserve).toBeLessThan(ESCALATION_RESERVE);
  });

  it('R4 — le plafond orchestrate.budgetTopUp tient aussi pour la réponse du lead : au-delà, le lot est rendu comme avant', async () => {
    const k = CAS.find((x) => x.lot === 'cadence:L579')!;
    const h = harness({ script: { fix: [fix], review: [conforme] } });
    const c = h.lot('L1', { budget: k.budget, escalationReserve: k.held, escalation: k.escalation, pass: 3, next: 'fix' as const, reviewCounts: [...k.reviewCounts], steps: [spentStep(k.spent)], constats: [majeur(1), majeur(2)], pendingAnswer: k.answer }, { escalation: { model: 'fable' }, budgetTopUp: 20_000 });
    await runLot(c);
    expect(kinds(h)).toEqual([]);
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
    expect(c.lot.outcome).toContain("n'a pas été jouée");
  });
});
