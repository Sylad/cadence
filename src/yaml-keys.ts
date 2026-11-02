import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { RafError } from './plan.js';

/** Une clé de cadence.yaml qui vaut `true` ou `false` : toute autre valeur lève l'erreur donnée. */
export function booleanKey(value: unknown, refusal: RafError): boolean {
  if (typeof value !== 'boolean') throw refusal;
  return value;
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Le document yaml de `file` : `undefined` si le fichier manque, `RafError` « illisible » (première ligne de l'erreur du parseur) s'il ne se lit pas. */
export function readYamlFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
}

/** La clé `key` du document yaml de `file` : `undefined` si le fichier manque ou si le document n'est pas une table qui la porte. */
export function readYamlKey(file: string, key: string): unknown {
  const doc = readYamlFile(file);
  return isObject(doc) ? doc[key] : undefined;
}
