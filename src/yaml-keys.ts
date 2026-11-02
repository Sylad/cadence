import type { RafError } from './plan.js';

/** Une clé de cadence.yaml qui vaut `true` ou `false` : toute autre valeur lève l'erreur donnée. */
export function booleanKey(value: unknown, refusal: RafError): boolean {
  if (typeof value !== 'boolean') throw refusal;
  return value;
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
