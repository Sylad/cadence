import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPerfConfig } from './config.js';
import { readCache, readJournals, readSousCache } from './corrections.js';
import { type Day } from './dates.js';
import { computePerf, type PerfResult, perfWindows, readPlans, readProjectDeliveries, readProjectFailedEntries } from './perf.js';
import { RafError } from './plan.js';

/** `cadence perf` sur un dossier : lecture seule, une RafError dit pourquoi le dossier n'est pas lisible ; `warn` reçoit les avertissements (stderr de perf). */
export function readPerf(parent: string, today: Day, since: string | undefined, warn: (line: string) => void): PerfResult {
  // La grille se lit avant tout journal : une grille mal formée refuse la commande sans sortie partielle (R7).
  const prices = readPerfConfig(join(parent, 'cadence.yaml'));
  const runsDir = join(parent, '.cadence', 'runs');
  if (!existsSync(runsDir)) throw new RafError(`perf : aucun journal de vague dans ${runsDir}`);
  const cache = readCache(join(parent, '.cadence', 'corrections.json'));
  const journals = readJournals(runsDir);
  const warnings: string[] = [];
  // Les sous-causes (L447) n'arrêtent pas perf : un cache illisible avertit et la ligne est omise.
  const sousFile = join(parent, '.cadence', 'corrections-sous-causes.json');
  let sousCache: ReturnType<typeof readSousCache> | undefined;
  let sousWarning: string | undefined;
  try {
    sousCache = readSousCache(sousFile);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    sousWarning = `perf : ${sousFile} illisible, sous-causes n/d`;
  }
  const plans = readPlans(parent, (l) => warnings.push(l));
  if (plans.size === 0 && warnings.length === 0) warnings.push(`perf : aucun plan sous ${parent}, indicateurs du plan n/d`);
  const deliveries = readProjectDeliveries(parent, [...plans.keys()]);
  const failures = readProjectFailedEntries(parent, [...plans.keys()]);
  const failedDeliveries = new Map([...failures].map(([name, entries]) => [name, entries.map((e) => e.day)]));
  const result = computePerf({ journals, plans, cache, ...(sousCache ? { sousCache } : {}), deliveries, failedDeliveries, failures, prices, windows: perfWindows(today, since), today, since });
  if (!prices) warnings.push('perf : aucune grille de prix (cadence.yaml perf.prices), coût en euros n/d');
  for (const [model, lots] of Object.entries(result.cost.withoutPrice)) warnings.push(`perf : modèle sans prix dans perf.prices : ${model}, coût n/d pour ${lots} lot(s)`);
  if (sousWarning) warnings.push(sousWarning);
  warnings.forEach(warn);
  return result;
}
