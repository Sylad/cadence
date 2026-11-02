// corrections et perf : les mesures du workflow, sans modèle ni écriture (L488, sorti de cli.ts).
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPerfConfig } from '../config.js';
import { type Day } from '../dates.js';
import { RafError } from '../plan.js';
import { renderTestsSansCode, testsSansCode } from '../corrections-sans-code.js';
import { bugCodeOf, bugCodePasses, classifyAll, classifySous, measure, ollamaClassifier, ollamaSousClassifier, readCache, readJournals, readRuns, readSousCache, renderReport, sampleKeys, serializeCache, serializeSousCache } from '../corrections.js';
import { computePerf, type PerfResult, perfWindows, readPlans, readProjectDeliveries, readProjectFailedEntries, renderPerf } from '../perf.js';
import { type Io } from './context.js';

/** `cadence corrections` (L165) : la mesure de référence des passes de correction d'une vague, lue dans <dossier>/.cadence/runs. */
export async function corrections(rest: string[], values: { classify?: boolean; model?: string; cache?: string; 'cache-sous-causes'?: string; sample?: string; until?: string; since?: string; json?: boolean }, io: Io): Promise<number> {
  if (rest.length > 1) throw new RafError('usage : cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--cache-sous-causes fichier] [--sample n] [--until date] [--since date] [--json]');
  const parent = resolve(io.cwd, rest[0] ?? '.');
  const runsDir = join(parent, '.cadence', 'runs');
  if (!existsSync(runsDir)) throw new RafError(`corrections : aucun journal de vague dans ${runsDir}`);
  const sample = values.sample === undefined ? undefined : Number(values.sample);
  if (sample !== undefined && !(Number.isInteger(sample) && sample > 0)) throw new RafError(`--sample invalide : ${values.sample}`);
  if (values.until !== undefined && Number.isNaN(Date.parse(values.until))) throw new RafError(`--until invalide : ${values.until} (une date ISO, ex. 2026-10-10T18:31Z)`);
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new RafError(`--since invalide : ${values.since} (une date ISO, ex. 2026-10-10T18:31Z)`);
  const model = values.model ?? 'mistral-small3.2:24b';
  const cacheFile = resolve(io.cwd, values.cache ?? join(parent, '.cadence', 'corrections.json'));
  const data = readRuns(runsDir, values.until, values.since);
  const sousFile = resolve(io.cwd, values['cache-sous-causes'] ?? join(parent, '.cadence', 'corrections-sous-causes.json'));
  const cache = readCache(cacheFile);
  // R5 (L447) : le cache des sous-causes illisible sort avec le code 1 de la fiche (corrections.json illisible sort avec 2, par `failure`).
  let sousCache: ReturnType<typeof readSousCache>;
  try {
    sousCache = readSousCache(sousFile);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    io.err(`raf: ${e.message}`);
    return 1;
  }
  if (values.classify) {
    const url = io.env.OLLAMA_HOST ?? 'http://localhost:11434';
    await classifyAll(data.passes, cache, ollamaClassifier({ url, model }), model, (done, total) => {
      if (done % 25 === 0 || done === total) io.err(`classement : ${done}/${total}`);
    }, { every: 10, save: () => writeFileSync(cacheFile, serializeCache(cache)) });
    writeFileSync(cacheFile, serializeCache(cache));
    const saveSous = () => writeFileSync(sousFile, serializeSousCache(sousCache));
    const added = await classifySous(data.passes, cache, sousCache, ollamaSousClassifier({ url, model }), model, (done, total) => {
      if (done % 25 === 0 || done === total) io.err(`sous-causes : ${done}/${total}`);
    }, { every: 10, save: saveSous });
    if (added > 0) saveSous();
  }
  if (sample !== undefined) {
    const byKey = new Map(data.passes.map((p) => [p.key, p]));
    // Une passe sans constat (tests rouges) n'a rien à relire : elle ne fait pas partie de l'échantillon.
    for (const key of sampleKeys(data.passes.filter((p) => p.findings.length > 0).map((p) => p.key), sample)) {
      const p = byKey.get(key)!;
      io.out(`## ${key} (${p.project} ${p.lot}) · modèle : ${cache.get(key)?.cause ?? 'non classé'}${cache.get(key)?.manual ? ` · relu : ${cache.get(key)!.manual}` : ''}`);
      for (const f of p.findings) io.out(`- ${f}`);
      for (const c of p.commits) io.out(`  commit : ${c}`);
      io.out('');
    }
    return 0;
  }
  const m = measure(data, cache);
  const bugCode = bugCodeOf(bugCodePasses(data.passes, cache), sousCache);
  const sansCode = testsSansCode(data.passes);
  io.out(values.json ? JSON.stringify({ ...m, testsSansCode: sansCode, ...(bugCode ? { bugCode } : {}) }, null, 2) : [renderReport(m, bugCode), ...renderTestsSansCode(sansCode)].join('\n'));
  return 0;
}

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

/**
 * `cadence perf` (L225) : le tableau de bord du workflow, sans modèle ni écriture, lu dans <dossier>/.cadence/runs et les plans des projets du dossier.
 * Une erreur de saisie ou de lecture sort avec le code 1 (un ⚠ imprimé, 0). `--since` y est un jour qui tronque les fenêtres, non l'instant de `corrections --since`.
 */
export function perf(rest: string[], values: { since?: string; json?: boolean }, today: Day, io: Io): number {
  try {
    if (rest.length > 1) throw new RafError('usage : cadence perf [dossier] [--since date] [--json]');
    if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new RafError(`--since invalide : ${values.since} (une date ISO, ex. 2026-10-10T18:31Z)`);
    const parent = resolve(io.cwd, rest[0] ?? '.');
    const result = readPerf(parent, today, values.since, io.err);
    if (values.json) io.out(JSON.stringify(result, null, 2));
    else for (const l of renderPerf(result)) io.out(l);
    return 0;
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    io.err(`raf: ${e.message}`);
    return 1;
  }
}
