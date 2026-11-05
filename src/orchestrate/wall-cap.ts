import { type StepState } from './state.js';
import { workTimeoutMs } from './timeouts.js';

/** Multiple de la durée attendue du lot au-delà duquel le programme ne lance plus de passe de correction (L622, issue #41). */
const WALL_CAP_FACTOR = 2;

/**
 * Plafond de mur d'un lot (L622) : deux fois sa durée attendue, celle que `workTimeoutMs` tire de l'estimate (45 min à 0,25 j, le double à 0,5 j,
 * bornée à 4 fois le délai de base ; un lot sans estimate compte comme 0,25 j). Un lot à fiche reçoit la même majoration que sa session d'écriture.
 */
export const wallCapMs = (baseMs: number, estimate: number | undefined, fiche: boolean): number => WALL_CAP_FACTOR * workTimeoutMs(baseMs, estimate, fiche);

/**
 * Mur d'un lot : la somme des durées de ses étapes (`ended − started`, une étape en cours compte jusqu'à `now`). Les pauses entre deux étapes
 * (attente de créneau, lot suspendu sur le budget de la vague, reprise le lendemain) n'en font pas partie : elles ne sont pas du travail du lot.
 * Une date illisible ou une durée négative compte pour 0.
 */
export function lotWallMs(steps: readonly Pick<StepState, 'started' | 'ended'>[], now: number): number {
  let total = 0;
  for (const s of steps) {
    const from = Date.parse(s.started);
    const to = s.ended ? Date.parse(s.ended) : now;
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) total += to - from;
  }
  return total;
}
