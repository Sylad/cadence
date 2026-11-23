import { join } from 'node:path';
import { analyserFichier, ligneSignal, lireEcriture } from '../scripts/ecriture.mjs';
import { type Entry, loadEntries } from './news.js';
import { RafError } from './plan.js';
import { isObject, readYamlFile } from './yaml-keys.js';

/**
 * Les signaux d'écriture courte (L803, scripts/ecriture.mjs) des entrées Nouveautés, pour `raf news check` : seulement quand cadence.yaml déclare
 * la clé `ecriture:` (le projet l'adopte), et seulement pour les entrées datées de `ecriture.depuis` ou après (l'existant n'est pas rouvert).
 * Des avertissements : ils ne comptent pas dans les écarts et ne bloquent rien — le contrôle signale, l'auteur réécrit.
 */
function writingWarnings(configFile: string, dir: string, entries: Entry[]): string[] {
  // déclarée = active, même vide (`ecriture:` sans valeur, ou toutes ses sous-clés en commentaire) : les réglages par défaut (L810)
  const doc = readYamlFile(configFile);
  if (!isObject(doc) || !('ecriture' in doc)) return [];
  let r;
  try {
    r = lireEcriture(doc.ecriture, 'cadence.yaml');
  } catch (e) {
    throw new RafError((e as Error).message);
  }
  return entries
    .filter((e) => !r.depuis || e.date >= r.depuis)
    .flatMap((e) => analyserFichier(join(dir, e.file), e.file, r).flatMap((p) => p.signaux.map((s) => `écriture : ${ligneSignal(p, s)}`)));
}

/** `raf news check` (seule sous-commande concernée) : chaque signal en ligne « ⚠ écriture : … », après le compte des écarts. */
export function writingCheck(sub: string | undefined, configFile: string, dir: string, out: (l: string) => void): void {
  if (sub !== 'check') return;
  // l'ordre des entrées n'importe pas ici : pas d'historique git pour départager celles sans heure de création
  for (const w of writingWarnings(configFile, dir, loadEntries(dir, () => new Map()))) out(`⚠ ${w}`);
}
