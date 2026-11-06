import { ESCALATION_RESERVE } from './cycle/budget.js';

/**
 * L657 : le budget d'un lot ajouté par `--add --budget projet:lot=+N`, ou `derived` (le budget dérivé de son estimate) sans demande. N est la marge des passes ordinaires,
 * la part d'escalade s'y ajoute quand la vague en réserve une, comme pour `--resume --budget projet:lot=+N` (L223).
 */
export function askedBudget(raises: ReadonlyMap<string, number> | undefined, key: string, escalating: boolean, derived: number): number {
  const n = raises?.get(key);
  return n === undefined ? derived : n + (escalating ? ESCALATION_RESERVE : 0);
}

/** La clé `goal:` du plan au lancement ou à l'ajout, mémorisée dans l'état du lot (`planGoal`) : vide quand le plan n'en porte pas. */
export const planGoalOf = (lot: { goal?: string }): string => lot.goal ?? '';
