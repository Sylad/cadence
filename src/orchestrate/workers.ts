// Part de la machine de chaque session (L350) : le 26-10, 32 cœurs et 4 sessions, vitest à 31 workers par suite, et des tests qui passaient seuls rougissaient ensemble.

import { isAbsolute, relative } from 'node:path';
import { failedTests, jestTestFiles, nodeTestFiles, nodeTestRan, stripAnsi, testDurationMs, timeoutLimits } from './baseline.js';

/** Variable posée dans l'environnement des sessions et de la porte : le nombre de workers que leurs lanceurs de tests ont le droit d'ouvrir. */
export const TEST_WORKERS_ENV = 'CADENCE_TEST_WORKERS';

/** Cœurs ÷ plafond de sessions, arrondi vers le bas, jamais moins de 1 (cœurs inconnus ou plafond absurde compris). */
export function testWorkers(cores: number, cap: number): number {
  const c = Number.isFinite(cores) ? cores : 0;
  const k = Number.isFinite(cap) && cap >= 1 ? cap : 1;
  return Math.max(1, Math.floor(c / k));
}

/** La part d'une vague : la valeur CADENCE_TEST_WORKERS de l'environnement du lanceur quand c'est un entier positif (réglage de l'humain), sinon le calcul. */
export function testWorkersFrom(env: Record<string, string | undefined>, cores: number, cap: number): number {
  const set = env[TEST_WORKERS_ENV]?.trim();
  if (set && /^\d+$/.test(set) && Number(set) >= 1) return Number(set);
  return testWorkers(cores, cap);
}

/** Consigne des gabarits implement, fix, passe des mineurs et passe du bibliothécaire : les lanceurs de tests respectent la part de la session. */
export function testWorkersText(n: number): string {
  return `Machine share: the program splits the machine between the sessions of the wave, and yours gets \`${TEST_WORKERS_ENV}=${n}\` (cores ÷ session cap, in your environment and in the program's test gate). Every test runner you launch respects it: \`vitest run --minWorkers=1 --maxWorkers=$${TEST_WORKERS_ENV}\` (vitest 2 refuses \`--maxWorkers\` alone: its default minimum is the core count), \`jest --maxWorkers=$${TEST_WORKERS_ENV}\`, \`pytest -n $${TEST_WORKERS_ENV}\` (pytest-xdist), and the same option of any other runner; never the default (all the cores of the machine for each session at once: tests that pass alone then fail together, on timeouts). A test that fails in the whole suite and passes when run alone is a load failure, not a defect to fix.`;
}

/**
 * Le fichier à rejouer seul pour un test rouge : « fichier > suite > test » (vitest), « fichier::test » (pytest), « fichier » seul (jest : `FAIL src/a.test.ts`).
 * En espace de travail le nom est précédé de « |paquet| » : ce n'est pas une partie du chemin. Null quand le nom n'en désigne aucun (rien à rejouer seul) : y compris le « Suite › test » de jest, que `jestTestFiles` rattache au fichier FAIL qui le précède dans la même sortie.
 */
export function replayFile(test: string): string | null {
  // Le premier séparateur rencontré borne le chemin : un « :: » ou un « > » dans le titre du test (« a.test.ts > suite > cas::x ») n'en fait pas partie.
  const seps = [test.indexOf('::'), test.indexOf(' > ')].filter((i) => i >= 0);
  const head = seps.length ? test.slice(0, Math.min(...seps)) : /^\S+$/.test(test.trim()) ? test : '';
  const file = head.trim().replace(/^\|[^|\s]*\|\s+/, ''); // espace de travail vitest : « |paquet|  src/a.test.ts »
  return /^\S.*\.\w+$/.test(file) ? file : null;
}

/**
 * Le fichier à rejouer pour chaque nom rouge de `output` : le « location: » de node --test d'abord (L514 : un titre libre n'est pas un chemin, même s'il n'a pas d'espace), puis le nom (vitest, pytest), puis le fichier FAIL de jest.
 * `nodeTitles` dit si le nom est un titre node --test : son rejeu vert ne s'imprime pas avec son fichier, il se prouve par sa ligne « ok N - titre » (`nodeTestRan`).
 */
function fileResolver(output: string, root?: string): { (n: string): string | null; nodeTitles: Map<string, string> } {
  const jest = jestTestFiles(output);
  const nodeTitles = nodeTestFiles(output);
  // `root` : le dossier où `output` a tourné, quand le rejeu a lieu ailleurs (L514). Le location: de node --test est un chemin absolu de ce dossier : rejoué tel quel dans un autre worktree, il y rejouerait le fichier d'ici. Relatif à `root`, il se résout dans le dossier du rejeu ; hors de `root` (porte jouée sur un hôte), il ne désigne aucun fichier du rejeu.
  const place = (f: string): string | null => {
    if (root === undefined || !isAbsolute(f)) return f;
    const rel = relative(root, f);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
  };
  return Object.assign((n: string): string | null => (nodeTitles.has(n) ? place(nodeTitles.get(n)!) : (replayFile(n) ?? jest.get(n) ?? null)), { nodeTitles });
}

/** Un argument de commande sans risque pour `sh -c` : tel quel s'il est simple, entre apostrophes sinon. */
export function shellArg(s: string): string {
  return /^[\w./@+=,:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Une porte composée : plusieurs lanceurs ou un sous-shell, c'est-à-dire un `&&` ou un `||` hors apostrophes et guillemets, ou une parenthèse (sous-shell `( … )`, substitution `$( … )`, fonction). Le premier lanceur qui rougit coupe avant le suivant :
 * le rejeu seul d'un de ses tests ne dit rien du reste. `orchestrate.testReplay` est refusé à la lecture de cadence.yaml pour une telle porte (L354) : le rejeu seul ne vaut que pour un lanceur unique.
 */
export function isComposedGate(command: string): boolean {
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
export function replayRanFile(output: string, file: string): boolean {
  const re = new RegExp(`(?:^|[^\\w./-])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
  return stripAnsi(output)
    .split('\n')
    .some((line) => !LAUNCHER_ECHO.test(line) && re.test(line));
}

/** Sortie d'un lanceur qui n'a trouvé aucun test à rejouer : la ligne de fin du lanceur (vitest « No test files found, exiting with code », jest « No tests found, exiting with code », pytest « no tests ran in »), en début de ligne — pas ces mots cités dans le titre ou la sortie d'un test. */
const NO_TEST_RAN = /^\W*(?:no test files? found, exiting with code|no tests? found, exiting with code|no tests ran in)\b/im;

/** Rejeux d'un test rouge de la porte, seul (L354) : rouge aux deux, il est compté. */
const REPLAYS = 2;

/**
 * Parmi `names`, les tests rouges SEULS (L510) : `run` rejoue la commande `template` avec leurs fichiers, au plus `REPLAYS` fois ; un test reste s'il est nommé en échec par chaque rejeu, qui sort en échec. C'est une preuve positive : un rejeu qui échoue pour une autre raison
 * (build cassé, fichier introuvable) ne nomme pas le test et ne l'excuse pas. Un test sans fichier désignable n'est pas rejoué, donc n'est jamais retenu. `root` : le dossier où `output` a tourné, si le rejeu se fait dans un autre (les fichiers node --test, chemins absolus, y sont relativisés). Sert à savoir si un rouge du lot était déjà rouge au sha de départ.
 */
export async function redAlone(run: (command: string) => Promise<{ code: number; output: string }>, template: string, names: string[], output: string, root?: string): Promise<string[]> {
  const fileOf = fileResolver(output, root);
  let still = [...new Set(names)].filter((n) => fileOf(n));
  for (let i = 0; i < REPLAYS && still.length; i++) {
    const files = [...new Set(still.map((n) => fileOf(n)!))];
    const r = await run(template.replaceAll('{files}', () => files.map(shellArg).join(' ')));
    const failing = r.code === 0 ? new Set<string>() : new Set(failedTests(r.output));
    still = still.filter((n) => failing.has(n));
  }
  return still;
}

/** Un test vert seul mais à au moins cette part de son délai est un « délai trop juste » (L510) : 25 s pour 30 s le 31-10 (warhammer L61). */
const TIGHT_RATIO = 0.8;

/** Un test dont le rejeu seul a duré `ms` pour un délai de `limit` ms. */
export interface TightTest {
  test: string;
  ms: number;
  limit: number;
}

/**
 * Rejoue SEULS les tests `names` rouges dans `output` (L354, L387) : `run` exécute la commande `template` où `{files}` devient les fichiers de ces tests, dans le dossier de l'appelant (worktree du lot, de la ligne de base ou de `verify --gate`).
 * Un test vert à un rejeu est `unstable` (et `tight` quand sa durée seul est près de son délai, L510) ; rouge aux `REPLAYS` rejeux, ou sans fichier désignable (rien à rejouer seul), il reste dans `red`.
 */
export async function replayRed(run: (command: string) => Promise<{ code: number; output: string }>, template: string, names: string[], output: string): Promise<{ red: string[]; unstable: string[]; tight: TightTest[] }> {
  const fileOf = fileResolver(output);
  let red = [...new Set(names)];
  const unstable: string[] = [];
  const tight: TightTest[] = [];
  const limits = timeoutLimits(output);
  for (let i = 0; i < REPLAYS; i++) {
    const replayable = red.filter((n) => fileOf(n));
    const files = [...new Set(replayable.map((n) => fileOf(n)!))];
    if (!files.length) break;
    const r = await run(template.replaceAll('{files}', () => files.map(shellArg).join(' ')));
    // Seul un rejeu qui sort en 0 en ayant exécuté le FICHIER du test vaut vert. Un rejeu en échec ne conclut rien pour un test qu'il ne nomme pas : sur une porte composée (`a && b`) les fichiers n'atteignent que le dernier lanceur, un premier lanceur qui rougit coupe avant lui. Un rejeu sans test exécuté (filtre sans fichier, `passWithNoTests`) sort en 0 sans rien prouver, et un lanceur qui ignore sans rien dire un fichier qu'il ne trouve pas (vitest d'un autre espace de travail) sort en 0 sans l'avoir joué : le fichier doit figurer, chemin entier, sur une ligne du lanceur de la sortie du rejeu, hors écho de la commande par npm/pnpm/yarn (`replayRanFile`). Un test node --test vert n'imprime pas son fichier : sa preuve est sa ligne « ok N - titre » (`nodeTestRan`, L514).
    const ran = r.code === 0 && !NO_TEST_RAN.test(r.output);
    const passed = ran ? replayable.filter((n) => (fileOf.nodeTitles.has(n) ? nodeTestRan(r.output, n) : replayRanFile(r.output, fileOf(n)!))) : [];
    unstable.push(...passed);
    // L510 : vert seul mais expiré dans la suite, et la durée du rejeu est près du délai : le test est trop juste, pas bugué. Sans délai lu dans la suite ou sans durée lisible au rejeu, rien n'est dit.
    for (const n of passed) {
      const limit = limits.get(n);
      const ms = limit ? testDurationMs(r.output, n, fileOf(n)!) : null;
      if (limit && ms !== null && ms >= TIGHT_RATIO * limit) tight.push({ test: n, ms, limit });
    }
    red = red.filter((n) => !passed.includes(n));
  }
  return { red, unstable, tight };
}
