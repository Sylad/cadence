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
});
