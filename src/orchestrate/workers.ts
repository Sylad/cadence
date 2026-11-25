// Part de la machine de chaque session (L350) : le 26-10, 32 cœurs et 4 sessions, vitest à 31 workers par suite, et des tests qui passaient seuls rougissaient ensemble.

import { isAbsolute, join, relative } from 'node:path';
import { failedTests, jestTestFiles, nodeTestFiles, nodeTestRan, testDurationMs, timeoutLimits } from './baseline.js';
import { NO_TEST_RAN, replayFile, replayRanFile, shellArg } from '../../scripts/rouges-porte.mjs';

// L842 : le fichier d'un rouge, la preuve qu'un rejeu l'a joué et la porte composée vivent dans scripts/rouges-porte.mjs, partagés avec la porte de `cadence run`.
export { isComposedGate, NO_TEST_RAN, replayFile, replayRanFile, shellArg } from '../../scripts/rouges-porte.mjs';

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
 * Le fichier à rejouer pour chaque nom rouge de `output` : le « location: » de node --test d'abord (L514 : un titre libre n'est pas un chemin, même s'il n'a pas d'espace), puis le nom (vitest, pytest), puis le fichier FAIL de jest.
 * `nodeTitles` dit si le nom est un titre node --test : son rejeu vert ne s'imprime pas avec son fichier, il se prouve par sa ligne « ok N - titre » (`nodeTestRan`).
 */
function fileResolver(output: string, at?: ReplayPlace): { (n: string): string | null; nodeTitles: Map<string, string> } {
  const jest = jestTestFiles(output);
  const nodeTitles = nodeTestFiles(output);
  // `at` : le worktree du lot où `output` a tourné, quand le rejeu a lieu ailleurs (L514). Le location: de node --test est un chemin absolu de ce worktree : rejoué tel quel dans un autre, il y rejouerait le fichier d'ici. Dans `at.root`, il se résout relatif à `at.dir`, le dossier de la partie où le rejeu se lance
  // (evatosorus : porte depuis `frontend/`, tests dans `scripts/`, donc `../scripts/x.test.mjs`) ; hors de `at.root` (porte jouée sur un hôte), il ne désigne aucun fichier du rejeu.
  const place = (f: string): string | null => {
    if (at === undefined || !isAbsolute(f)) return f;
    const inRoot = relative(at.root, f);
    return inRoot && !inRoot.startsWith('..') && !isAbsolute(inRoot) ? relative(join(at.root, at.dir ?? ''), f) : null;
  };
  return Object.assign((n: string): string | null => (nodeTitles.has(n) ? place(nodeTitles.get(n)!) : (replayFile(n) ?? jest.get(n) ?? null)), { nodeTitles });
}

/** Où la porte d'un lot a tourné, pour un rejeu ailleurs (L514) : `root` son worktree, `dir` le dossier de la partie relatif à `root` (absent : la racine). */
export interface ReplayPlace {
  root: string;
  dir?: string;
}

/** Rejeux d'un test rouge de la porte, seul (L354) : rouge aux deux, il est compté. */
const REPLAYS = 2;

/**
 * Parmi `names`, les tests rouges SEULS (L510) : `run` rejoue la commande `template` avec leurs fichiers, au plus `REPLAYS` fois ; un test reste s'il est nommé en échec par chaque rejeu, qui sort en échec. C'est une preuve positive : un rejeu qui échoue pour une autre raison
 * (build cassé, fichier introuvable) ne nomme pas le test et ne l'excuse pas. Un test sans fichier désignable n'est pas rejoué, donc n'est jamais retenu. `at` : le worktree où `output` a tourné, si le rejeu se fait dans un autre, et le dossier de la partie d'où le rejeu se lance
 * (les fichiers node --test, chemins absolus du worktree, sont relativisés à ce dossier). Sert à savoir si un rouge du lot était déjà rouge au sha de départ.
 */
export async function redAlone(run: (command: string) => Promise<{ code: number; output: string }>, template: string, names: string[], output: string, at?: ReplayPlace): Promise<string[]> {
  const fileOf = fileResolver(output, at);
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
