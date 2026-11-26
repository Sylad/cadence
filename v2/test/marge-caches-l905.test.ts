import { describe, expect, it } from 'vitest';
import { cachesReussis } from '../src/bench/sans-juge.js';
import { BARRE_SPEC, ECART_DANS_LE_BRUIT, RATES_PAR_TEST_DE_MARGE, rapport, verdictSansJuge, type MesureSansJuge, type ResultatBanc } from '../src/bench/verdict.js';

// L905 (D-39) : « tests d'origine verts » (≥ A test par test, L777) basculait au hasard sur 7-ol-companion-L160, où les deux bras ratent 52 à 55 de leurs
// tests d'origine : 26-11, deux passages à la même empreinte 731ad45d5f4c, ROUGES pour 17 contre 20 puis 16 contre 17 (rapports 2026-11-26-1727 et -1753).
// Marge par banc : 1 test par 6 tests d'origine que A rate sur CE banc ; elle ne pardonne que l'écart de ce banc, et le pardon est signalé à part.

const m = (bras: string) => ({ bras, banc: 'x', debut: '', fin: '', duree_s: 100, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
/** Un bras : tests d'origine réussis et ratés par un lanceur. */
type Bras = { lanceur: string; reussis: number; rates: number };
const sj = (x: Bras): MesureSansJuge => ({ suite_ok: true, caches_ok: x.rates === 0, caches_reussis: { [x.lanceur]: x.reussis },
  ...(x.rates > 0 && { caches_rates: { [x.lanceur]: x.rates } }) });
const banc = (id: string, a: Bras, c: Bras): ResultatBanc => ({ banc: id, taille: 'fonction', visible: false, reponses: false, frais: false,
  mesures: { A: m('A'), 'cadence-run': m('cadence-run') }, jugement: null, fuites: { A: [], 'cadence-run': [] }, sans_juge: { A: sj(a), 'cadence-run': sj(c) } });
const j = (reussis: number, rates: number): Bras => ({ lanceur: 'jest', reussis, rates });
const vi = (reussis: number, rates: number): Bras => ({ lanceur: 'vitest', reussis, rates });

/** Un passage mécanique, bancs 1, 3 et 7, comme le 26-11 : `b1` et `b7` sont [A, cadence-run]. Au banc 3, A et cadence-run réussissent 31 tests (jest). */
const passage = (b1: [Bras, Bras], b7: [Bras, Bras]) => [banc('1-ol-companion-L239', ...b1), banc('3-ol-companion-L241', j(31, 1), j(31, 2)),
  banc('7-ol-companion-L160', ...b7)];
const verdictDe = (rs: ResultatBanc[]) => verdictSansJuge(rs, 'A', 'cadence-run', BARRE_SPEC);
const critere = (rs: ResultatBanc[], nom = 'tests d\'origine verts') => verdictDe(rs).criteres.find((x) => x.nom === nom);
const B1: [Bras, Bras] = [vi(33, 0), vi(33, 0)];

describe('marge des tests d\'origine proportionnée aux ratés de A (L905)', () => {
  it('les ratés de chaque lanceur sont relevés dans les journaux, à côté des réussis', () => {
    // banc 7 (forme du 26-11 à 17:27) : avec les tests d'origine, 52 ratés et 20 réussis de plus que la suite seule
    expect(cachesReussis('      Tests  52 failed | 1386 passed (1438)', '      Tests  1366 passed (1366)'))
      .toEqual({ par_lanceur: { vitest: 20 }, hors_compte: [], rates: { vitest: 52 } });
    expect(cachesReussis('      Tests  1399 passed (1399)', '      Tests  1366 passed (1366)')).toEqual({ par_lanceur: { vitest: 33 }, hors_compte: [] });
  });

  it('26-11 à 17:27 : 81 contre 84 (banc 7 : 17 contre 20, A rate 52) devient VERT, l\'écart est signalé à part', () => {
    const rs = passage(B1, [vi(20, 52), vi(17, 55)]);
    expect(Math.floor(52 / RATES_PAR_TEST_DE_MARGE)).toBe(8);
    expect(critere(rs)).toMatchObject({ ok: true, bloquant: true,
      valeur: expect.stringMatching(/^81 contre 84 tests réussis \(.*7-ol-companion-L160 : 17 contre 20 \(écart 3, marge 8 : A rate 52 tests d'origine\)\)$/) });
    expect(critere(rs, ECART_DANS_LE_BRUIT)).toMatchObject({ valeur: '7-ol-companion-L160 : 17 contre 20, 3 dans la marge de 8', ok: false, bloquant: false });
    expect(verdictDe(rs).vert).toBe(true);
    expect(rapport(rs, 'A', 'cadence-run', verdictDe(rs), { date: '2026-11-26', empreinte: '731ad45d5f4c' })).toContain(`| ${ECART_DANS_LE_BRUIT} | `);
  });

  it('26-11 à 17:53 : 80 contre 81 (banc 7 : 16 contre 17, A rate 55) devient VERT', () => {
    const rs = passage(B1, [vi(17, 55), vi(16, 55)]);
    expect(critere(rs)).toMatchObject({ ok: true, valeur: expect.stringMatching(/^80 contre 81 /) });
    expect(verdictDe(rs).vert).toBe(true);
  });

  it('un vrai recul reste ROUGE : un test perdu sur un banc que A réussit, même avec la marge du banc 7 inemployée ailleurs', () => {
    // banc 1 : A passe ses 33 tests d'origine, cadence-run en rate un ; le banc 7 est celui du 26-11 à 17:27 (3 pardonnés sur 8)
    const rs = passage([vi(33, 0), vi(32, 1)], [vi(20, 52), vi(17, 55)]);
    expect(critere(rs)).toMatchObject({ ok: false, bloquant: true, valeur: expect.stringMatching(/^80 contre 84 /) });
    expect(verdictDe(rs).vert).toBe(false);
    // le même test raté à chaque passage : chaque passage est rouge, la marge du banc 7 ne le couvre jamais
    for (const b7 of [[vi(20, 52), vi(17, 55)], [vi(17, 55), vi(16, 55)]] as [Bras, Bras][])
      expect(verdictDe(passage([vi(33, 0), vi(32, 1)], b7)).vert).toBe(false);
  });

  it('un vrai recul reste ROUGE : un écart net au-delà de la marge, même sur un banc que A rate largement', () => {
    const rs = passage(B1, [vi(20, 52), vi(10, 62)]); // 10 de moins, marge 8
    expect(critere(rs)).toMatchObject({ ok: false, valeur: expect.stringContaining('7-ol-companion-L160 : 10 contre 20 (écart 10, marge 8 : A rate 52 tests d\'origine)') });
    expect(verdictDe(rs).vert).toBe(false);
    expect(verdictDe(passage(B1, [vi(20, 52), vi(12, 60)])).vert).toBe(true); // 8 de moins : à la limite, dans la marge
  });

  it('la marge se lit sur les ratés de A seuls : un candidat qui rate beaucoup sur un banc que A réussit n\'en gagne aucune', () => {
    const rs = [banc('1-a', vi(33, 0), vi(20, 13))];
    expect(critere(rs)).toMatchObject({ ok: false, valeur: '20 contre 33 tests réussis (1-a : 20 contre 33)' });
    expect(critere(rs, ECART_DANS_LE_BRUIT)).toBeUndefined();
  });

  it('un relevé d\'avant L905 (sans ratés) garde la règle stricte : 17 contre 20 au banc 7 reste rouge', () => {
    const rs = passage(B1, [vi(20, 52), vi(17, 55)]);
    for (const b of ['A', 'cadence-run']) delete rs[2].sans_juge![b].caches_rates;
    expect(critere(rs)).toMatchObject({ ok: false, valeur: expect.stringContaining('7-ol-companion-L160 : 17 contre 20)') });
  });
});
