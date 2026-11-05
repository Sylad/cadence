import { describe, expect, it } from 'vitest';

// Le mod est hors du typecheck de cadence : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { foldText, foldWave } = (await import(new URL('../plugins/cadence-hud/hooks/lots.ts', import.meta.url).href)) as {
  foldText: (livres: number, clos: number) => string;
  foldWave: <T extends { project: string; lot: string }>(board: unknown, lots: readonly T[]) => { open: T[]; livres: number; clos: number };
};

const board = (closed: { id: string; finished: string; delivered?: true }[] | undefined, outdated = false) => ({
  outdated,
  rows: [{ project: 'alpha', ...(closed ? { closed } : {}) }],
});
const lots = [
  { project: 'alpha', lot: 'L1' },
  { project: 'alpha', lot: 'L2' },
  { project: 'alpha', lot: 'L3' },
];

describe('L601 — la ligne d\'une vague finie compte les lots clos au plan, ne les dit pas « prêts »', () => {
  it('foldText : zéros → vide ; un seul côté ; les deux séparés par « · »', () => {
    expect(foldText(0, 0)).toBe('');
    expect(foldText(3, 0)).toBe('livrés : 3');
    expect(foldText(0, 1)).toBe('clos non livrés : 1');
    expect(foldText(3, 1)).toBe('livrés : 3 · clos non livrés : 1');
  });

  it('foldWave : tableau absent (null) ou périmé → tous ouverts, rien de compté clos', () => {
    expect(foldWave(null, lots)).toEqual({ open: lots, livres: 0, clos: 0 });
    expect(foldWave(board([{ id: 'L1', finished: 'x' }], true), lots)).toEqual({ open: lots, livres: 0, clos: 0 });
  });

  it('foldWave : lots vides, projet absent du tableau, ligne sans `closed`', () => {
    expect(foldWave(board([{ id: 'L1', finished: 'x' }]), [])).toEqual({ open: [], livres: 0, clos: 0 });
    const autre = [{ project: 'beta', lot: 'L1' }];
    expect(foldWave(board([{ id: 'L1', finished: 'x' }]), autre)).toEqual({ open: autre, livres: 0, clos: 0 });
    expect(foldWave(board(undefined), lots)).toEqual({ open: lots, livres: 0, clos: 0 });
  });

  it('foldWave : livré, clos non livré et ouvert se séparent ; le total est conservé', () => {
    const r = foldWave(board([{ id: 'L1', finished: 'x', delivered: true }, { id: 'L2', finished: 'x' }]), lots);
    expect(r).toEqual({ open: [lots[2]], livres: 1, clos: 1 });
    expect(r.open.length + r.livres + r.clos).toBe(lots.length);
  });

  it('foldWave : un même lot cité deux fois dans la vague est compté deux fois, sans perte', () => {
    const r = foldWave(board([{ id: 'L1', finished: 'x' }]), [lots[0], lots[0]]);
    expect(r.open.length + r.livres + r.clos).toBe(2);
  });
});
