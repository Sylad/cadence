import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { gitRoot } from './git.js';
import { RafError, type PlanSettings } from './plan.js';
import { isObject } from './yaml-keys.js';

/** Chemin réel (liens symboliques résolus) du plus proche ancêtre existant, le reste rattaché tel quel. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(realish(up), basename(p));
  }
}

/**
 * Clé `qa:` : le fichier d'attendus QA, ramené à la forme que git rapporte (relatif à la racine du dépôt,
 * séparateurs posix, sans `./`). Un chemin absolu est lu depuis la racine du dépôt de travail que donne le CLI, à défaut la racine git du dossier du fichier (hors dépôt git, ce dossier). Une valeur vide vaut absente ; un type faux ou un chemin hors du dépôt est refusé.
 */
function readQa(qa: unknown, file: string, workRoot?: string): string | undefined {
  if (qa == null) return undefined;
  if (!isObject(qa)) throw new RafError(`${file} : qa doit être un objet`);
  const v = qa.expectations;
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new RafError(`${file} : qa.expectations doit être un chemin`);
  const raw = v.trim().replace(/\\/g, '/');
  if (raw === '') return undefined;
  const root = workRoot ?? gitRoot(dirname(resolve(file))) ?? dirname(resolve(file));
  const rel = posix.normalize(isAbsolute(raw) ? relative(realish(root), realish(raw)).replace(/\\/g, '/') : raw);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new RafError(`${file} : qa.expectations « ${v.trim()} » est hors du dépôt`);
  return rel;
}

/**
 * Clé `qa.worstData` (L534) : le paramètre ou le chemin qui charge le jeu de données « pires cas » du produit, rogné, recopié tel quel dans les briefs d'écran.
 * Une valeur vide vaut absente ; un type faux ou une valeur sur plusieurs lignes est refusé (une seule ligne : pas de consigne multiple glissée dans le brief).
 * `qa` est déjà validé comme objet par `readQa`.
 */
function readWorstData(qa: unknown, file: string): string | undefined {
  const v = isObject(qa) ? qa.worstData : undefined;
  if (v == null) return undefined;
  if (typeof v !== 'string' || /[\r\n\u0085\u2028\u2029]/.test(v.trim())) throw new RafError(`${file} : qa.worstData doit être une chaîne sur une seule ligne (le paramètre ou le chemin qui charge le jeu pires cas)`);
  return v.trim() || undefined;
}

/** Clé `qa:` de cadence.yaml en réglages du plan : `qa.expectations` et `qa.worstData` (L534), chacun absent quand il manque ou est vide. */
export function readQaSettings(qa: unknown, file: string, workRoot?: string): PlanSettings {
  const expectations = readQa(qa, file, workRoot);
  const worst = readWorstData(qa, file);
  return { ...(expectations ? { qaExpectations: expectations } : {}), ...(worst ? { qaWorstData: worst } : {}) };
}
