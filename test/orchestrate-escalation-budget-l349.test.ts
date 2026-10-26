import { describe, expect, it } from 'vitest';
import { ESCALATION_RESERVE, REVIEW_RESERVE, runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const script = () => ({ implement: [impl], review: [major, major, major], fix: [fix('b.txt'), fix('c.txt')] });
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const esc = { escalation: { model: 'fable' } };

/** Tokens comptés par les `n` premières sessions du lot de référence (implement, review, fix, review, fix, review). */
async function spentAfter(n: number): Promise<number> {
  const probe = harness({ script: script() });
  const p = probe.lot('L1');
  await runLot(p);
  return p.lot.steps.slice(0, n).reduce((t, s) => t + (s.tokens?.counted ?? 0), 0);
}

describe('budget de lot : la part de l\'escalade est réservée (L349)', () => {
  it("R1 — l'escalade déclarée joue sur un lot qui a consommé presque tout le budget de ses passes : sa part est ajoutée au budget, pas prélevée sur lui", async () => {
    const spent = await spentAfter(6);
    // Budget = ce que les deux passes ont coûté + la réserve d'une correction et de sa revue + la part d'escalade déjà ajoutée par lotBudget.
    const h = harness({ script: { ...script(), fix: [fix('b.txt'), fix('c.txt'), fix('d.txt')], review: [major, major, major, major] } });
    const c = h.lot('L1', { budget: spent + REVIEW_RESERVE + ESCALATION_RESERVE, escalationReserve: ESCALATION_RESERVE }, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.escalation).toMatchObject({ model: 'fable', issue: 'rendu' });
  });

  it("R2 — les passes ordinaires ne dépensent pas la part de l'escalade : une correction qui n'entrerait que grâce à elle est refusée", async () => {
    const before2ndFix = await spentAfter(4);
    const h = harness({ script: script() });
    // Sans la part retenue, la seconde correction serait payée (spent + 155 k < budget) ; avec elle, il reste moins de 155 k.
    const c = h.lot('L1', { budget: before2ndFix + REVIEW_RESERVE + ESCALATION_RESERVE - 1, escalationReserve: ESCALATION_RESERVE }, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
  });

  it("R3 — sans part déclarée (aucune escalade configurée, lot d'une vague antérieure), le budget borne comme avant", async () => {
    const before2ndFix = await spentAfter(4);
    const h = harness({ script: script() });
    const c = h.lot('L1', { budget: before2ndFix + REVIEW_RESERVE + ESCALATION_RESERVE - 1 });
    await runLot(c);
    expect(kinds(h).slice(0, 6)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
  });
});
