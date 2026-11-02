import type { ModelPrice, PriceGrid } from './config.js';
import type { JournalStep } from './corrections.js';

/** Part de `counted` rangée en entrée quand une étape ne porte que ce compteur (journal ancien, ou budget d'un lot annoncé en euros) : le reste est en sortie (R8 b de L226). */
export const COUNTED_INPUT_SHARE = 0.9;

/** Ce que le coût lit d'une étape : son modèle et ses compteurs (les quatre, ou le seul `counted`). */
type CostStep = Pick<JournalStep, 'model' | 'usage' | 'counted'>;

/** Coût en euros d'une étape (R8 de L226) ; le nom du modèle sans prix quand il en faudrait un. */
export function stepEuros(step: CostStep, prices: PriceGrid): number | { missing: string } {
  if (step.model === 'local') return 0;
  const usage = step.usage ?? (step.counted === undefined ? null : { input: COUNTED_INPUT_SHARE * step.counted, cacheWrite: 0, cacheRead: 0, output: (1 - COUNTED_INPUT_SHARE) * step.counted });
  if (!usage) return 0;
  const price: ModelPrice | undefined = step.model === 'sonnet' || step.model === 'opus' || step.model === 'haiku' ? prices[step.model] : undefined;
  if (!price) return { missing: step.model === 'sonnet' || step.model === 'opus' || step.model === 'haiku' ? step.model : 'inconnu' };
  return ((usage.input + usage.cacheWrite) * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead) / 1_000_000;
}

/** Un montant en euros, deux décimales et virgule : `4,80 €`. */
export const euros = (v: number): string => `${v.toFixed(2).replace('.', ',')} €`;

/** Coût en euros d'un lot : la somme de ses étapes ; null dès qu'une étape tourne sur un modèle sans prix dans la grille (un coût partiel serait pris pour le vrai). */
export function sumEuros(steps: CostStep[], prices: PriceGrid): number | null {
  let total = 0;
  for (const s of steps) {
    const e = stepEuros(s, prices);
    if (typeof e !== 'number') return null;
    total += e;
  }
  return total;
}

/** Les montants d'un ensemble de lots : `total` des lots chiffrés, `unknown` = nombre de lots dont un modèle n'a pas de prix. */
export function waveEuros(perLot: (number | null)[]): { total: number; unknown: number } {
  let total = 0;
  let unknown = 0;
  for (const e of perLot) {
    if (e === null) unknown++;
    else total += e;
  }
  return { total, unknown };
}
