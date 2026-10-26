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

/**
 * vitest, fichier de test qui ne se charge pas : « FAIL  a.test.ts [ a.test.ts ] ». Seule une entrée de fichier porte le suffixe « [ chemin ] » (un test ou une suite contient toujours « > »).
 * En espace de travail, le fichier est relatif à la racine du projet (précédé de « |projet| ») et les crochets à la racine du lancement : « FAIL  |pa|  src/a.test.ts [ packages/a/src/a.test.ts ] », donc pas de comparaison des deux.
 * Le crochet doit finir par une extension : « FAIL\tgithub.com/x/y [build failed] » (go) n'est pas un fichier.
 */
const FILE_LOAD_FAIL = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?[^>]+?\s+\[\s*[^\]]*\.\w+\s*\]\s*$/;

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

/** Fichiers de test qui ne se chargent pas (vitest « FAIL  a.test.ts [ a.test.ts ] »), triés, sans doublon : les échecs que `failedTests` laisse de côté faute de test à nommer. */
export function unloadedSuites(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.replace(ANSI, '').split('\n')) {
    if (!FILE_LOAD_FAIL.test(raw)) continue;
    const name = raw.replace(/^\s*FAIL\s+/, '').replace(/\s+\[[^\]]*\]\s*$/, '').trim();
    if (name) found.add(name);
  }
  return [...found].sort();
}

/** Sortie sans les séquences de couleur du lanceur. */
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/**
 * jest : le fichier de chaque « ● Suite › test » et de chaque ligne « FAIL projet fichier » (nom rouge à part entière avec displayName), celui de la dernière ligne `FAIL fichier` qui le précède dans la même sortie (L354). Un test jest ne porte pas son fichier dans son nom ;
 * sans cette lecture on ne saurait pas quel fichier rejouer pour lui, ni si le rejeu l'a couvert.
 */
export function jestTestFiles(output: string): Map<string, string> {
  const files = new Map<string, string>();
  let file: string | null = null;
  for (const raw of stripAnsi(output).split('\n')) {
    const f = /^\s*(PASS|FAIL)\b(.*)$/.exec(raw);
    if (f) {
      // « FAIL src/a.test.ts », « FAIL src/a.test.ts (6.21 s) » (jest ajoute la durée au-delà de 5 s : un fichier lent sous charge) ou « FAIL projet src/a.test.ts » (displayName) : le fichier est le dernier mot. Toute autre ligne PASS/FAIL ne désigne aucun fichier : ne pas garder le précédent.
      const last = f[1] === 'FAIL' ? f[2].replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).pop() ?? '' : '';
      file = /^[^\s|]+\.\w+$/.test(last) ? last : null;
      if (file) files.set(clean(f[2]), file); // « FAIL projet fichier » est lui-même un nom rouge (failedTests) : son fichier est le sien
    }
    const t = /^\s*●\s+(.+)$/.exec(raw);
    if (t && file) files.set(clean(t[1]), file);
  }
  return files;
}

/** Échecs d'après le lot qui n'étaient pas rouges au départ (`nouveaux`) et ceux qui l'étaient déjà (`existants`). */
export function compareBaseline(now: string[], base: string[]): { nouveaux: string[]; existants: string[] } {
  const was = new Set(base);
  return { nouveaux: now.filter((t) => !was.has(t)), existants: now.filter((t) => was.has(t)) };
}

/**
 * Un échec que la sortie ne rattache à aucun test : erreur non gérée (vitest « Unhandled Errors », promesse rejetée), fichier de spec qui ne se charge plus (jest « Test suite failed to run », vitest « FAIL  a.test.ts [ a.test.ts ] » : le FAIL de fichier existait peut-être au départ), seuil de
 * couverture non atteint. `loadFailsNamed` : l'appelant nomme déjà les fichiers qui ne se chargent pas (`unloadedSuites`), ils ne comptent plus comme échec sans nom. Comparer les seuls noms lus le masquerait derrière d'anciens échecs : l'appelant garde les tests pour rouges.
 */
export function hasUnnamedFailure(output: string, loadFailsNamed = false): boolean {
  const text = output.replace(ANSI, '');
  if (!loadFailsNamed && text.split('\n').some((l) => FILE_LOAD_FAIL.test(l))) return true;
  return /Unhandled (?:Errors?|Rejections?)|Test suite failed to run|caught \d+ unhandled|coverage threshold|Coverage for \w+ \([\d.]+%\) does not meet/i.test(text);
}
