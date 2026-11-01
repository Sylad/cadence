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

/** Consigne `{{express}}` du brief d'implémentation d'un lot express ; vide ailleurs. */
export const EXPRESS_BRIEF = [
  'Express lane (touch-up of at most 0.1 day): this is the only session of the lot. There is no precheck, no edge-case probe and no separate code review: the lead reads the diff and looks at the capture. So name the file and the scope you touched in your report, keep the diff to what the goal says, and do not widen it.',
  'No new test for a purely visual change (the existing suite runs and must stay green); a change of behaviour still gets its test first. The full suite and the build run once, at the end.',
].join('\n');

/** Consigne `{{news}}` d'un lot express `visible` : pas d'entrée Nouveautés par lot, la capture seule (le lead regroupe les entrées à la livraison). */
export function expressNewsText(captureDir?: string): string {
  return `No News entry for this lot (express lane): the lead groups the entries at delivery. Do not run \`cadence news new\`. Take a capture of the result${captureDir ? ` (it lands in the wave's output directory, \`${captureDir}\`)` : ' under the OS temp directory (never inside the repository)'}: the lead looks at it instead of a separate review.`;
}

/** Verdict enregistré au plan à la place de la revue : la lecture du diff est celle du lead. */
export const EXPRESS_VERDICT = 'conforme : voie express (retouche de 0,1 j au plus), pas de revue séparée — le lead lit le diff et regarde la capture';
