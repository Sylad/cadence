import { describe, expect, it } from 'vitest';

const { deliveriesOf } = (await import(new URL('../plugins/cadence-hud/hooks/deliveries.ts', import.meta.url).href)) as { deliveriesOf: (last: never[], board: unknown, at: number) => { undelivered: string[] }[] };
const { parseLotsBoard } = (await import(new URL('../plugins/cadence-hud/hooks/lots.ts', import.meta.url).href)) as { parseLotsBoard: (stdout: string) => unknown };

describe('probe L530 — panneau HUD', () => {
  const NOW = Date.parse('2026-11-04T10:00:00Z');
  const last = { project: 'p', sha: 'abcdef1234', day: '2026-10-30', status: 'verte', green: '2026-10-30' } as never;
  it('delivered non booléen (« true », 1, objet) est ignoré par parseLotsBoard', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [{ id: 'A', finished: '2026-11-01', delivered: 'true' }, { id: 'B', finished: '2026-11-01', delivered: 1 }, { id: 'C', finished: '2026-11-01', delivered: {} }] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual(['A', 'B', 'C']);
  });
  it('delivered: true sur un lot sans livraison dans les sorties : pas de plantage, closed vide → []', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual([]);
  });
  it('closed doublon (même id deux fois, un livré un non) : l’id non livré reste signalé', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [{ id: 'A', finished: '2026-11-01', delivered: true }, { id: 'A', finished: '2026-11-02' }] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual(['A']);
  });
  it('closed entrée null / non-objet : ignorée sans exception', () => {
    expect(() => parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [null, 3, 'x', { id: 'A', finished: '2026-11-01', delivered: true }] }]))).not.toThrow();
  });
});
