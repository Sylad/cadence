import { existsSync, statSync } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';
import { isObject, list } from './yaml-keys.js';
import type { PlanSettings, RafError } from './plan.js';

const ON_WRITE_KEYS = ['command', 'files', 'onFailure'];
const ON_FAILURE = ['refuse', 'warn'] as const;

/** Clé `plan.onWrite` (L346) : la commande qui republie le plan après chaque écriture, lancée dans `cwd` (la racine du dépôt), les fichiers qu'elle produit (relatifs au dépôt, jamais hors de lui) et ce qu'un échec fait de l'écriture (`onFailure`, L471 : refuse par défaut). */
export function readOnWrite(v: unknown, cwd: string, bad: (what: string) => RafError): NonNullable<PlanSettings['onWrite']> {
  if (!isObject(v)) throw bad('onWrite doit être un objet { command, files, onFailure }');
  for (const k of Object.keys(v)) if (!ON_WRITE_KEYS.includes(k)) throw bad(`onWrite.${k} inconnu (attendu : ${ON_WRITE_KEYS.join(', ')})`);
  if (typeof v.command !== 'string' || v.command.trim() === '') throw bad('onWrite.command doit être une commande');
  const files = list(v.files).map((f) => {
    const rel = posix.normalize(f.trim().replace(/\\/g, '/'));
    if (rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw bad(`onWrite.files « ${f} » est hors du dépôt`);
    if (existsSync(resolve(cwd, rel)) && statSync(resolve(cwd, rel)).isDirectory()) throw bad(`onWrite.files « ${f} » est un dossier (déclarer les fichiers produits, pas leur dossier)`);
    return rel;
  });
  const onFailure = 'onFailure' in v ? v.onFailure : 'refuse'; // `onFailure: ~` (null) n'est pas « absent » : refusé
  if (!ON_FAILURE.some((m) => m === onFailure)) throw bad(`onWrite.onFailure doit être ${ON_FAILURE.join(' ou ')} (reçu : ${JSON.stringify(onFailure)})`);
  return { command: v.command, files, cwd, onFailure: onFailure as (typeof ON_FAILURE)[number] };
}
