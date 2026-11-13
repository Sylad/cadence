import { describe, expect, it } from 'vitest';

// L689 (décision de Sylvain du 13-11) : plus de banc du weekend exigé ; la bande du HUD ne le réclame plus, et nomme les passages micro et mécanique.
// Les tests du mod (plugins/cadence-hud/tests) tournent sous `claude plugin test` ; celui-ci garde la règle sous vitest, avec la porte.
type Passage = { date: string; candidat: string; bancs: string[]; hebdo: boolean; vert: boolean; rouges: string[]; niveau?: string };
const { bancLine, parseBanc } = (await import(new URL('../plugins/cadence-hud/hooks/banc.ts', import.meta.url).href)) as {
  bancLine: (p: Passage[] | null, now: number) => { text: string; color: string } | null;
  parseBanc: (lignes: string[]) => Passage[];
};
const LUNDI = Date.parse('2026-11-16T10:00:00+01:00');
const ligne = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ date: '2026-11-14T09:00:00.000Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', bancs: ['1-a', '3-b', '6-c'], hebdo: false, frais: 0, vert: true, rouges: [], ...extra });

describe('bande du banc dans le HUD (L689)', () => {
  it('en semaine, sans passage hebdo depuis samedi : aucun « weekend manquant »', () => {
    expect(bancLine(parseBanc([ligne()]), LUNDI)).toEqual({ text: 'banc ✓ 14-11 court · cadence-run/A', color: 'success' });
    expect(bancLine(parseBanc([ligne({ vert: false, rouges: ['temps total'] })]), LUNDI)).toEqual({ text: 'banc ✗ 14-11 : temps total', color: 'error' });
  });
  it('le banc mécanique du samedi se nomme « mécanique », pas « court »', () => {
    expect(bancLine(parseBanc([ligne({ niveau: 'mecanique' })]), LUNDI)?.text).toBe('banc ✓ 14-11 mécanique · cadence-run/A');
    expect(bancLine(parseBanc([ligne({ niveau: 'micro', bancs: ['1-a'] })]), LUNDI)?.text).toBe('banc ✓ 14-11 micro · cadence-run/A');
  });
});
