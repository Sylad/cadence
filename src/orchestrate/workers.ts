// Part de la machine de chaque session (L350) : le 26-10, 32 cœurs et 4 sessions, vitest à 31 workers par suite, et des tests qui passaient seuls rougissaient ensemble.

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
