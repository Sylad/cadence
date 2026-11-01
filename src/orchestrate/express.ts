import type { Screen } from '../plan.js';

/** Estimation, en jours, au plus de laquelle un lot est une retouche : l'étude L517 (levier 2) mesure 15,5 min et 116 k jetons pour un tel lot, dont 44 % en revue et préparation. */
export const EXPRESS_MAX_ESTIMATE = 0.1;

/**
 * Voie express (L519) : une retouche (estimate ≤ 0,1 j) sans écran ni spec se joue en une seule session d'écriture, sans contrôle préalable, sans sonde
 * ni revue séparée (le lead lit le diff), sans porte « code sans test » ni entrée Nouveautés par lot. Une estimation absente, nulle ou illisible n'en est pas une.
 */
export function isExpress(lot: { estimate?: number; screen?: Screen; specLot?: boolean }): boolean {
  const e = lot.estimate;
  return typeof e === 'number' && e > 0 && e <= EXPRESS_MAX_ESTIMATE && !lot.screen && !lot.specLot;
}
