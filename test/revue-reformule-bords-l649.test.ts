import { describe, expect, it } from 'vitest';
import { carriedNoted, countReview } from '../src/orchestrate/cycle/converge.js';
import { harness, reviewReport } from './orchestrate-harness.js';
import type { Constat } from '../src/orchestrate/state.js';

// L649 (bords) : la reconnaissance par fichier et ligne ou classe d'un constat repris reformulé.
const k = (texte: string, extra: Partial<Constat> = {}): Constat => ({ source: 'code', gravite: 'mineur', texte, ...extra });
const lot = (counts: number[] = [1]) => {
  const l = harness({ script: {} }).lot('L1').lot;
  l.reviewCounts = counts as never;
  return l;
};
const rapport = (constats: object[], majeurs = 0) => JSON.parse(JSON.stringify(reviewReport({ majeurs, mineurs: constats.length - majeurs, constats, verdict: majeurs ? 'non conforme' : 'conforme' })));
const decisions = (l: ReturnType<typeof lot>, constats: object[], majeurs = 0, kind: 'review' | 'review-small' = 'review') => countReview(rapport(constats, majeurs), kind, l, 'abc').decisions.map((d) => d.decision);

describe('bords L649 — repris reformulé', () => {
  it('ligne 0 identique, même fichier, texte reformulé : « ecarte-deja-note »', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts', ligne: 0 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'b', fichier: 'a.ts', ligne: 0 }])).toEqual(['ecarte-deja-note']);
  });
  it('deux mineurs reformulés du même constat noté : les deux sont écartés', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'b', fichier: 'a.ts', ligne: 4 }, { gravite: 'mineur', texte: 'c', fichier: 'a.ts', ligne: 4 }])).toEqual(['ecarte-deja-note', 'ecarte-deja-note']);
  });
  it('la revue courte n’écarte rien, même reformulé sur le même fichier et la même ligne', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'b', fichier: 'a.ts', ligne: 4 }], 0, 'review-small')).toEqual(['compte']);
  });
  it('un mineur sans fichier ni ligne ni classe, texte différent : il compte', () => {
    const l = lot();
    l.codeConstats = [k('a')];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'b' }])).toEqual(['compte']);
  });
  it('un mineur noté sans ligne, rapporté avec une ligne, autre texte, sans classe : il compte', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts' })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'b', fichier: 'a.ts', ligne: 3 }])).toEqual(['compte']);
  });
  it('majeur marqué inchange, reformulé, même fichier et même classe qu’un majeur précédent, autre ligne : la marque est fausse, il compte', () => {
    const l = lot([1, 1]);
    l.codeConstats = [k('ancien', { gravite: 'majeur', fichier: 'a.ts', ligne: 1, classe: 'documentation' })];
    expect(decisions(l, [{ gravite: 'majeur', texte: 'reformulé', fichier: 'a.ts', ligne: 40, classe: 'documentation', inchange: true }], 1)).toEqual(['compte']);
  });
  it('majeur marqué inchange sur un autre fichier à la même ligne : la marque est juste, il ne compte pas', () => {
    const l = lot([1, 1]);
    l.codeConstats = [k('ancien', { gravite: 'majeur', fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'majeur', texte: 'autre', fichier: 'b.ts', ligne: 4, inchange: true }], 1)).not.toEqual(['compte']);
  });
  it('carriedNoted : un mineur noté reformulé par un autre mineur du même fichier et de la même ligne n’est pas gardé', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts', ligne: 4 })];
    expect(carriedNoted('review', l, rapport([{ gravite: 'mineur', texte: 'b', fichier: 'a.ts', ligne: 4 }])).map((c) => c.texte)).toEqual([]);
  });
  it('carriedNoted : la revue courte ne garde rien', () => {
    const l = lot();
    l.codeConstats = [k('a', { fichier: 'a.ts', ligne: 4 })];
    expect(carriedNoted('review-small', l, rapport([]))).toEqual([]);
  });
});
