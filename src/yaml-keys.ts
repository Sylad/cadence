import type { RafError } from './plan.js';

/** Une clé de cadence.yaml qui vaut `true` ou `false` : toute autre valeur lève l'erreur donnée. */
export function booleanKey(value: unknown, refusal: RafError): boolean {
  if (typeof value !== 'boolean') throw refusal;
  return value;
}
