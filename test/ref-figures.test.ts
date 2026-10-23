import { describe, expect, it } from 'vitest';
import { attachRegions, citedPages, indexText } from '../src/ref/figures.js';
import type { PageText } from '../src/ref/pdf.js';

const page = (n: number, ...lines: string[]): PageText => ({ n, width: 1700, height: 2200, lines: lines.map((text, i) => ({ text, x: 100, y: 100 + i * 50, l: 800, h: 30 })) });

describe("index des figures d'un texte (L261)", () => {
  it("« Figure 3 shows… » cite la figure, il ne la légende pas ; « Figure 3 Station model » la légende", () => {
    const idx = indexText([page(1, 'Figure 3 shows the model.', 'Figure 3 Station model')]);
    expect(idx.figures).toHaveLength(1);
    expect(idx.figures[0]).toMatchObject({ label: 'Figure 3', page: 1, line: 2, caption: 'Figure 3 Station model' });
    expect(idx.figures[0]!.citations.map((c) => c.line)).toEqual([1]);
  });

  it('une ligne de sommaire (points de conduite) ne légende rien', () => {
    const idx = indexText([page(1, 'Figure 1 Station model ........ 12', 'Table 4 Codes .... 13'), page(12, 'Figure 1 Station model')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 1', page: 12 }]);
  });

  it('« Fig. 2 » et « figure 2 » désignent la Figure 2, « Tableau 5 » reste un tableau', () => {
    const idx = indexText([page(1, 'Voir Fig. 2 et le tableau 5.'), page(2, 'Figure 2 Carte', 'Tableau 5 Codes')]);
    expect(idx.figures.map((f) => [f.label, f.kind, f.citations.length])).toEqual([['Figure 2', 'figure', 1], ['Tableau 5', 'table', 1]]);
    expect(idx.unresolved).toEqual([]);
  });

  it("une légende ne se cite pas elle-même, et une ligne qui nomme deux fois la figure ne compte qu'une citation", () => {
    const idx = indexText([page(1, 'Figure 1 Carte', 'Figure 1 et Figure 1 encore.')]);
    expect(idx.figures[0]!.citations).toHaveLength(1);
  });

  it('« as shown below » sur une page sans légende est un lien non résolu', () => {
    const idx = indexText([page(1, 'The result is as shown below.')]);
    expect(idx.unresolved).toEqual([{ label: 'as shown below', page: 1, extrait: 'The result is as shown below.' }]);
  });

  it('les pages à rendre en plus : celles des figures nommées depuis les pages visées', () => {
    const idx = indexText([page(1, 'Voir Figure 1.'), page(2, 'rien'), page(3, 'Figure 1 Carte', 'Voir Figure 2.'), page(4, 'Figure 2 Autre')]);
    expect([...citedPages(idx, new Set([1]))]).toEqual([3]);
    expect([...citedPages(idx, new Set([3]))]).toEqual([4]);
  });

  it("chaque image va à la légende la plus proche de sa page ; sans région connue, seulement à l'unique légende", () => {
    const idx = indexText([{ ...page(1, 'Figure 1 Haut'), lines: [{ text: 'Figure 1 Haut', x: 0, y: 100, l: 500, h: 30 }, { text: 'Figure 2 Bas', x: 0, y: 1500, l: 500, h: 30 }] }, page(2, 'Figure 3 Seule'), page(3, 'rien')]);
    attachRegions(idx, [
      { page: 1, box: { x: 0, y: 200, l: 400, h: 300 } },
      { page: 1, box: { x: 0, y: 1000, l: 400, h: 400 } },
      { page: 2, box: null },
    ]);
    expect(idx.figures.map((f) => [f.label, f.regions])).toEqual([['Figure 1', [0]], ['Figure 2', [1]], ['Figure 3', [2]]]);
  });

  it('une figure qu\'aucun passage ne cite est un lien non résolu', () => {
    const idx = indexText([page(1, 'Figure 1 Lonely')]);
    expect(idx.unresolved).toEqual([{ label: 'Figure 1', page: 1, extrait: 'Figure 1 Lonely' }]);
  });

  it('une image sur une page sans légende est un lien non résolu ; une image légendée ne l\'est pas', () => {
    const idx = indexText([page(1, 'Figure 1 Carte', 'Voir Figure 1.'), page(2, 'texte seul')]);
    attachRegions(idx, [{ page: 1, box: null }, { page: 2, box: null }]);
    expect(idx.unresolved).toEqual([{ label: 'image sans légende', page: 2, extrait: '' }]);
  });

  it('le pluriel cite chaque figure listée : « Figures 2 and 3 », « Tables 4 to 6 », « Figs. 2.1 et 2.2 »', () => {
    const idx = indexText([
      page(1, 'See Figures 2 and 3 for details.', 'Voir Tables 4 to 6.', 'see Figs. 2.1 and 2.2', 'See Figure 2, 3 stations'),
      page(2, 'Figure 2 A', 'Figure 3 B', 'Table 4 C', 'Table 5 D', 'Table 6 E', 'Figure 2.1 F', 'Figure 2.2 G'),
    ]);
    expect(idx.figures.map((f) => [f.label, f.citations.map((c) => c.line)])).toEqual([
      ['Figure 2', [1, 4]], ['Figure 3', [1]], ['Table 4', [2]], ['Table 5', [2]], ['Table 6', [2]], ['Figure 2.1', [3]], ['Figure 2.2', [3]],
    ]);
    expect(idx.unresolved).toEqual([]);
    expect([...citedPages(idx, new Set([1]))]).toEqual([2]);
  });
  it("les numéros d'annexe des normes OMM gardent leur lettre : « Figure 1.B.1 » n'est pas la Figure 1", () => {
    const idx = indexText([
      page(1, 'See Figure 1.D.5 and Figures 1.B.1 and 1.B.2.', 'Voir Table 12.B.3.'),
      page(2, 'Figure 1.B.1 Wind profile', 'Figure 1.B.2 Temperature profile', 'Figure 1.D.5 Radiation', 'Table 12.B.3 Codes'),
    ]);
    expect(idx.figures.map((f) => [f.label, f.page, f.citations.map((c) => c.line)])).toEqual([
      ['Figure 1.B.1', 2, [1]], ['Figure 1.B.2', 2, [1]], ['Figure 1.D.5', 2, [1]], ['Table 12.B.3', 2, [2]],
    ]);
    expect(idx.unresolved).toEqual([]);
  });

  it.each([['Figure 1 — map of stations'], ['Figure 1 – map of stations'], ['Figure 1: map of stations'], ['Table 1 — map of stations'], ['Table 1 – map of stations'], ['Table 1: map of stations']])(
    'après un séparateur (tiret, deux-points), « %s » est une légende même si le titre commence par une minuscule',
    (caption) => {
      const idx = indexText([page(1, caption, `see ${caption.slice(0, 8).trim()}`)]);
      expect(idx.figures).toMatchObject([{ page: 1, line: 1, caption }]);
      expect(idx.unresolved).toEqual([]);
    },
  );

  it('sans séparateur, « Figure 3 shows… » reste une citation, et une virgule ou une parenthèse après le numéro ne légende rien', () => {
    const idx = indexText([page(1, 'Figure 3 shows the model.', 'Figure 3, which gives the model', 'Figure 3 (page 4) and more'), page(2, 'Figure 3 Station model')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 3', page: 2, line: 1 }]);
    expect(idx.figures[0]!.citations.map((c) => [c.page, c.line])).toEqual([[1, 1], [1, 2], [1, 3]]);
  });

  it('une ligne de sommaire dont les points de conduite passent à la ligne suivante ne légende rien', () => {
    const idx = indexText([
      page(9, 'Table 3 — Mapping OGC API — EDR Sections to Common Requirements Classes', '.............................................26', 'Table 4 — Paths ...... 34'),
      page(45, 'Table 3 — Mapping OGC API — EDR Sections to Common Requirements Classes', 'API-EDR SECTION'),
    ]);
    expect(idx.figures).toMatchObject([{ label: 'Table 3', page: 45, line: 1 }]);
  });

  it('une ligne de sommaire qui finit par un numéro de page ne légende rien', () => {
    const idx = indexText([page(2, 'Figure 2 Station model 12', 'Table 4 — Codes 13'), page(12, 'Figure 2 Station model'), page(13, 'Table 4 — Codes')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 2', page: 12 }, { label: 'Table 4', page: 13 }]);
  });

  it('un numéro final qui ne peut pas être une page du document ne fait pas d\'une légende une ligne de sommaire', () => {
    const idx = indexText([page(1, 'Figure 2 Wind at 500')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 2', page: 1 }]);
  });

  it('une page dont la plupart des lignes sont des entrées de sommaire ne légende rien, même sa ligne sans points de conduite', () => {
    const idx = indexText([
      page(3, 'LIST OF TABLES', 'Table 1 — Paths ...... 10', 'Table 2 — Queries ...... 11', 'Table 3 — Area ...... 12', 'Table 7 — Radius query structure'),
      page(20, 'Table 7 — Radius query structure'),
    ]);
    expect(idx.figures).toMatchObject([{ label: 'Table 7', page: 20 }]);
  });

  it('une ligne de sommaire ne cite rien : la figure qu\'elle seule nomme est « une figure que rien ne cite »', () => {
    const idx = indexText([page(1, 'Figure 1 Station model ........ 12', 'Table 4 — Codes', '..... 13'), page(12, 'Figure 1 Station model'), page(13, 'Table 4 — Codes')]);
    expect(idx.figures.map((f) => f.citations)).toEqual([[], []]);
    expect(idx.unresolved.map((u) => u.label)).toEqual(['Figure 1', 'Table 4']);
  });

  it('une prose coupée en début de ligne avant la vraie légende ne place pas la figure : « Table 2 The WMO… » cède à la page qui porte l\'image', () => {
    const idx = indexText([page(1, 'Table 2 The WMO codes are listed', 'Figure 5, which gives the model', 'Figure 5 (page 4) and more'), page(2, 'Figure 5 Station model', 'Table 2 The WMO codes')], new Set([2]));
    expect(idx.figures.map((f) => [f.label, f.page, f.line])).toEqual([['Figure 5', 2, 1], ['Table 2', 2, 2]]);
    expect(idx.figures[1]!.citations.map((c) => [c.page, c.line])).toEqual([[1, 1]]);
  });

  it('sans image pour départager, la première ligne en forme de légende reste la légende', () => {
    const idx = indexText([page(1, 'Table 2 The WMO codes are listed'), page(2, 'Table 2 Codes')]);
    expect(idx.figures).toMatchObject([{ label: 'Table 2', page: 1 }]);
  });

  it('sans image pour départager, une ligne à séparateur (« Table 3 — Mapping… ») l\'emporte sur une prose coupée (« Table 3 Identifies the… ») plus haut dans le document', () => {
    const idx = indexText([page(44, 'Table 3 Identifies the classes which are'), page(45, 'Table 3 — Mapping OGC API sections')]);
    expect(idx.figures).toMatchObject([{ label: 'Table 3', page: 45, line: 1 }]);
    expect(idx.figures[0]!.citations.map((c) => c.page)).toEqual([44]);
  });

  it("un numéro final seul ne fait pas d'une vraie légende une entrée de sommaire : « Table 4.1. … presented in Chapter 4 » au milieu de la prose reste la légende", () => {
    const idx = indexText([
      page(1, 'Contents'),
      page(2, 'Voir Table 4.1.'),
      page(3, 'The forecaster compares the charts.', 'Table 4.1. Specific examples of manual forecasting presented in Chapter 4', 'Chart', 'Notes'),
      page(4, 'rien'),
      page(5, 'rien'),
    ]);
    expect(idx.figures).toMatchObject([{ label: 'Table 4.1', page: 3, line: 2 }]);
    expect(idx.unresolved).toEqual([]);
  });

  it('une légende seule sur sa page, titre fini par un chiffre (« Figure 4.9. Weather situation at t = 0 »), reste la légende', () => {
    const idx = indexText([page(1, 'Voir Figure 4.9.'), page(2, 'Figure 4.9. Weather situation over the North Atlantic at t = 0')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 4.9', page: 2 }]);
    expect(idx.unresolved).toEqual([]);
  });

  it('une page dont les lignes sont presque toutes des légendes finies par un numéro de page est un sommaire, sans points de conduite non plus', () => {
    const idx = indexText([page(1, 'Figures', 'Figure 1 Station model 3', 'Figure 2 Wind at 500 hPa 4'), page(3, 'Figure 1 Station model'), page(4, 'Figure 2 Wind at 500 hPa')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 1', page: 3 }, { label: 'Figure 2', page: 4 }]);
  });

  it("un séparateur suivi d'un titre vide n'est pas une légende : « figure 24. » fin de phrase cède à « Figure 24: … » de la page suivante", () => {
    const idx = indexText([page(15, 'The release is shown in', 'figure 24.', 'Next, the winds'), page(16, 'Figure 24: Radioactive Release information')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 24', page: 16, line: 1, caption: 'Figure 24: Radioactive Release information' }]);
    expect(idx.figures[0]!.citations.map((c) => [c.page, c.line])).toEqual([[15, 2]]);
  });

  it('plusieurs lignes en forme de légende : celle qui a un titre l\'emporte sur un numéro seul, même plus haut dans le document', () => {
    const idx = indexText([page(7, 'Figure 12', 'The jet', 'Figure 12 Jet speed depiction and decode')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 12', page: 7, line: 3, caption: 'Figure 12 Jet speed depiction and decode' }]);
  });

  it('le numéro de la figure n\'est pas un numéro de page : « Figure 5 » seul sur sa ligne n\'est pas une entrée de sommaire, il reste une légende quand rien d\'autre ne légende la figure (titre à la ligne suivante)', () => {
    const idx = indexText([page(7, 'Figure 5', 'Jet speed depiction')]);
    expect(idx.figures).toMatchObject([{ label: 'Figure 5', page: 7, line: 1 }]);
  });
});
