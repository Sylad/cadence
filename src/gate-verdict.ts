import { noterVerdict, verdictPour, type VerdictPorte } from '../scripts/verdicts-porte.mjs';

/**
 * Le verdict de la porte du projet pour un sha (L426) : 0 vert, 1 rouge ; `at` : quand la porte l'a rendu (ISO). Lu et écrit par scripts/verdicts-porte.mjs,
 * le même code que la porte de `cadence run` (L786) : le hook pre-push lit ce que l'une ou l'autre a noté.
 */
export type GateVerdict = VerdictPorte;

/**
 * Note le verdict de `cadence verify --gate` pour `sha` (L426), dans l'état partagé du dépôt (`.git/cadence/gate-verdicts.json`, commun à tous les worktrees).
 * Le dernier verdict d'un sha remplace le précédent ; au-delà de 200 shas, les plus anciens partent. Écriture atomique (fichier voisin renommé).
 */
export function recordVerdict(repo: string, sha: string, code: 0 | 1, at: Date): void {
  noterVerdict(repo, sha, code, at);
}

/** Le dernier verdict noté pour `sha` ; null si la porte n'a jamais rendu de verdict pour ce sha. */
export function verdictFor(repo: string, sha: string): GateVerdict | null {
  return verdictPour(repo, sha);
}
