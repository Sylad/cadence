// Ligne de base des tests (L213) : un lot n'est pas rendu « tests rouges » pour des échecs déjà présents au sha de départ.
// La lecture des rouges dans la sortie d'un lanceur vit dans scripts/rouges-porte.mjs (L842), partagée avec la porte de `cadence run`.
import { clean, FILE_LOAD_FAIL, MARKERS, stripAnsi } from '../../scripts/rouges-porte.mjs';

export { failedTests, hasUnnamedFailure, jestTestFiles, nodeTestFiles, nodeTestRan, stripAnsi, unloadedSuites } from '../../scripts/rouges-porte.mjs';

/** Le délai d'un test expiré : vitest « Test timed out in 30000ms », jest « Exceeded timeout of 5000 ms for a test ». */
const SUMMARY = /^\s*(?:Test Files?|Tests?)\s+\d/;
const TIMEOUT = /(?:timed out in|Exceeded timeout of)\s+(\d+)\s*ms/i;

/**
 * Le délai (ms) de chaque test qui a expiré dans la sortie d'un lanceur (L510) : le message d'expiration est lu sous le dernier test nommé rouge qui le précède, avec le nom que donne `failedTests`.
 * Un message sans test nommé avant lui ne désigne rien et n'est pas retenu.
 */
export function timeoutLimits(output: string): Map<string, number> {
  const limits = new Map<string, number>();
  let current: string | null = null;
  for (const raw of stripAnsi(output).split('\n')) {
    if (FILE_LOAD_FAIL.test(raw)) continue;
    current = namedFailure(raw, current);
    const t = TIMEOUT.exec(raw);
    if (t && current) limits.set(current, Number(t[1]));
  }
  return limits;
}

/** Le test rouge qu'une ligne nomme, null quand elle ouvre un résumé de fin ou un nom vide, `current` quand elle n'en nomme aucun. */
function namedFailure(raw: string, current: string | null): string | null {
  if (SUMMARY.test(raw)) return null;
  for (const re of MARKERS) {
    const m = re.exec(raw);
    if (!m) continue;
    const name = clean(m[1]);
    return name && !/^(?:Test Files?|Tests?)\b/.test(name) ? name : null;
  }
  return current;
}

/**
 * La durée (ms) que la sortie d'un rejeu donne au test `name` du fichier `file` : la ligne du test (son dernier segment « suite > test » ou « Suite › test ») qui finit par une durée, sinon la ligne ✓ du fichier (« ✓ a.test.ts (3 tests) 24s »,
 * une borne haute pour le test). Null quand aucune durée ne se lit.
 */
export function testDurationMs(output: string, name: string, file: string): number | null {
  const leaf = name.split(/ > | › /).pop()!.trim();
  const lines = stripAnsi(output).split('\n');
  const byTest = leaf ? lines.find((l) => lineDurationMs(l) !== null && endsWithName(l, leaf)) : undefined;
  if (byTest) return lineDurationMs(byTest);
  const byFile = lines.find((l) => /^\s*[✓√]/.test(l) && l.includes(file) && lineDurationMs(l) !== null);
  return byFile ? lineDurationMs(byFile) : null;
}

const DURATION_END = /\s*\(?(\d+(?:\.\d+)?)\s*(ms|s)\)?\s*$/;

/** La durée (ms) qui finit une ligne de lanceur, null sans durée. */
function lineDurationMs(l: string): number | null {
  const m = DURATION_END.exec(l);
  return m ? Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1)) : null;
}

/** La ligne finit par `leaf` (puis sa durée), au début d'un mot : un nom qui n'est que le sous-texte d'un voisin (« plan » / « plan-data ») ne la désigne pas. */
function endsWithName(l: string, leaf: string): boolean {
  const bare = l.replace(DURATION_END, '').trimEnd();
  return bare.endsWith(leaf) && (bare.length === leaf.length || /[\s>›]/.test(bare[bare.length - leaf.length - 1]));
}

/** Échecs d'après le lot qui n'étaient pas rouges au départ (`nouveaux`) et ceux qui l'étaient déjà (`existants`). */
export function compareBaseline(now: string[], base: string[]): { nouveaux: string[]; existants: string[] } {
  const was = new Set(base);
  return { nouveaux: now.filter((t) => !was.has(t)), existants: now.filter((t) => was.has(t)) };
}
