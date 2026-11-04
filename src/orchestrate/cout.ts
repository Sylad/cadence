import { join } from 'node:path';
import { readPerfSettings, type PerfConfig, type PriceGrid } from '../perf-config.js';
import { COUNTED_INPUT_SHARE, euros, missingModels, stepEuros, sumEuros, waveEuros } from '../cost.js';
import { RafError } from '../plan.js';
import type { LotState } from './state.js';

/**
 * `perf` du cadence.yaml du dossier de lancement (L529), le même que lit `cadence perf` : la grille de prix et sa monnaie. Une grille mal formée n'interdit ni une simulation
 * ni un tableau (perdre le tableau d'une vague payée serait pire que d'en retirer les montants) : `warn` reçoit pourquoi, et la grille est absente.
 */
export function launchCost(launch: string, warn: (line: string) => void): PerfConfig {
  try {
    return readPerfSettings(join(launch, 'cadence.yaml'));
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    warn(`coût n/d : ${e.message}`);
    return { prices: null };
  }
}

/** La grille seule de `launchCost`. */
export function launchPrices(launch: string, warn: (line: string) => void): PriceGrid | null {
  return launchCost(launch, warn).prices;
}

const unknownText = (n: number, models: string[]) => `n/d pour ${n} lot${n > 1 ? 's' : ''}, modèle sans prix : ${models.join(', ')}`;

/**
 * L'estimation en euros de `--dry-run` : une ligne par lot puis une pour la vague. Le budget du lot (entrée + écriture de cache + sortie, mesuré au p90)
 * est chiffré au modèle d'écriture du lot, `COUNTED_INPUT_SHARE` en entrée : la lecture de cache et les étapes d'un autre modèle (revue) n'y sont pas.
 * Vide sans grille.
 */
export function estimateLines(lots: LotState[], launch: string, warn: (line: string) => void): string[] {
  const { prices, currency } = launchCost(launch, warn);
  if (!prices) return [];
  const per = lots.map((l) => {
    const e = stepEuros({ model: l.model, counted: l.budget ?? 0 }, prices);
    return typeof e === 'number' ? e : null;
  });
  const out = lots.map((l, i) => `${l.project}:${l.lot} — estimation du lot : ${per[i] === null ? `n/d (${l.model} sans prix dans perf.prices)` : `${euros(per[i]!, currency)} (budget de ${l.budget ?? 0} tokens au prix ${l.model}, ${Math.round(COUNTED_INPUT_SHARE * 100)} % en entrée)`}`);
  const sum = waveEuros(per);
  const unpriced = [...new Set(lots.filter((_, i) => per[i] === null).map((l) => l.model))];
  out.push(`estimation de la vague : ${euros(sum.total, currency)}${sum.unknown ? ` (${unknownText(sum.unknown, unpriced)})` : ''} — base : le budget de chaque lot, mesuré au p90 comme lui`);
  return out;
}

/**
 * Le coût réel de `renderTable` (L529) : l'en-tête et les cellules de la colonne de coût (une par lot) et la fin de la ligne de la vague ; tout est vide sans grille.
 * L'en-tête est la monnaie de la grille, `coût` quand elle n'en déclare pas ; un lot dont un modèle n'a pas de prix est `n/d` et le total nomme ces modèles (L578).
 */
export function costView(lots: LotState[], prices: PriceGrid | null | undefined, currency?: string): { head: string[]; cells: string[][]; total: string } {
  if (!prices) return { head: [], cells: lots.map(() => []), total: '' };
  const stepsOf = (l: LotState) => l.steps.map((s) => ({ model: s.model, ...(s.tokens ? { usage: s.tokens } : {}) }));
  const per = lots.map((l) => sumEuros(stepsOf(l), prices));
  const sum = waveEuros(per);
  const unpriced = [...new Set(lots.flatMap((l) => missingModels(stepsOf(l), prices)))];
  return { head: [currency ?? 'coût'], cells: per.map((e) => [e === null ? 'n/d' : euros(e, currency)]), total: ` — ${euros(sum.total, currency)}${sum.unknown ? ` (${unknownText(sum.unknown, unpriced)})` : ''}` };
}
