// L689 (D-3) : mesure des bancs micro et mécanique, sans juge IA ; seulement des commandes. Ni mutations ni relecture aveugle : ces bancs n'autorisent pas la publication.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Banc } from './banc.js';
import { shell } from './preparer.js';
import type { MesureSansJuge } from './verdict.js';

const fichiers = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(join(d, e.name)) : [join(d, e.name)]));
/** Nom d'un test d'origine posé à côté de ceux du bras sans en écraser un : `x.test.ts` → `x.cache-banc.test.ts`, `test_x.py` → `test_x_cache_banc.py`. */
export const nomCache = (f: string): string => { const n = basename(f), m = /\.(test|spec)\./.exec(n), p = n.lastIndexOf('.'); return join(dirname(f), m ? `${n.slice(0, m.index)}.cache-banc${n.slice(m.index)}` : p > 0 ? `${n.slice(0, p)}_cache_banc${n.slice(p)}` : `${n}_cache_banc`); };

/** La suite du projet dans le clone du bras, puis la même avec les tests d'origine du banc posés à côté (retirés au retour, quel que soit le chemin) ; `caches_ok` null : le banc n'en a pas. `rejeu` (L734) : journaux `.rejeu.log`, ceux du premier passage restent. */
export function mesurerSansJuge(b: Banc, clone: string, delaiMs = 30 * 60_000, rejeu = false): MesureSansJuge {
  const j = rejeu ? '.rejeu' : '';
  const suite_ok = shell('tests du bras', b.tests, clone, `${clone}.tests-bras${j}.log`, delaiMs) === 0, origine = join(b.secrets, 'tests-origine'), poses: string[] = [];
  const tests = existsSync(origine) ? fichiers(origine).map((f) => relative(origine, f)) : [];
  if (tests.length === 0) return { suite_ok, caches_ok: null };
  try {
    for (const f of tests) { const c = join(clone, nomCache(f)); if (!existsSync(c)) { mkdirSync(dirname(c), { recursive: true }); copyFileSync(join(origine, f), c); poses.push(c); } }
    const caches_ok = shell('tests d\'origine', b.tests, clone, `${clone}.tests-origine${j}.log`, delaiMs) === 0;
    const journal = lireJournal(`${clone}.tests-origine${j}.log`), brut = cachesReussis(journal, lireJournal(`${clone}.tests-bras${j}.log`));
    const n = brut && exclureTests(brut, journal, TESTS_HORS_COMPTE[b.id] ?? []);
    return { suite_ok, caches_ok, ...(n && { caches_reussis: n.par_lanceur, ...(n.hors_compte.length > 0 && { caches_hors_compte: n.hors_compte }) }) };
  } finally { for (const p of poses) rmSync(p, { force: true }); }
}

const lireJournal = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
/** Couleurs ANSI d'une sortie de terminal (vitest et jest en écrivent même redirigés, selon l'environnement). */
const SANS_ANSI = /\x1b\[[0-9;]*m/g;

/** L777 : bilan d'un lanceur dans un journal de suite : tests réussis et ratés. */
type Bilans = Record<string, { reussis: number; rates: number }>;
/**
 * L777 : bilans par lanceur, lus dans les lignes de bilan d'un journal de suite : jest (`Tests:       3 failed, 546 passed, 549 total`),
 * vitest (`      Tests  1 failed | 1366 passed (1368)`), pytest (`==== 1 failed, 30 passed in 2.31s ====`). Un lanceur cité plusieurs fois se somme ;
 * null si aucune ligne de bilan n'est lisible (lanceur inconnu, suite tuée avant son bilan).
 */
function bilans(journal: string): Bilans | null {
  const n: Bilans = {};
  const nb = (re: RegExp, t: string) => Number(re.exec(t)?.[1] ?? 0);
  const ajoute = (k: string, t: string) => { const x = (n[k] ??= { reussis: 0, rates: 0 }); x.reussis += nb(/(\d+) passed/, t); x.rates += nb(/(\d+) failed/, t); };
  for (const brute of journal.replace(SANS_ANSI, '').split('\n')) {
    const l = brute.trim(); let m: RegExpExecArray | null;
    if ((m = /^Tests:\s+(.*\btotal\b.*)$/.exec(l))) ajoute('jest', m[1]);
    else if ((m = /^Tests {2,}(.*\(\d+\))$/.exec(l))) ajoute('vitest', m[1]);
    else if ((m = /^=+ (.*\b(?:passed|failed)\b.* in [\d.]+s.*?) =+$/.exec(l))) ajoute('pytest', m[1]);
  }
  return Object.keys(n).length ? n : null;
}
/** L777 : tests réussis par lanceur (`bilans`) ; null sans bilan lisible. */
export function testsReussis(journal: string): Record<string, number> | null {
  const b = bilans(journal);
  return b && Object.fromEntries(Object.entries(b).map(([k, x]) => [k, x.reussis]));
}

/** L777 (revue r1) : tests d'origine réussis d'un bras, par lanceur comparable, et les lanceurs laissés hors du compte, avec leur raison. */
export interface CompteCaches { par_lanceur: Record<string, number>; hors_compte: string[] }
/**
 * L777 : tests d'origine réussis par un bras = tests réussis avec les tests d'origine posés, moins ceux de la suite seule, lanceur par lanceur.
 * Revue r1 : un lanceur ne compte que s'il a un bilan dans les DEUX journaux et aucun test raté dans la suite seule. Les bancs enchaînent leurs suites
 * par `&&` : une suite arrêtée avant un lanceur dans un seul des deux journaux comptait toute la suite de ce lanceur (1368) ou effaçait ses tests
 * d'origine (0) ; une suite seule rouge gonflait la différence. Ces lanceurs vont dans `hors_compte`. Aucun lanceur comparable (`par_lanceur` vide),
 * ou null si aucun des deux journaux n'a de bilan : compte non mesurable, que le verdict dit avant de revenir au compte par banc.
 */
export function cachesReussis(origine: string, bras: string): CompteCaches | null {
  const o = bilans(origine) ?? {}, b = bilans(bras) ?? {}, par_lanceur: Record<string, number> = {}, hors_compte: string[] = [];
  for (const k of [...new Set([...Object.keys(o), ...Object.keys(b)])].sort()) {
    if (!o[k] || !b[k]) hors_compte.push(`${k} : absent de la suite ${o[k] ? 'seule' : 'avec les tests d\'origine'}`);
    else if (b[k].rates) hors_compte.push(`${k} : ${b[k].rates} rouge(s) dans la suite seule`);
    else par_lanceur[k] = Math.max(0, o[k].reussis - b[k].reussis);
  }
  return Object.keys(par_lanceur).length || hors_compte.length ? { par_lanceur, hors_compte } : null;
}

/** L798 : un test d'origine laissé hors du compte des deux bras, avec sa raison (docs/v2/banc.md, « Tests d'origine hors compte »). `fichier` : son nom
 * posé dans le clone (`nomCache`), `nom` : son titre complet tel que jest l'écrit (`describe › it`). */
export interface TestHorsCompte { lanceur: 'jest'; fichier: string; nom: string; raison: string }
/**
 * L798 : tests d'origine retirés du compte, par banc. Seul ajout permis : un test dont le résultat suit un choix d'écriture du bras et non le comportement
 * qu'il nomme, prouvé sur les journaux des deux bras, raison écrite ici et dans la doc. Il sort du compte des DEUX bras ; tous les autres restent
 * comptés test par test (L777).
 */
export const TESTS_HORS_COMPTE: Record<string, TestHorsCompte[]> = {
  '3-ol-companion-L241': [{
    lanceur: 'jest', fichier: 'standings.service.rankings.cache-banc.spec.ts',
    nom: 'StandingsService — tracker de classement recalculé (L241) › résultats de la ligue en échec (HTTP 503) : le tracé existant est conservé',
    // banc du 20-11 11:11 : rouge pour cadence-run (ENOENT ligne 84, son `getCurrentStandings` n'écrit plus le tracker) et vert pour A (qui l'écrit, faux),
    // aux deux passages de chaque bras ; les deux bras conservent le tracker sur un 503.
    raison: 'sa précondition (un tracker écrit par getCurrentStandings) suit le chemin d\'écriture du bras, pas la conservation sur un 503',
  }],
};

/** L798 : vrai si le journal jest montre le test passé : un bilan jest, et ni `● <nom>` ni « Test suite failed to run » dans un bloc FAIL de son fichier. */
export function testReussiJest(journal: string, fichier: string, nom: string): boolean {
  if (!bilans(journal)?.jest) return false;
  let dans = false;
  for (const brute of journal.replace(SANS_ANSI, '').split('\n')) {
    const l = brute.trim(), m = /^(PASS|FAIL)\s+(\S+)/.exec(l);
    if (m) { dans = m[2] === fichier || m[2].endsWith(`/${fichier}`); continue; }
    if (dans && (l === '● Test suite failed to run' || l === `● ${nom}`)) return false;
  }
  return true;
}

/** L798 : retire du compte d'un bras chaque test de `exclus` qu'il a réussi, et le nomme hors compte (réussi ou raté) avec sa raison. */
export function exclureTests(n: CompteCaches, journal: string, exclus: TestHorsCompte[]): CompteCaches {
  const par_lanceur = { ...n.par_lanceur }, hors_compte = [...n.hors_compte];
  for (const x of exclus) {
    if (par_lanceur[x.lanceur] === undefined) continue;
    const ok = testReussiJest(journal, x.fichier, x.nom);
    if (ok) par_lanceur[x.lanceur] = Math.max(0, par_lanceur[x.lanceur] - 1);
    hors_compte.push(`${x.lanceur} : « ${x.nom.split(' › ').pop()} » (${x.fichier}, ${ok ? 'réussi' : 'raté'}) : ${x.raison}`);
  }
  return { par_lanceur, hors_compte };
}

/** L733 : chemins qui ne sont pas le travail d'un banc (plan, registre, docs, captures MCP, Markdown). */
const HORS_LIVRABLE = (f: string): boolean => /^(\.cadence|docs|\.playwright-mcp)\//.test(f) || f === 'cadence.yaml' || f.endsWith('.md');

/**
 * L733 (vécu des 14 et 15-11, banc 6) : un bras qui ne livre que du plan ou de la doc finit en 75 s et gagne en temps sans avoir fait le travail.
 * null si base..HEAD touche au moins un fichier hors plan et doc ; sinon la raison, avec les fichiers touchés.
 */
export function sansLivrable(clone: string, base: string): string | null {
  const touches = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], { cwd: clone, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (touches.some((f) => !HORS_LIVRABLE(f))) return null;
  return `aucun fichier livré hors plan et doc${touches.length ? ` (seulement ${touches.join(', ')})` : ''}`;
}
