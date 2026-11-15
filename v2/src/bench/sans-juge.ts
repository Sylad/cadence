// L689 (D-3) : mesure des bancs micro et mécanique, sans juge IA ; seulement des commandes. Ni mutations ni relecture aveugle : ces bancs n'autorisent pas la publication.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Banc } from './banc.js';
import { shell } from './preparer.js';
import type { MesureSansJuge } from './verdict.js';

const fichiers = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(join(d, e.name)) : [join(d, e.name)]));
/** Nom d'un test d'origine posé à côté de ceux du bras sans en écraser un : `x.test.ts` → `x.cache-banc.test.ts`, `test_x.py` → `test_x_cache_banc.py`. */
export const nomCache = (f: string): string => { const n = basename(f), m = /\.(test|spec)\./.exec(n), p = n.lastIndexOf('.'); return join(dirname(f), m ? `${n.slice(0, m.index)}.cache-banc${n.slice(m.index)}` : p > 0 ? `${n.slice(0, p)}_cache_banc${n.slice(p)}` : `${n}_cache_banc`); };

/** La suite du projet dans le clone du bras, puis la même avec les tests d'origine du banc posés à côté (retirés au retour, quel que soit le chemin) ; `caches_ok` null : le banc n'en a pas. */
export function mesurerSansJuge(b: Banc, clone: string, delaiMs = 30 * 60_000): MesureSansJuge {
  const suite_ok = shell('tests du bras', b.tests, clone, `${clone}.tests-bras.log`, delaiMs) === 0, origine = join(b.secrets, 'tests-origine'), poses: string[] = [];
  const tests = existsSync(origine) ? fichiers(origine).map((f) => relative(origine, f)) : [];
  if (tests.length === 0) return { suite_ok, caches_ok: null };
  try {
    for (const f of tests) { const c = join(clone, nomCache(f)); if (!existsSync(c)) { mkdirSync(dirname(c), { recursive: true }); copyFileSync(join(origine, f), c); poses.push(c); } }
    return { suite_ok, caches_ok: shell('tests d\'origine', b.tests, clone, `${clone}.tests-origine.log`, delaiMs) === 0 };
  } finally { for (const p of poses) rmSync(p, { force: true }); }
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
