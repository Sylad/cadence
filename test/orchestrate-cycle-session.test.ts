import { describe, expect, it } from 'vitest';
import { badReport, dirtBetween } from '../src/orchestrate/cycle/session.js';
import { summarize, type ReviewReport } from '../src/orchestrate/schemas.js';
import type { Snapshot } from '../src/orchestrate/guard.js';

/** Découpage C1b (L491) : `session` et ses gardes vivent dans `cycle/session.ts`, `summarize` dans `schemas.ts`. */
const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: ' ok ', ...over });
const snap = (tracked: string[], untracked: string[]): Snapshot => ({ head: 'h', tracked, untracked, upstream: null, upstreamRef: null, branch: 'b', reflog: 0, remote: null, guard: false });

describe('summarize — les totaux d\'un rapport ne sont pas crus sur parole', () => {
  it('un constat majeur compte même si le total annoncé dit 0, et le lot n\'est pas conforme', () => {
    const s = summarize(report({ constats: [{ gravite: 'majeur', texte: 'x' }, { gravite: 'bloquant', texte: 'y' }, { gravite: 'mineur', texte: 'z' }] }), 'abc');
    expect([s.bloquants, s.majeurs, s.mineurs, s.conforme]).toEqual([1, 1, 1, false]);
  });

  it('le plus grand de l\'annoncé et du lisible est retenu, le verdict est rogné, le HEAD est repris', () => {
    const s = summarize(report({ majeurs: 3, constats: [{ gravite: 'majeur', texte: 'x' }] }), 'abc');
    expect([s.majeurs, s.verdict, s.head, s.conforme]).toEqual([3, 'ok', 'abc', false]);
  });

  it('un rapport sans constat ni total est conforme ; repoHeads n\'apparaît qu\'avec des dépôts voisins', () => {
    expect(summarize(report(), 'h')).toMatchObject({ conforme: true });
    expect('repoHeads' in summarize(report(), 'h')).toBe(false);
    expect(summarize(report(), 'h', { '../voisin': 'v1' }).repoHeads).toEqual({ '../voisin': 'v1' });
  });
});

describe('dirtBetween — chemins salis entre deux relevés', () => {
  it('les suivis modifiés (renommage et guillemets compris) et seuls les non-suivis apparus pendant la session', () => {
    const before = snap([], ['vieux.txt']);
    const after = snap([' M a.ts', 'R  ancien.ts -> nouveau.ts', ' M "b c.ts"'], ['vieux.txt', 'neuf.txt']);
    expect(dirtBetween(before, after)).toEqual(['a.ts', 'nouveau.ts', 'b c.ts', 'neuf.txt']);
  });
});

describe('badReport — un rapport illisible fait échouer le pas et le lot', () => {
  it('le pas est « failed » avec la cause, le lot est rendu en échec', () => {
    const lot = { project: 'p', lot: 'L1', status: 'running', next: 'x', outcome: undefined, warnings: [] } as never;
    const c = { lot, wave: { log: () => {}, store: { writeLot: () => {} } } } as never;
    const step = { kind: 'work', status: 'running' } as never;
    expect(badReport(c, step, new Error('forme'))).toBeNull();
    expect(step).toMatchObject({ status: 'failed', cause: 'forme' });
    expect(lot).toMatchObject({ status: 'failed', outcome: 'work : forme', next: null });
  });
});
