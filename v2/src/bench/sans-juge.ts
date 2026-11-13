// L689 (D-3) : mesure des bancs micro et mécanique, sans juge IA ; seulement des commandes. Ni mutations ni relecture aveugle : ces bancs n'autorisent pas la publication.
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
