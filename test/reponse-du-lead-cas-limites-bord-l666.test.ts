import { describe, expect, it } from 'vitest';
import { keepPrecheckReading, PRECHECK_LU_MAX } from '../src/orchestrate/precheck.js';

// L666 : les cas limites sont en fin de `lu` ; une lecture longue ne doit pas les perdre avant qu'ils arrivent à la spec.
describe('L666 — bord : lecture du precheck longue', () => {
  it('R2 — la ligne « Edge cases of the rule: » en fin de `lu` survit à la troncature de PRECHECK_LU_MAX', () => {
    const lu = `${Array.from({ length: 200 }, (_, i) => `src/fichier${i}.ts:${i} — voisin à imiter`).join('\n')}\nEdge cases of the rule:\n- absent base: not decided\n- lossless copy on the source side: src/a.ts:1`;
    expect(lu.length).toBeGreaterThan(PRECHECK_LU_MAX);
    const lot = { warnings: [] as string[], precheckLu: undefined as string | undefined };
    keepPrecheckReading(lot, lu);
    expect(lot.precheckLu).toContain('Edge cases of the rule:');
    expect(lot.precheckLu).toContain('lossless copy on the source side');
  });
});
