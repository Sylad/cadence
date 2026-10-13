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

/**
 * Le résultat annoncé par une session aux tests rouges (L215) ne nomme que des échecs de base qu'elle a déclarés (`echecsDeBase`) : vert:false n'est alors pas une raison de correction.
 * Les échecs nommés sont ceux que le lanceur désigne (lignes FAIL…) et les tests déclarés cités tels quels dans le texte. Faux dès qu'un échec nommé n'est pas déclaré, qu'aucun n'est nommé (« 24 failed » ne prouve rien),
 * que le texte annonce plus d'échecs que de tests nommés, ou qu'un échec reste sans nom.
 */
export function onlyDeclaredFailures(resultat: string, declared: string[]): boolean {
  const text = resultat.replace(ANSI, '');
  const known = new Set(declared);
  const named = new Set(failedTests(text));
  if ([...named].some((t) => !known.has(t))) return false;
  for (const t of declared) if (text.includes(t)) named.add(t);
  if (!named.size || hasUnnamedFailure(text)) return false;
  // Plus grand nombre annoncé avant « failed / échec(s) » (« 3 failed », « 2 tests en échec »), hors ligne vitest « Test Files » (comptée en fichiers).
  const counts = text
    .split('\n')
    .filter((l) => !/^\s*Test Files?\b/i.test(l))
    .flatMap((l) => [...l.matchAll(/\b(\d+)\s+(?:\p{L}+\s+)?(?:en\s+)?(?:failed|failing|failures?|échecs?)\b/giu)].map((m) => Number(m[1])));
  return !counts.length || Math.max(...counts) <= named.size;
}
