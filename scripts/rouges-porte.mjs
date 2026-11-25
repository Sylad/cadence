// Lecture des tests rouges dans la sortie d'un lanceur, et preuve qu'un rejeu a joué un fichier : une seule définition pour les vagues et
// `cadence verify --gate` (src/orchestrate/baseline.ts et workers.ts les réexportent, L213, L354, L510, L514) et pour la porte de `cadence run`
// (scripts/rejeu-rouges.mjs, L842). JavaScript sans dépendance, comme scripts/etapes-porte.mjs : src et v2 l'importent hors de leur rootDir.

/* eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;]*m/g;

/** Ligne TAP « not ok N - titre » : partagée par failedTests (MARKERS) et nodeTestFiles, qui doivent nettoyer le titre de la même façon. */
const TAP_NOT_OK = /^\s*not ok\s+\d*\s*-?\s*(.+)$/;

/** Marqueurs d'échec des lanceurs courants : vitest/jest (FAIL, ●), pytest (FAILED, ERROR), go (--- FAIL:), TAP (not ok). */
export const MARKERS = [/^\s*FAIL(?:ED)?\s+(.+)$/, /^\s*ERROR\s+(\S+::.+)$/, /^\s*--- FAIL:\s+(\S+)/, TAP_NOT_OK, /^\s*●\s+(.+)$/];

/** Identifiant pytest « chemin::test[param] » : coupe le message (« - assert … ») au premier « - » hors crochets. */
function pytestId(s) {
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
export const FILE_LOAD_FAIL = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?[^>]+?\s+\[\s*[^\]]*\.\w+\s*\]\s*$/;

/** Un nom de test lu après un marqueur, nettoyé du message d'erreur et de la durée finale. */
export const clean = (s) =>
  pytestId(s)
    .replace(/\s+-\s+(?:Assertion|\w*Error)\b.*$/, '') // pytest : « - AssertionError: … »
    .replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/, '') // durée finale
    .trim();

/** Sortie sans les séquences de couleur du lanceur. */
export const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * Identifiants des tests en échec lus dans la sortie d'un lanceur (triés, sans doublon). Vide quand rien n'est identifiable :
 * l'appelant ne peut alors rien comparer et garde les tests pour rouges.
 */
export function failedTests(output) {
  const found = new Set();
  for (const raw of stripAnsi(output).split('\n')) {
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
export function unloadedSuites(output) {
  const found = new Set();
  for (const raw of stripAnsi(output).split('\n')) {
    if (!FILE_LOAD_FAIL.test(raw)) continue;
    const name = raw.replace(/^\s*FAIL\s+/, '').replace(/\s+\[[^\]]*\]\s*$/, '').trim();
    if (name) found.add(name);
  }
  return [...found].sort();
}

/**
 * jest : le fichier de chaque « ● Suite › test » et de chaque ligne « FAIL projet fichier » (nom rouge à part entière avec displayName), celui de la dernière ligne `FAIL fichier` qui le précède dans la même sortie (L354). Un test jest ne porte pas son fichier dans son nom ;
 * sans cette lecture on ne saurait pas quel fichier rejouer pour lui, ni si le rejeu l'a couvert.
 */
export function jestTestFiles(output) {
  const files = new Map();
  let file = null;
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

const TAP_LINE = /^\s*(?:not ok|ok)\b|^\s*# Subtest\b/;

/**
 * node --test (TAP) : le fichier de chaque test rouge, lu dans le « location: '/chemin/fichier.mjs:ligne:colonne' » du bloc YAML qui suit sa ligne « not ok N - titre » (L514). Le lanceur nomme un test par son titre, jamais par son fichier.
 * Le bloc finit à la ligne TAP suivante : un rouge sans location: (Node ancien) n'a pas de fichier, il ne prend pas celui d'un test suivant. Un titre rouge dans deux fichiers différents est ambigu et sans fichier : le rejeu d'un fichier ne dirait rien de l'autre.
 */
export function nodeTestFiles(output) {
  const files = new Map();
  const ambiguous = new Set();
  let title = null;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
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
export function nodeTestRan(output, title) {
  return stripAnsi(output).split(/\r?\n/).some((l) => {
    const m = /^\s*ok\s+\d+\s*-\s*(.+)$/.exec(l);
    return !!m && clean(m[1]) === title;
  });
}

/**
 * Un échec que la sortie ne rattache à aucun test : erreur non gérée (vitest « Unhandled Errors », promesse rejetée), fichier de spec qui ne se charge plus (jest « Test suite failed to run », vitest « FAIL  a.test.ts [ a.test.ts ] » : le FAIL de fichier existait peut-être au départ), seuil de
 * couverture non atteint. `loadFailsNamed` : l'appelant nomme déjà les fichiers qui ne se chargent pas (`unloadedSuites`), ils ne comptent plus comme échec sans nom. Comparer les seuls noms lus le masquerait derrière d'anciens échecs : l'appelant garde les tests pour rouges.
 */
export function hasUnnamedFailure(output, loadFailsNamed = false) {
  const text = stripAnsi(output);
  if (!loadFailsNamed && text.split('\n').some((l) => FILE_LOAD_FAIL.test(l))) return true;
  return /Unhandled (?:Errors?|Rejections?)|Test suite failed to run|caught \d+ unhandled|coverage threshold|Coverage for \w+ \([\d.]+%\) does not meet/i.test(text);
}

/**
 * Le fichier à rejouer seul pour un test rouge : « fichier > suite > test » (vitest), « fichier::test » (pytest), « fichier » seul (jest : `FAIL src/a.test.ts`).
 * En espace de travail le nom est précédé de « |paquet| » : ce n'est pas une partie du chemin. Null quand le nom n'en désigne aucun (rien à rejouer seul) : y compris le « Suite › test » de jest, que `jestTestFiles` rattache au fichier FAIL qui le précède dans la même sortie.
 */
export function replayFile(test) {
  // Le premier séparateur rencontré borne le chemin : un « :: » ou un « > » dans le titre du test (« a.test.ts > suite > cas::x ») n'en fait pas partie.
  const seps = [test.indexOf('::'), test.indexOf(' > ')].filter((i) => i >= 0);
  const head = seps.length ? test.slice(0, Math.min(...seps)) : /^\S+$/.test(test.trim()) ? test : '';
  const file = head.trim().replace(/^\|[^|\s]*\|\s+/, ''); // espace de travail vitest : « |paquet|  src/a.test.ts »
  return /^\S.*\.\w+$/.test(file) ? file : null;
}

/** Un argument de commande sans risque pour `sh -c` : tel quel s'il est simple, entre apostrophes sinon. */
export function shellArg(s) {
  return /^[\w./@+=,:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Une porte composée : plusieurs lanceurs ou un sous-shell, c'est-à-dire un `&&` ou un `||` hors apostrophes et guillemets, ou une parenthèse (sous-shell `( … )`, substitution `$( … )`, fonction). Le premier lanceur qui rougit coupe avant le suivant :
 * le rejeu seul d'un de ses tests ne dit rien du reste. `orchestrate.testReplay` est refusé à la lecture de cadence.yaml pour une telle porte (L354) : le rejeu seul ne vaut que pour un lanceur unique.
 */
export function isComposedGate(command) {
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || command.startsWith('&&', i) || command.startsWith('||', i)) return true;
  }
  return false;
}

/** Une ligne d'écho de la commande par son lanceur de paquets, qui recopie ses arguments (les fichiers rejoués compris) : npm 12 « npm notice run … », « npm warn … », « npm ERR! … » ; npm et pnpm « > vitest run … » ; yarn « $ vitest run … ». */
const LAUNCHER_ECHO = /^\s*(?:npm (?:notice|warn|WARN|ERR!?|error)\b|>\s|\$\s)/;

/**
 * Le rejeu a-t-il exécuté ce fichier (L354) ? Il figure, chemin entier, sur une ligne du lanceur : ni une fin d'un autre chemin (`a.test.ts` dans `src/a.test.ts`), ni une ligne d'écho de la commande par npm, pnpm ou yarn, qui recopie
 * tous les fichiers demandés, ceux qu'un lanceur d'un autre espace de travail n'a pas joués compris. Mesuré le 26-10 : npm 12.2.0 écrit « npm notice run 'vitest' run … <fichiers> » sur stderr pour `npx …` comme pour `npm test -- …`.
 */
export function replayRanFile(output, file) {
  const re = new RegExp(`(?:^|[^\\w./-])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
  return stripAnsi(output)
    .split('\n')
    .some((line) => !LAUNCHER_ECHO.test(line) && re.test(line));
}

/** Sortie d'un lanceur qui n'a trouvé aucun test à rejouer : la ligne de fin du lanceur (vitest « No test files found, exiting with code », jest « No tests found, exiting with code », pytest « no tests ran in »), en début de ligne — pas ces mots cités dans le titre ou la sortie d'un test. */
export const NO_TEST_RAN = /^[^\w\n]{0,40}(?:no test files? found, exiting with code|no tests? found, exiting with code|no tests ran in)\b/im;
