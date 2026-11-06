import { describe, expect, it } from 'vitest';
import { countReview } from '../src/orchestrate/cycle/converge.js';
import { decisionsOf, ecarteCounts, ecarteLines } from '../src/perf-constats.js';
import { harness, reviewReport } from './orchestrate-harness.js';

// L638 : bornes de la décision gardée par constat (doublons, lot rétréci, hors règle, rapport vide) et du taux par vague.
const maj = (texte: string, extra: object = {}) => ({ gravite: 'majeur', texte, ...extra });
const rapport = (constats: object[]) => JSON.parse(JSON.stringify(reviewReport({ majeurs: constats.filter((k: any) => k.gravite === 'majeur').length, constats, verdict: 'non conforme' })));
const lot = () => harness({ script: {} }).lot('L1').lot;

describe('R1 — la décision suit chaque constat, pas son texte', () => {
  it('R1 — deux constats de même texte, l’un marqué l’autre non (rang 2) : une décision chacun, dans l’ordre du rapport', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    const { decisions } = countReview(rapport([maj('même', { inchange: true }), maj('même')]), 'review', l, 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['ecarte-inchange', 'compte']);
  });
  it('R1 — rapport sans constat : aucune décision', () => {
    expect(countReview(rapport([]), 'review', lot(), 'abc').decisions).toEqual([]);
  });
  it('R1 — lot rétréci, revue 1 : le rang gardé est 2 et la marque est lue', () => {
    const { decisions } = countReview(rapport([maj('x', { inchange: true })]), 'review', lot(), 'abc', { shrunk: { goal: 'g', from: 'h' } as never });
    expect(decisions).toEqual([{ texte: 'x', gravite: 'majeur', rang: 2, decision: 'ecarte-inchange' }]);
  });
  it('R1 — revue UX : rang 1, aucun constat écarté même marqué', () => {
    const l = lot();
    l.reviewCounts = [1, 2] as never;
    const { decisions } = countReview(rapport([maj('x', { inchange: true })]), 'ux', l, 'abc');
    expect(decisions).toEqual([{ texte: 'x', gravite: 'majeur', rang: 1, decision: 'compte' }]);
  });
  it('R1 — un constat qui reprend une attente hors règle : « ecarte-hors-regle »', () => {
    const l = lot();
    l.proposals = ['[hors règle] attente inventée'];
    const { decisions } = countReview(rapport([maj('voir attente inventée ici'), { gravite: 'bloquant', texte: 'attente inventée' }]), 'review', l, 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['ecarte-hors-regle', 'compte']);
  });
  it('R1 — countReview ne modifie pas le rapport reçu', () => {
    const rep = rapport([maj('x', { inchange: true })]);
    const avant = JSON.stringify(rep);
    const l = lot();
    l.reviewCounts = [1] as never;
    countReview(rep, 'review', l, 'abc');
    expect(JSON.stringify(rep)).toBe(avant);
  });
});

describe('R2 — taux d’écartés par vague', () => {
  const d = (wave: string, decisions?: any[]) => ({ j: { wave, decisions } });
  it('R2 — deux lots de la même vague s’additionnent ; vagues triées', () => {
    const r = ecarteCounts([d('w2', ['compte']), d('w1', ['ecarte-inchange', 'compte']), d('w1', ['ecarte-inchange'])]);
    expect(r.vagues).toEqual([{ wave: 'w1', constats: 3, ecartes: 2, taux: 2 / 3 }, { wave: 'w2', constats: 1, ecartes: 0, taux: 0 }]);
    expect(r.taux).toBeCloseTo(0.5);
  });
  it('R2 — ensemble vide, décisions vides ou absentes : taux null, pas de NaN', () => {
    expect(ecarteCounts([])).toEqual({ constats: 0, ecartes: 0, taux: null, vagues: [] });
    expect(ecarteCounts([d('w1', []), d('w1')]).taux).toBeNull();
  });
  it('R2 — hors règle n’est pas compté écarté par L622', () => {
    expect(ecarteCounts([d('w1', ['ecarte-hors-regle', 'compte'])])).toMatchObject({ constats: 2, ecartes: 0 });
  });
  it('R2 — decisionsOf : absent, vide, entrée null ou de mauvais type', () => {
    expect(decisionsOf([])).toEqual([]);
    expect(decisionsOf([{}, { constatsRevue: [] }, { constatsRevue: { decision: 'compte' } }, { constatsRevue: [null, 3, 'compte', { decision: 'constructor' }, { decision: 'compte' }] }])).toEqual(['compte']);
  });
  it('R2 — ecarteLines : vide sans constat ; « n/d » sans précédente', () => {
    const p = (v: number) => `${Math.round(v * 100)} %`;
    expect(ecarteLines(ecarteCounts([]), ecarteCounts([]), p)).toEqual([]);
    expect(ecarteLines(ecarteCounts([d('w1', ['compte'])]), ecarteCounts([]), p).join('\n')).toContain('précédente n/d');
  });
});
