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
    const n = cachesReussis(lireJournal(`${clone}.tests-origine${j}.log`), lireJournal(`${clone}.tests-bras${j}.log`));
    return { suite_ok, caches_ok, ...(n !== null && { caches_reussis: n }) };
  } finally { for (const p of poses) rmSync(p, { force: true }); }
}

const lireJournal = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
/** Couleurs ANSI d'une sortie de terminal (vitest et jest en écrivent même redirigés, selon l'environnement). */
const SANS_ANSI = /\x1b\[[0-9;]*m/g;

/**
 * L777 : tests réussis par lanceur, lus dans les lignes de bilan d'un journal de suite : jest (`Tests:       3 failed, 546 passed, 549 total`),
 * vitest (`      Tests  1 failed | 1366 passed (1368)`), pytest (`==== 1 failed, 30 passed in 2.31s ====`). Un lanceur cité plusieurs fois se somme ;
 * null si aucune ligne de bilan n'est lisible (lanceur inconnu, suite tuée avant son bilan).
 */
export function testsReussis(journal: string): Record<string, number> | null {
  const n: Record<string, number> = {};
  const ajoute = (k: string, reste: string) => { n[k] = (n[k] ?? 0) + Number(/(\d+) passed/.exec(reste)?.[1] ?? 0); };
  for (const brute of journal.replace(SANS_ANSI, '').split('\n')) {
    const l = brute.trim(); let m: RegExpExecArray | null;
    if ((m = /^Tests:\s+(.*\btotal\b.*)$/.exec(l))) ajoute('jest', m[1]);
    else if ((m = /^Tests {2,}(.*\(\d+\))$/.exec(l))) ajoute('vitest', m[1]);
    else if ((m = /^=+ (.*\b(?:passed|failed)\b.* in [\d.]+s.*?) =+$/.exec(l))) ajoute('pytest', m[1]);
  }
  return Object.keys(n).length ? n : null;
}

/**
 * L777 : tests d'origine réussis par un bras = tests réussis avec les tests d'origine posés, moins ceux de la suite seule, lanceur par lanceur
 * (jamais négatif : un lanceur que la suite avec les tests d'origine n'a pas atteint compte 0). null si l'un des deux journaux n'a aucun bilan lisible ;
 * le verdict revient alors au compte par banc. Le compte n'a de sens qu'avec une suite du bras verte, que « suite du projet verte » exige déjà.
 */
export function cachesReussis(origine: string, bras: string): number | null {
  const o = testsReussis(origine), b = testsReussis(bras);
  if (!o || !b) return null;
  return [...new Set([...Object.keys(o), ...Object.keys(b)])].reduce((s, k) => s + Math.max(0, (o[k] ?? 0) - (b[k] ?? 0)), 0);
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
