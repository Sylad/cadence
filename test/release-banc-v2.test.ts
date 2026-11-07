import { describe, expect, it } from 'vitest';
import { gardeBancV2 } from '../src/release.js';

// Refonte du 07-11 (docs/v2/2026-11-07-cadence-2-design.md §4.1) : aucune 2.x sans banc vert sur l'empreinte publiée.
describe('garde de publication 2.x', () => {
  it('1.62.2 : pas de banc demandé (v1 gelée, correctifs)', () => {
    expect(() => gardeBancV2('1.62.2', () => ({ code: 1, sortie: '' }))).not.toThrow();
  });
  it('2.0.0 sans banc vert : refus, avec la raison', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 1, sortie: 'aucun banc vert sur l\'empreinte e1' }))).toThrow(/banc vert.*e1/s);
  });
  it('2.0.0 avec banc vert : permis', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 0, sortie: 'banc vert' }))).not.toThrow();
  });
});
