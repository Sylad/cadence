import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepEuros } from '../src/cost.js';
import { estimateLines } from '../src/orchestrate/cout.js';
import type { LotState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

// Revue L704 r1, majeur : l'estimation de --dry-run chiffre le budget du lot (entrée + écriture de cache + sortie) avec la grille de cadence cost et de perf :
// l'entrée hors cache est négligée comme dans cadence cost, la part non-sortie est payée au prix d'écriture de cache.
const lotOf = (budget: number): LotState => ({ project: 'a', lot: 'L1', model: 'sonnet', budget }) as unknown as LotState;
function linesWith(grid: string, budget: number) {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), `perf:\n  currency: €\n  prices:\n    sonnet: ${grid}\n`);
  const warned: string[] = [];
  return { lines: estimateLines([lotOf(budget)], dir, (w) => warned.push(w)), warned };
}

describe('L704 — orchestrate --dry-run chiffre la part de cache du budget au prix d\'écriture', () => {
  it('cacheWrite déclaré : 800 000 tokens sonnet = 0,72 M × 6 + 0,08 M × 15 = 5,52 €, pas les 3,36 € du prix d\'entrée', () => {
    const { lines, warned } = linesWith('{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 }', 800_000);
    expect(lines[0]).toBe('a:L1 — estimation du lot : 5,52 € (budget de 800000 tokens au prix sonnet, 90 % en écriture de cache)');
    expect(lines[1]).toMatch(/^estimation de la vague : 5,52 €/);
    expect(warned).toEqual([]);
  });

  it('cacheWrite absent : le prix par défaut de la grille (entrée × 2), avec l\'avertissement de perf et cadence cost', () => {
    const { lines, warned } = linesWith('{ input: 3, output: 15, cacheRead: 0.3 }', 800_000);
    expect(lines[0]).toContain('estimation du lot : 5,52 €');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('sans cacheWrite pour sonnet');
  });

  it('le prix d\'écriture suit la grille : cacheWrite 3,75 (cache de cinq minutes) donne 0,72 × 3,75 + 1,2 = 3,90 €', () => {
    expect(linesWith('{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }', 800_000).lines[0]).toContain('estimation du lot : 3,90 €');
  });

  it('un journal qui ne porte que counted est chiffré comme les quatre compteurs qu\'il résume : 90 % écrits, 10 % en sortie', () => {
    const prices = { sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 } };
    const fromCounted = stepEuros({ model: 'sonnet', counted: 1e6 }, prices);
    const fromUsage = stepEuros({ model: 'sonnet', usage: { input: 0, cacheWrite: 9e5, cacheRead: 0, output: 1e5 } }, prices);
    expect(fromCounted).toBeCloseTo(fromUsage as number, 12);
    expect(fromCounted).toBeCloseTo(6.9, 12);
  });
});
