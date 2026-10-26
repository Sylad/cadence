// Part de la machine de chaque session (L350) : le 26-10, 32 cœurs et 4 sessions, vitest à 31 workers par suite, et des tests qui passaient seuls rougissaient ensemble.

import { stripAnsi } from './baseline.js';

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
