import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { cachesReussis, mesurerSansJuge, testsReussis } from '../src/bench/sans-juge.js';
import { BARRE_SPEC, rapport, verdictSansJuge, type MesureSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L777 (décision de Sylvain du 18-11) : « tests d'origine verts » compte les tests d'origine réussis par bras, plus des bancs entiers verts ;
// un candidat nettement pire que A reste ROUGE. Revue r1 : la marge de 11 % (MARGE_CACHES) est retirée, elle n'était pas mesurée sur des bras identiques
// (empreinte_bras différente aux bancs 3 et 7) : candidat ≥ A test par test ; un lanceur ne compte que s'il a un bilan dans les deux journaux.

/** Bilans recopiés des journaux du 18-11 (banc 1, ol-companion L239 : jest pour le backend, puis vitest pour le frontend). */
const JEST = 'Test Suites: 46 passed, 46 total\nTests:       506 passed, 506 total\nSnapshots:   0 total';
const VITEST_ORIGINE_ROUGE = ' Test Files  1 failed | 162 passed (163)\n      Tests  1 failed | 1366 passed | 1 skipped (1368)\n   Start at  11:40:40';
const VITEST_ORIGINE_VERT = ' Test Files  163 passed (163)\n      Tests  1367 passed | 1 skipped (1368)';
const VITEST_BRAS = ' Test Files  162 passed (162)\n      Tests  1334 passed | 1 skipped (1335)';

describe('tests réussis lus dans le bilan d\'une suite (L777)', () => {
  it('jest, vitest et pytest, couleurs ANSI comprises ; null sans bilan lisible', () => {
    expect(testsReussis(`${JEST}\n${VITEST_ORIGINE_ROUGE}`)).toEqual({ jest: 506, vitest: 1366 });
    expect(testsReussis('\x1b[1mTests:\x1b[22m       \x1b[31m3 failed\x1b[39m, \x1b[32m546 passed\x1b[39m, 549 total')).toEqual({ jest: 546 });
    expect(testsReussis('========= 1 failed, 30 passed in 2.31s =========')).toEqual({ pytest: 30 });
    expect(testsReussis('Tests  53 failed (53)')).toEqual({ vitest: 0 });
    expect(testsReussis('ok\nrien ici')).toBeNull();
  });
  it('tests d\'origine réussis : suite avec les tests d\'origine moins suite seule, lanceur par lanceur', () => {
    // banc 1, 18-11 à 11:31 : c1 (cadence-run) rate 1 des 33 tests d'origine, c2 (A) les passe tous
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_ROUGE}`, `${JEST}\n${VITEST_BRAS}`)).toEqual({ par_lanceur: { jest: 0, vitest: 32 }, hors_compte: [], rates: { vitest: 1 } }); // L905 : ratés relevés
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_VERT}`, `${JEST}\n${VITEST_BRAS}`)).toEqual({ par_lanceur: { jest: 0, vitest: 33 }, hors_compte: [] });
    expect(cachesReussis('aucun bilan', 'rien')).toBeNull();
  });
  it('revue r1 : un lanceur absent d\'un des deux journaux (chaîne && arrêtée ailleurs) ou rouge dans la suite seule ne compte pas', () => {
    const JEST_ROUGE = 'Tests:       3 failed, 503 passed, 506 total';
    // suite seule arrêtée au backend rouge, vitest pas lancé ; suite avec les tests d'origine verte : comptait 1368 (toute la suite frontend)
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_VERT}`, JEST_ROUGE)).toEqual({ par_lanceur: {},
      hors_compte: ['jest : 3 rouge(s) dans la suite seule', 'vitest : absent de la suite seule'] });
    // backend rouge dans la suite avec les tests d'origine, suite seule verte : comptait 0 (les 33 tests d'origine frontend effacés)
    expect(cachesReussis(JEST_ROUGE, `${JEST}\n${VITEST_BRAS}`)).toEqual({ par_lanceur: { jest: 0 }, hors_compte: ['vitest : absent de la suite avec les tests d\'origine'],
      rates: { jest: 3 } });
    // suite seule rouge sous charge (15-11 16:04, 28 findBy expirés) : la différence aurait compté 61 tests d'origine sur 33
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_VERT}`, `${JEST}\n      Tests  28 failed | 1307 passed (1335)`)).toEqual({ par_lanceur: { jest: 0 },
      hors_compte: ['vitest : 28 rouge(s) dans la suite seule'] });
    // banc 3 : le backend rouge arrête la chaîne dans la suite avec les tests d'origine ; seul jest compte, vitest est nommé hors compte
    expect(cachesReussis('Tests:       3 failed, 546 passed, 549 total', `Tests:       514 passed, 514 total\n${VITEST_BRAS}`))
      .toEqual({ par_lanceur: { jest: 32 }, hors_compte: ['vitest : absent de la suite avec les tests d\'origine'], rates: { jest: 3 } });
  });
  it('la mesure sans juge relève le compte dans resultat.json, et l\'omet sans bilan lisible', () => {
    const r = dossierTemp('caches-l777-'), clone = join(r, 'c1'), secrets = join(r, 'secrets');
    mkdirSync(clone); mkdirSync(join(secrets, 'tests-origine', 't'), { recursive: true }); mkdirSync(join(clone, 't'));
    writeFileSync(join(clone, 't', 'a.test.sh'), ''); writeFileSync(join(secrets, 'tests-origine', 't', 'b.test.sh'), ''); writeFileSync(join(secrets, 'tests-origine', 't', 'c.test.sh'), '');
    const banc = (tests: string): Banc => ({ id: '1-a', dir: r, secrets, projet: 'p', source: r, base: 'x', install: 'true', tests, visible: false, taille: 'fonction', frais: false, reponses: false });
    // un faux lanceur : chaque fichier de test passe, sauf c.cache-banc.test.sh qui échoue
    const lanceur = 'p=$(ls t/*.test.sh | grep -vc c.cache-banc); f=$(ls t/*.test.sh | grep -c c.cache-banc); echo "Tests:       $f failed, $p passed, $((p+f)) total"; test $f -eq 0';
    expect(mesurerSansJuge(banc(lanceur), clone)).toEqual({ suite_ok: true, caches_ok: false, caches_reussis: { jest: 1 }, caches_rates: { jest: 1 } });
    expect(mesurerSansJuge(banc('true'), clone)).toEqual({ suite_ok: true, caches_ok: true });
  });
});

const m = (bras: string) => ({ bras, banc: 'x', debut: '', fin: '', duree_s: 100, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
/** Un banc mesuré sans juge ; `a` et `c` : tests d'origine réussis par A et par cadence-run (null : relevé sans compte ; nombre : un seul lanceur, vitest) ; `ok` : banc entier vert. */
type Compte = number | Record<string, number> | null;
const banc = (id: string, a: [Compte, boolean], c: [Compte, boolean]): ResultatBanc => {
  const sj = ([n, ok]: [Compte, boolean]): MesureSansJuge => ({ suite_ok: true, caches_ok: ok, ...(n !== null && { caches_reussis: typeof n === 'number' ? { vitest: n } : n }) });
  return { banc: id, taille: 'fonction', visible: false, reponses: false, frais: false, mesures: { A: m('A'), 'cadence-run': m('cadence-run') }, jugement: null,
    fuites: { A: [], 'cadence-run': [] }, sans_juge: { A: sj(a), 'cadence-run': sj(c) } };
};
const caches = (...rs: ResultatBanc[]) => verdictSansJuge(rs, 'A', 'cadence-run', BARRE_SPEC).criteres.find((x) => x.nom === 'tests d\'origine verts')!;
const vert = (...rs: ResultatBanc[]) => verdictSansJuge(rs, 'A', 'cadence-run', BARRE_SPEC).vert;

describe('critère « tests d\'origine verts » : tests réussis par bras, sans marge (L777, revue r1)', () => {
  it('les trois passages du 18-11 recalculés au compte final : 09:07 et 10:08 ROUGES, 11:31 vert', () => {
    // comptes relus dans ~/bench-cadence/runs/<passage>/<banc>/c1|c2.tests-origine[.rejeu].log et .tests-bras[.rejeu].log (cachesReussis, jest + vitest ;
    // au banc 3, vitest est hors compte pour les deux bras : la chaîne && s'arrête au backend rouge)
    const p = (b1: [number, number], b3: [number, number], b7: [number, number]) => [banc('1-ol-companion-L239', [b1[0], b1[0] === 33], [b1[1], b1[1] === 33]),
      banc('3-ol-companion-L241', [{ jest: b3[0] }, false], [{ jest: b3[1] }, false]), banc('7-ol-companion-L160', [b7[0], false], [b7[1], false])];
    expect(caches(...p([33, 32], [31, 32], [24, 16]))).toMatchObject({ valeur: '80 contre 88 tests réussis (1-ol-companion-L239 : 32 contre 33 · 3-ol-companion-L241 : 32 contre 31 · 7-ol-companion-L160 : 16 contre 24)',
      seuil: '≥ A test par test, marge par banc : 1 par 6 tests d\'origine ratés par A (L777, L905)', ok: false, bloquant: true }); // 09:07 (relevé sans ratés : marge nulle)
    expect(caches(...p([32, 33], [31, 31], [21, 18]))).toMatchObject({ valeur: expect.stringMatching(/^82 contre 84 tests réussis/), ok: false }); // 10:08
    expect(caches(...p([33, 32], [32, 32], [16, 19]))).toMatchObject({ valeur: expect.stringMatching(/^83 contre 81 tests réussis/), ok: true }); // 11:31
    expect(vert(...p([33, 32], [31, 32], [24, 16]))).toBe(false);
  });
  it('un candidat nettement pire que A reste ROUGE : un banc entier perdu, dix tests de moins, ou un seul', () => {
    const avec = (n1: number, n7: number) => [banc('1-a', [33, true], [n1, n1 === 33]), banc('3-b', [31, false], [31, false]), banc('7-c', [24, false], [n7, false])];
    expect(caches(...avec(0, 24))).toMatchObject({ valeur: expect.stringMatching(/^55 contre 88 /), ok: false, bloquant: true });
    expect(vert(...avec(0, 24))).toBe(false);
    expect(caches(...avec(33, 14))).toMatchObject({ valeur: expect.stringMatching(/^78 contre 88 /), ok: false }); // l'ancienne marge de 11 % le laissait vert
    expect(caches(...avec(33, 23))).toMatchObject({ ok: false });
    expect(caches(...avec(33, 24))).toMatchObject({ ok: true });
  });
  it('revue r1 : un lanceur compté pour un seul bras rend le banc non mesurable ; un lanceur hors compte des deux bras est nommé', () => {
    const x = caches(banc('1-a', [{ jest: 0, vitest: 33 }, true], [{ jest: 0 }, false]), banc('3-b', [31, false], [31, false]));
    expect(x).toMatchObject({ valeur: '0 contre 1 bancs sur 2 (compte par test non mesurable : 1-a : vitest compté pour A seulement)', seuil: '≥ A', ok: false });
    const b3 = banc('3-b', [{ jest: 31 }, false], [{ jest: 32 }, false]);
    for (const b of ['A', 'cadence-run']) b3.sans_juge![b].caches_hors_compte = ['vitest : absent de la suite avec les tests d\'origine'];
    expect(caches(b3)).toMatchObject({ valeur: '32 contre 31 tests réussis (3-b : 32 contre 31) ; hors compte : 3-b/A : vitest : absent de la suite avec les tests d\'origine ; '
      + '3-b/cadence-run : vitest : absent de la suite avec les tests d\'origine', ok: true });
    expect(caches(banc('1-a', [{}, false], [{}, false]))).toMatchObject({ valeur: expect.stringContaining('1-a : aucun lanceur comptable'), ok: true });
  });
  it('sans compte relevé pour un bras (passage d\'avant L777), le critère revient au compte par banc et le dit', () => {
    const x = caches(banc('1-a', [33, true], [null, false]), banc('3-b', [31, false], [31, false]));
    expect(x).toMatchObject({ valeur: '0 contre 1 bancs sur 2 (compte par test non mesurable : 1-a : compte non relevé (cadence-run))', seuil: '≥ A', ok: false });
  });
  it('un banc sans tests d\'origine ne compte pas ; aucun : « aucun banc avec tests d\'origine », vert', () => {
    const sans = banc('2-b', [null, true], [null, true]); sans.sans_juge = { A: { suite_ok: true, caches_ok: null }, 'cadence-run': { suite_ok: true, caches_ok: null } };
    expect(caches(banc('1-a', [33, true], [33, true]), sans)).toMatchObject({ valeur: '33 contre 33 tests réussis (1-a : 33 contre 33)', ok: true });
    expect(caches(sans)).toMatchObject({ valeur: 'aucun banc avec tests d\'origine', ok: true });
  });
  it('le rapport donne le compte de chaque bras dans la colonne des tests d\'origine', () => {
    const r = banc('1-a', [33, true], [32, false]);
    const md = rapport([r], 'A', 'cadence-run', verdictSansJuge([r], 'A', 'cadence-run', BARRE_SPEC), { date: '2026-11-18', empreinte: 'e' });
    expect(md).toContain('| sans juge | ok 33 · ROUGE 32 |');
  });
});
