import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { cachesReussis, mesurerSansJuge, testsReussis } from '../src/bench/sans-juge.js';
import { BARRE_SPEC, MARGE_CACHES, rapport, verdictSansJuge, type MesureSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L777 (décision de Sylvain du 18-11) : « tests d'origine verts » compte les tests d'origine réussis par bras, plus des bancs entiers verts,
// avec une marge de bruit mesurée sur des paires de bras identiques ; un candidat nettement pire que A reste ROUGE.

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
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_ROUGE}`, `${JEST}\n${VITEST_BRAS}`)).toBe(32);
    expect(cachesReussis(`${JEST}\n${VITEST_ORIGINE_VERT}`, `${JEST}\n${VITEST_BRAS}`)).toBe(33);
    // banc 3 : le backend rouge arrête la chaîne `&&`, vitest ne tourne pas avec les tests d'origine ; ce lanceur compte 0, jamais négatif
    expect(cachesReussis('Tests:       3 failed, 546 passed, 549 total', `Tests:       514 passed, 514 total\n${VITEST_BRAS}`)).toBe(32);
    expect(cachesReussis('aucun bilan', JEST)).toBeNull();
    expect(cachesReussis(JEST, '')).toBeNull();
  });
  it('la mesure sans juge relève le compte dans resultat.json, et l\'omet sans bilan lisible', () => {
    const r = dossierTemp('caches-l777-'), clone = join(r, 'c1'), secrets = join(r, 'secrets');
    mkdirSync(clone); mkdirSync(join(secrets, 'tests-origine', 't'), { recursive: true }); mkdirSync(join(clone, 't'));
    writeFileSync(join(clone, 't', 'a.test.sh'), ''); writeFileSync(join(secrets, 'tests-origine', 't', 'b.test.sh'), ''); writeFileSync(join(secrets, 'tests-origine', 't', 'c.test.sh'), '');
    const banc = (tests: string): Banc => ({ id: '1-a', dir: r, secrets, projet: 'p', source: r, base: 'x', install: 'true', tests, visible: false, taille: 'fonction', frais: false, reponses: false });
    // un faux lanceur : chaque fichier de test passe, sauf c.cache-banc.test.sh qui échoue
    const lanceur = 'p=$(ls t/*.test.sh | grep -vc c.cache-banc); f=$(ls t/*.test.sh | grep -c c.cache-banc); echo "Tests:       $f failed, $p passed, $((p+f)) total"; test $f -eq 0';
    expect(mesurerSansJuge(banc(lanceur), clone)).toEqual({ suite_ok: true, caches_ok: false, caches_reussis: 1 });
    expect(mesurerSansJuge(banc('true'), clone)).toEqual({ suite_ok: true, caches_ok: true });
  });
});

const m = (bras: string) => ({ bras, banc: 'x', debut: '', fin: '', duree_s: 100, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
/** Un banc mesuré sans juge ; `a` et `c` : tests d'origine réussis par A et par cadence-run (null : relevé sans compte) ; `ok` : banc entier vert. */
const banc = (id: string, a: [number | null, boolean], c: [number | null, boolean]): ResultatBanc => {
  const sj = ([n, ok]: [number | null, boolean]): MesureSansJuge => ({ suite_ok: true, caches_ok: ok, ...(n !== null && { caches_reussis: n }) });
  return { banc: id, taille: 'fonction', visible: false, reponses: false, frais: false, mesures: { A: m('A'), 'cadence-run': m('cadence-run') }, jugement: null,
    fuites: { A: [], 'cadence-run': [] }, sans_juge: { A: sj(a), 'cadence-run': sj(c) } };
};
const caches = (...rs: ResultatBanc[]) => verdictSansJuge(rs, 'A', 'cadence-run', BARRE_SPEC).criteres.find((x) => x.nom === 'tests d\'origine verts')!;
const vert = (...rs: ResultatBanc[]) => verdictSansJuge(rs, 'A', 'cadence-run', BARRE_SPEC).vert;

describe('critère « tests d\'origine verts » : tests réussis par bras, marge de bruit mesurée (L777)', () => {
  it('la marge est celle mesurée : 11 % de la référence', () => expect(MARGE_CACHES).toBe(0.11));
  it('les trois passages du 18-11, rouges au compte par banc, sont verts au compte par test : leur écart est celui de deux bras identiques', () => {
    // 18-11 09:07 : banc 1 32 contre 33, banc 3 32 contre 31, banc 7 16 contre 24 ; au compte par banc, 0 contre 1 : ROUGE
    const p0907 = [banc('1-ol-companion-L239', [33, true], [32, false]), banc('3-ol-companion-L241', [31, false], [32, false]), banc('7-ol-companion-L160', [24, false], [16, false])];
    expect(caches(...p0907)).toMatchObject({ valeur: '80 contre 88 tests réussis (1-ol-companion-L239 : 32 contre 33 · 3-ol-companion-L241 : 32 contre 31 · 7-ol-companion-L160 : 16 contre 24)',
      seuil: '≥ A − 10 (marge de bruit 11 % de A, L777)', ok: true, bloquant: true });
    expect(vert(...p0907)).toBe(true);
    const p1131 = [banc('1-ol-companion-L239', [33, true], [32, false]), banc('3-ol-companion-L241', [32, false], [32, false]), banc('7-ol-companion-L160', [16, false], [19, false])];
    expect(caches(...p1131)).toMatchObject({ valeur: expect.stringMatching(/^83 contre 81 tests réussis/), ok: true });
  });
  it('un candidat nettement pire que A reste ROUGE : un banc entier perdu, ou juste au-delà de la marge', () => {
    const perdu = [banc('1-a', [33, true], [0, false]), banc('3-b', [31, false], [31, false]), banc('7-c', [24, false], [24, false])]; // 55 contre 88
    expect(caches(...perdu)).toMatchObject({ ok: false, bloquant: true });
    expect(vert(...perdu)).toBe(false);
    // 88 pour A : marge ⌈9,68⌉ = 10 ; 78 passe, 77 est rouge
    const borne = (n: number) => caches(banc('1-a', [33, true], [33, true]), banc('3-b', [31, false], [31, false]), banc('7-c', [24, false], [n - 64, false]));
    expect(borne(78)).toMatchObject({ ok: true }); expect(borne(77)).toMatchObject({ ok: false, seuil: '≥ A − 10 (marge de bruit 11 % de A, L777)' });
  });
  it('sans compte relevé pour un bras (passage d\'avant L777), le critère revient au compte par banc et le dit', () => {
    const x = caches(banc('1-a', [33, true], [null, false]), banc('3-b', [31, false], [31, false]));
    expect(x).toMatchObject({ valeur: '0 contre 1 bancs sur 2 (compte par banc : tests réussis non relevés)', seuil: '≥ A', ok: false });
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
