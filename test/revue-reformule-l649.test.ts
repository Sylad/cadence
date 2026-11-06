import { describe, expect, it } from 'vitest';
import { carriedNoted, countReview } from '../src/orchestrate/cycle/converge.js';
import { harness, reviewReport } from './orchestrate-harness.js';
import type { Constat } from '../src/orchestrate/state.js';

// L649 : un constat repris reformulé est reconnu par son fichier et sa ligne (ou sa classe), pas seulement par son texte.
const k = (texte: string, extra: Partial<Constat> = {}): Constat => ({ source: 'code', gravite: 'mineur', texte, ...extra });
const lot = () => {
  const l = harness({ script: {} }).lot('L1').lot;
  l.reviewCounts = [1] as never;
  return l;
};
const rapport = (constats: object[], majeurs = 0) => JSON.parse(JSON.stringify(reviewReport({ majeurs, mineurs: constats.length - majeurs, constats, verdict: majeurs ? 'non conforme' : 'conforme' })));
const decisions = (l: ReturnType<typeof lot>, constats: object[], majeurs = 0) => countReview(rapport(constats, majeurs), 'review', l, 'abc').decisions.map((d) => d.decision);

describe('R1 — un mineur noté repris reformulé, même fichier et même ligne, ne compte pas', () => {
  it('R1 — texte reformulé, même fichier, même ligne : « ecarte-deja-note »', () => {
    const l = lot();
    l.codeConstats = [k('nom trompeur', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'le nom induit en erreur', fichier: 'a.ts', ligne: 4 }])).toEqual(['ecarte-deja-note']);
  });
  it('R1 — même fichier, autre ligne, sans classe : un mineur neuf, il compte', () => {
    const l = lot();
    l.codeConstats = [k('nom trompeur', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'autre chose', fichier: 'a.ts', ligne: 9 }])).toEqual(['compte']);
  });
  it('R1 — même ligne dans un autre fichier : un mineur neuf, il compte', () => {
    const l = lot();
    l.codeConstats = [k('nom trompeur', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'autre', fichier: 'b.ts', ligne: 4 }])).toEqual(['compte']);
  });
  it('R1 — sans fichier, ni ligne ni classe ne rapprochent deux textes différents', () => {
    const l = lot();
    l.codeConstats = [k('un', { ligne: 4, classe: 'documentation' })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'deux', ligne: 4, classe: 'documentation' }])).toEqual(['compte']);
  });
});

describe('R2 — la classe rapproche aussi un constat reformulé du même fichier', () => {
  it('R2 — même fichier et même classe, texte reformulé, ligne absente : « ecarte-deja-note »', () => {
    const l = lot();
    l.codeConstats = [k('doc périmée', { fichier: 'README.md', classe: 'documentation' })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'le README ne dit plus la vérité', fichier: 'README.md', classe: 'documentation' }])).toEqual(['ecarte-deja-note']);
  });
  it('R2 — même fichier, classe différente, autre ligne : un mineur neuf', () => {
    const l = lot();
    l.codeConstats = [k('doc périmée', { fichier: 'a.ts', ligne: 1, classe: 'documentation' })];
    expect(decisions(l, [{ gravite: 'mineur', texte: 'bug', fichier: 'a.ts', ligne: 2, classe: 'bug-code' }])).toEqual(['compte']);
  });
  it('R2 — un majeur reformulé sur le même fichier et la même ligne qu’un mineur noté compte (seul un mineur est écarté)', () => {
    const l = lot();
    l.codeConstats = [k('nom', { fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'majeur', texte: 'reformulé', fichier: 'a.ts', ligne: 4 }], 1)).toEqual(['compte']);
  });
});

describe('R3 — le mineur noté reformulé n’est pas gardé à côté du constat compté, et reste noté sinon', () => {
  it('R3 — un mineur noté repris en majeur reformulé (même fichier et ligne) n’est pas gardé en mineur noté', () => {
    const l = lot();
    l.codeConstats = [k('nom', { fichier: 'a.ts', ligne: 4 }), k('autre', { fichier: 'b.ts', ligne: 1 })];
    const rep = rapport([{ gravite: 'majeur', texte: 'reformulé', fichier: 'a.ts', ligne: 4 }], 1);
    expect(carriedNoted('review', l, rep).map((c) => c.texte)).toEqual(['autre']);
  });
  it('R3 — le mineur reformulé écarté reste dans les mineurs notés de la revue suivante', () => {
    const l = lot();
    l.codeConstats = [k('nom', { fichier: 'a.ts', ligne: 4 })];
    const { counted } = countReview(rapport([{ gravite: 'mineur', texte: 'reformulé', fichier: 'a.ts', ligne: 4 }]), 'review', l, 'abc');
    expect(counted.constats).toEqual([]);
    expect(carriedNoted('review', l, counted).map((c) => c.texte)).toEqual(['nom']);
  });
  it('R3 — la marque inchange: true d’un majeur reformulé du même fichier et de la même ligne que le constat précédent est fausse : il compte', () => {
    const l = lot();
    l.reviewCounts = [1, 1] as never;
    l.codeConstats = [k('ancien', { gravite: 'majeur', fichier: 'a.ts', ligne: 4 })];
    expect(decisions(l, [{ gravite: 'majeur', texte: 'reformulé', fichier: 'a.ts', ligne: 4, inchange: true }], 1)).toEqual(['compte']);
  });
});
