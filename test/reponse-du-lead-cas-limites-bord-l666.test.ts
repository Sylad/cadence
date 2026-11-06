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

  it('R2 — une section des cas limites plus longue que PRECHECK_LU_MAX est coupée à la taille permise, son début gardé', () => {
    const lu = `src/a.ts:1 — voisin\nEdge cases of the rule:\n${'- cas limite décidé ici: src/b.ts:2\n'.repeat(200)}`;
    const lot = { warnings: [] as string[], precheckLu: undefined as string | undefined };
    keepPrecheckReading(lot, lu);
    expect(lot.precheckLu!.length).toBeLessThanOrEqual(PRECHECK_LU_MAX);
    expect(lot.precheckLu!.startsWith('Edge cases of the rule:')).toBe(true);
  });

  it('R2 — la lecture longue et sa section gardée tiennent dans PRECHECK_LU_MAX, marqueur compris', () => {
    const lu = `${'x'.repeat(5000)}\nEdge cases of the rule:\n- empty: not decided`;
    const lot = { warnings: [] as string[], precheckLu: undefined as string | undefined };
    keepPrecheckReading(lot, lu);
    expect(lot.precheckLu!.length).toBeLessThanOrEqual(PRECHECK_LU_MAX);
    expect(lot.precheckLu!.endsWith('Edge cases of the rule:\n- empty: not decided')).toBe(true);
  });

  // Frontière : room = PRECHECK_LU_MAX − marqueur (3990) ; une section de room − 1, room ou room + 1 caractères ne doit jamais dépasser la borne.
  for (const delta of [-2, -1, 0, 1]) {
    it(`R2 — une section finale de room ${delta >= 0 ? '+' : '−'} ${Math.abs(delta)} caractères derrière une tête de 5000 tient dans PRECHECK_LU_MAX`, () => {
      const room = PRECHECK_LU_MAX - '[…tronqué]'.length;
      const label = 'Edge cases of the rule:\n';
      const tail = `${label}${'y'.repeat(room + delta - label.length)}`;
      expect(tail.length).toBe(room + delta);
      const lot = { warnings: [] as string[], precheckLu: undefined as string | undefined };
      keepPrecheckReading(lot, `${'x'.repeat(5000)}\n${tail}`);
      expect(lot.precheckLu!.length).toBeLessThanOrEqual(PRECHECK_LU_MAX);
      expect(lot.precheckLu).toContain('Edge cases of the rule:');
    });
  }
});
