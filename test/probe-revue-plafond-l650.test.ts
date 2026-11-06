import { describe, expect, it } from 'vitest';
import { toFix } from '../src/orchestrate/cycle/review.js';
import { MAX_PASSES } from '../src/orchestrate/cycle/ctx.js';
import { harness } from './orchestrate-harness.js';
import type { Constat } from '../src/orchestrate/state.js';

// Sonde L650 : bords de la borne des passes de fix d'un lot de revue (`spec: revue`).
const k = (texte: string): Constat => ({ source: 'code', gravite: 'majeur', texte });

describe('L650 — bornes d’un lot de revue (sonde)', () => {
  it('tests rouges au plafond : un lot de revue est rendu sans escalade', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES, revueLot: true });
    c.config.escalation = { model: 'fable' };
    toFix(c, [k('x')], 'tests rouges');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.escalation).toBeUndefined();
    expect(c.lot.pass).toBe(MAX_PASSES);
  });
  it('revue qui converge à pass = MAX_PASSES + 1 (état repris) : un lot de revue est rendu, jamais une 4e passe', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES + 1, reviewCounts: [3, 1], revueLot: true });
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.pass).toBe(MAX_PASSES + 1);
  });
  it('une escalade déjà engagée sur un lot de revue : rendu au plafond, sans nouvelle passe', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES, revueLot: true, escalation: { model: 'fable', stage: 'fix', issue: 'conforme' } as never });
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.pass).toBe(MAX_PASSES);
  });
  it('un lot de revue qui converge sous le plafond ne perd pas ses passes ordinaires (pass 0 → 1)', () => {
    const c = harness({ script: {} }).lot('L1', { pass: 0, reviewCounts: [3, 1], revueLot: true });
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.next).toBe('fix');
  });
});
