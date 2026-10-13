// Ligne de base des tests (L213) : un lot n'est pas rendu « tests rouges » pour des échecs déjà présents au sha de départ.

/* eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;]*m/g;

/** Marqueurs d'échec des lanceurs courants : vitest/jest (FAIL, ●), pytest (FAILED, ERROR), go (--- FAIL:), TAP (not ok). */
const MARKERS: RegExp[] = [/^\s*FAIL(?:ED)?\s+(.+)$/, /^\s*ERROR\s+(\S+::.+)$/, /^\s*--- FAIL:\s+(\S+)/, /^\s*not ok\s+\d*\s*-?\s*(.+)$/, /^\s*●\s+(.+)$/];

/** Identifiant pytest « chemin::test[param] » : coupe le message (« - assert … ») au premier « - » hors crochets. */
function pytestId(s: string): string {
  if (!s.includes('::')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && depth > 0) depth--;
    else if (depth === 0 && /\s/.test(s[i]) && /^\s+-(?:\s|$)/.test(s.slice(i))) return s.slice(0, i);
  }
  return s;
}

/** vitest, fichier de test qui ne se charge pas : « FAIL  a.test.ts [ a.test.ts ] » (le nom du fichier répété entre crochets, avec « |projet| » en espace de travail). */
const FILE_LOAD_FAIL = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?(\S+)\s+\[\s*\1\s*\]\s*$/;

const clean = (s: string): string =>
  pytestId(s)
    .replace(/\s+-\s+(?:Assertion|\w*Error)\b.*$/, '') // pytest : « - AssertionError: … »
    .replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/, '') // durée finale
    .trim();

/**
 * Identifiants des tests en échec lus dans la sortie d'un lanceur (triés, sans doublon). Vide quand rien n'est identifiable :
 * l'appelant ne peut alors rien comparer et garde les tests pour rouges.
 */
export function failedTests(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.replace(ANSI, '').split('\n')) {
    if (FILE_LOAD_FAIL.test(raw)) continue; // échec sans nom (cf. hasUnnamedFailure), pas un test
    for (const re of MARKERS) {
      const m = re.exec(raw);
      if (!m) continue;
      const name = clean(m[1]);
      if (name && !/^(?:Test Files?|Tests?)\b/.test(name)) found.add(name);
      break;
    }
  }
  return [...found].sort();
}

/** Échecs d'après le lot qui n'étaient pas rouges au départ (`nouveaux`) et ceux qui l'étaient déjà (`existants`). */
export function compareBaseline(now: string[], base: string[]): { nouveaux: string[]; existants: string[] } {
  const was = new Set(base);
  return { nouveaux: now.filter((t) => !was.has(t)), existants: now.filter((t) => was.has(t)) };
}

/**
 * Un échec que la sortie ne rattache à aucun test : erreur non gérée (vitest « Unhandled Errors », promesse rejetée), fichier de spec qui ne se charge plus (jest « Test suite failed to run », vitest « FAIL  a.test.ts [ a.test.ts ] » : le FAIL de fichier existait peut-être au départ), seuil de
 * couverture non atteint. Comparer les seuls noms lus le masquerait derrière d'anciens échecs : l'appelant garde les tests pour rouges.
 */
export function hasUnnamedFailure(output: string): boolean {
  const text = output.replace(ANSI, '');
  if (text.split('\n').some((l) => FILE_LOAD_FAIL.test(l))) return true;
  return /Unhandled (?:Errors?|Rejections?)|Test suite failed to run|caught \d+ unhandled|coverage threshold|Coverage for \w+ \([\d.]+%\) does not meet/i.test(text);
}
