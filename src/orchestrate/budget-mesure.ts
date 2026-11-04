import { isDay, toDay, type Day } from '../dates.js';
import { readPerf } from '../perf-read.js';
import { RafError } from '../plan.js';
import type { MeasuredBudgets, MeasuredTokens } from './lot-budget.js';

/**
 * La mesure du budget d'un lot (L501) : le p90 des tokens par classe d'estimate que `cadence perf` calcule sur <launch>/.cadence/runs (14 jours glissants finissant à `today`).
 * Un dossier sans journal de vague, ou que perf ne sait pas lire, donne une mesure vide : les budgets restent les statiques.
 */
export function readMeasuredBudgets(launch: string, today: Day): MeasuredBudgets {
  const out = new Map<string, MeasuredTokens>();
  try {
    const { tokens } = readPerf(launch, today, undefined, () => {});
    for (const [key, c] of Object.entries(tokens.byEstimate)) if (c.p90 !== null) out.set(key, { p90: c.p90, lots: c.p90Lots });
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
  }
  return out;
}

/** La mesure à l'instant d'un `OrchestrateIo` (le jour est RAF_TODAY quand il est valide, à défaut celui de `now`) ; `undefined` quand elle est vide (aucun journal) : les budgets, et leur base dans `--dry-run`, restent ceux de l'estimate. */
export function measuredBudgetsAt(launch: string, io: { env: NodeJS.ProcessEnv; now: () => Date }): MeasuredBudgets | undefined {
  const m = readMeasuredBudgets(launch, io.env.RAF_TODAY && isDay(io.env.RAF_TODAY) ? io.env.RAF_TODAY : toDay(io.now()));
  return m.size ? m : undefined;
}
