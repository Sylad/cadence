import { join } from 'node:path';
import { readPerfConfig, type PriceGrid } from '../config.js';
import { COUNTED_INPUT_SHARE, euros, stepEuros, sumEuros, waveEuros } from '../cost.js';
import { RafError } from '../plan.js';
import type { LotState } from './state.js';

/**
 * La grille `perf.prices` du cadence.yaml du dossier de lancement (L529), la même que lit `cadence perf`. Une grille mal formée n'interdit ni une simulation
 * ni un tableau (perdre le tableau d'une vague payée serait pire que d'en retirer les euros) : `warn` reçoit pourquoi, et la grille est absente.
 */
export function launchPrices(launch: string, warn: (line: string) => void): PriceGrid | null {
  try {
    return readPerfConfig(join(launch, 'cadence.yaml'));
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    warn(`coût en euros n/d : ${e.message}`);
    return null;
  }
}

const unknownText = (n: number) => `n/d pour ${n} lot${n > 1 ? 's' : ''}, modèle sans prix`;

/**
 * L'estimation en euros de `--dry-run` : une ligne par lot puis une pour la vague. Le budget du lot (entrée + écriture de cache + sortie, mesuré au p90)
 * est chiffré au modèle d'écriture du lot, `COUNTED_INPUT_SHARE` en entrée : la lecture de cache et les étapes d'un autre modèle (revue) n'y sont pas.
 * Vide sans grille.
 */
export function estimateLines(lots: LotState[], launch: string, warn: (line: string) => void): string[] {
  const prices = launchPrices(launch, warn);
  if (!prices) return [];
  const per = lots.map((l) => {
    const e = stepEuros({ model: l.model, counted: l.budget ?? 0 }, prices);
    return typeof e === 'number' ? e : null;
  });
  const out = lots.map((l, i) => `${l.project}:${l.lot} — estimation du lot : ${per[i] === null ? `n/d (${l.model} sans prix dans perf.prices)` : `${euros(per[i]!)} (budget de ${l.budget ?? 0} tokens au prix ${l.model}, ${Math.round(COUNTED_INPUT_SHARE * 100)} % en entrée)`}`);
  const sum = waveEuros(per);
  out.push(`estimation de la vague : ${euros(sum.total)}${sum.unknown ? ` (${unknownText(sum.unknown)})` : ''} — base : le budget de chaque lot, mesuré au p90 comme lui`);
  return out;
}

/** Le coût réel de `renderTable` (L529) : l'en-tête et les cellules de la colonne `€` (une par lot) et la fin de la ligne de la vague ; tout est vide sans grille. */
export function costView(lots: LotState[], prices: PriceGrid | null | undefined): { head: string[]; cells: string[][]; total: string } {
  if (!prices) return { head: [], cells: lots.map(() => []), total: '' };
  const per = lots.map((l) => sumEuros(l.steps.map((s) => ({ model: s.model, ...(s.tokens ? { usage: s.tokens } : {}) })), prices));
  const sum = waveEuros(per);
  return { head: ['€'], cells: per.map((e) => [e === null ? 'n/d' : euros(e)]), total: ` — ${euros(sum.total)}${sum.unknown ? ` (${unknownText(sum.unknown)})` : ''}` };
}
