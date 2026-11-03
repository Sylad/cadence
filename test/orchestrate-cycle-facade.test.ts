import { describe, expect, it } from 'vitest';
import * as facade from '../src/orchestrate/cycle.js';
import * as budget from '../src/orchestrate/cycle/budget.js';
import * as brief from '../src/orchestrate/cycle/brief.js';
import * as ctx from '../src/orchestrate/cycle/ctx.js';
import * as planWrites from '../src/orchestrate/cycle/plan-writes.js';
import * as checks from '../src/orchestrate/cycle/checks.js';
import * as precheckStep from '../src/orchestrate/cycle/precheck-step.js';
import * as questions from '../src/orchestrate/cycle/questions.js';

/** Découpages C1a (L490) et C1c (L492) : `cycle.ts` reste le point d'entrée des tests et des autres modules, il ré-exporte ce qui a bougé dans `cycle/`. */
describe('orchestrate/cycle.ts, façade de ré-export (C1a)', () => {
  it('ctx — les contextes et leurs constantes sortent de cycle.ts sans changer d\'identité', () => {
    expect(facade.Budget).toBe(ctx.Budget);
    expect(facade.workDir).toBe(ctx.workDir);
    expect(facade.countInterrupted).toBe(ctx.countInterrupted);
    expect([facade.MAX_PASSES, facade.MAX_PASSES_CONVERGING]).toEqual([2, 3]);
  });

  it('budget — les réserves et les causes d\'arrêt sortent de cycle.ts', () => {
    expect(facade.lotSpent).toBe(budget.lotSpent);
    expect(facade.budgetStep).toBe(budget.budgetStep);
    expect(facade.heldForEscalation).toBe(budget.heldForEscalation);
    expect([facade.REVIEW_RESERVE, facade.ESCALATION_RESERVE]).toEqual([budget.REVIEW_RESERVE, budget.ESCALATION_RESERVE]);
    expect([facade.STOP_REQUESTED, facade.DROPPED]).toEqual([budget.STOP_REQUESTED, budget.DROPPED]);
  });

  it('brief et plan-writes — le nom du gabarit et les rendus au lead sortent de cycle.ts', () => {
    expect(facade.briefName).toBe(brief.briefName);
    expect(facade.planNoteHandBack).toBe(planWrites.planNoteHandBack);
    expect(facade.leadReviewedHandBack).toBe(planWrites.leadReviewedHandBack);
    expect(facade.HYPOTHESES_HANDBACK).toBe(planWrites.HYPOTHESES_HANDBACK);
  });

  it('étapes (C1c) — le contrôle préalable, l\'extrait rouge et les questions non bloquantes sortent de cycle.ts sans changer d\'identité', () => {
    expect(facade.needsPrecheck).toBe(precheckStep.needsPrecheck);
    expect(facade.redExcerpt).toBe(checks.redExcerpt);
    expect(facade.isNonQuestion).toBe(questions.isNonQuestion);
    expect(facade.handBackDroppedQuestions).toBe(questions.handBackDroppedQuestions);
    expect(typeof facade.runLot).toBe('function');
  });
});
