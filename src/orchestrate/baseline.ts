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

const TAP_NOT_OK = /^\s*not ok\s+\d*\s*-?\s*(.+)$/;
const TAP_LINE = /^\s*(?:not ok|ok)\b|^\s*# Subtest\b/;

/**
 * node --test (TAP) : le fichier de chaque test rouge, lu dans le « location: '/chemin/fichier.mjs:ligne:colonne' » du bloc YAML qui suit sa ligne « not ok N - titre » (L514). Le lanceur nomme un test par son titre, jamais par son fichier.
 * Le bloc finit à la ligne TAP suivante : un rouge sans location: (Node ancien) n'a pas de fichier, il ne prend pas celui d'un test suivant. Un titre rouge dans deux fichiers différents est ambigu et sans fichier : le rejeu d'un fichier ne dirait rien de l'autre.
 */
export function nodeTestFiles(output: string): Map<string, string> {
  const files = new Map<string, string>();
  const ambiguous = new Set<string>();
  let title: string | null = null;
  for (const raw of stripAnsi(output).split('\n')) {
    if (TAP_LINE.test(raw)) {
      const m = TAP_NOT_OK.exec(raw);
      title = m ? clean(m[1]) || null : null;
      continue;
    }
    const loc = title ? /^\s*location:\s*'(.+?):\d+:\d+'\s*$/.exec(raw) : null;
    if (!loc || !title) continue;
    if (files.has(title) && files.get(title) !== loc[1]) ambiguous.add(title);
    files.set(title, loc[1]);
    title = null;
  }
  for (const t of ambiguous) files.delete(t);
  return files;
}

/** Le test `title` a-t-il tourné et réussi dans cette sortie node --test (TAP) : une ligne « ok N - titre » exacte, ni sautée (# SKIP) ni à faire (# TODO). Un test vert n'imprime pas son fichier : c'est la seule preuve (L514). */
export function nodeTestRan(output: string, title: string): boolean {
  return stripAnsi(output).split('\n').some((l) => {
    const m = /^\s*ok\s+\d+\s*-\s*(.+)$/.exec(l);
    return !!m && clean(m[1]) === title;
  });
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
