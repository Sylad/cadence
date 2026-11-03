import { describe, expect, it, vi } from 'vitest';
import { awaitsDependency } from '../src/orchestrate/pool.js';
import { setGate } from '../src/orchestrate/cycle/ctx.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import type { LotState } from '../src/orchestrate/state.js';

// L520 — bords de awaitsDependency et setGate.
const lot = (o: Partial<LotState>): LotState => ({ project: 'a', lot: 'L1', status: 'queued', steps: [], dependsOn: [], ...o }) as LotState;
const ctx = (o: Partial<LotState>): LotCtx => ({ lot: lot(o) }) as unknown as LotCtx;

describe('L520 sonde — awaitsDependency', () => {
  it('dependsOn absent : n’attend pas', () => {
    const c = ctx({ dependsOn: undefined });
    expect(awaitsDependency(c, [c], [])).toBe(false);
  });
  it('dépendance prête dans ctxs : n’attend pas', () => {
    const d = ctx({ lot: 'L0', status: 'ready' });
    const c = ctx({ dependsOn: ['L0'] });
    expect(awaitsDependency(c, [d, c], [])).toBe(false);
  });
  it('dépendance prête seulement dans known : n’attend pas', () => {
    const c = ctx({ dependsOn: ['L0'] });
    expect(awaitsDependency(c, [c], [lot({ lot: 'L0', status: 'ready' })])).toBe(false);
  });
  it('dépendance inconnue : attend', () => {
    const c = ctx({ dependsOn: ['L0'] });
    expect(awaitsDependency(c, [c], [])).toBe(true);
  });
  it('même numéro de lot dans un autre projet : ne compte pas', () => {
    const c = ctx({ dependsOn: ['L0'] });
    expect(awaitsDependency(c, [c], [lot({ project: 'b', lot: 'L0', status: 'ready' })])).toBe(true);
  });
  it('une dépendance sur soi-même attend (ne se débloque pas seule)', () => {
    const c = ctx({ dependsOn: ['L1'] });
    expect(awaitsDependency(c, [c], [])).toBe(true);
  });
  it('lot suspendu sans étape : attend ; avec une étape : n’attend plus', () => {
    expect(awaitsDependency(ctx({ status: 'suspended', dependsOn: ['L0'] }), [], [])).toBe(true);
    expect(awaitsDependency(ctx({ status: 'suspended', dependsOn: ['L0'], steps: [{}] as never }), [], [])).toBe(false);
  });
  it('lot en cours (running) avec dépendance non prête : n’attend pas (il joue)', () => {
    expect(awaitsDependency(ctx({ status: 'running' as never, dependsOn: ['L0'] }), [], [])).toBe(false);
  });
  it('dépendance en échec : le lot est compté comme attendant (aucune session ne jouera)', () => {
    const c = ctx({ dependsOn: ['L0'] });
    expect(awaitsDependency(c, [c], [lot({ lot: 'L0', status: 'failed' })])).toBe(true);
  });
});

describe('L520 sonde — setGate', () => {
  it('écrit, sauve puis prévient, même quand la porte est vidée', () => {
    const order: string[] = [];
    const c = { lot: lot({}), wave: { store: { writeLot: () => order.push('save') }, slotsChanged: () => order.push('notify') } } as unknown as LotCtx;
    setGate(c, { label: 'tests', started: 'x' });
    setGate(c, undefined);
    expect(c.lot.gate).toBeUndefined();
    expect(order).toEqual(['save', 'notify', 'save', 'notify']);
  });
  it('slotsChanged absent : pas d’erreur', () => {
    const c = { lot: lot({}), wave: { store: { writeLot: vi.fn() } } } as unknown as LotCtx;
    expect(() => setGate(c, undefined)).not.toThrow();
  });
});
