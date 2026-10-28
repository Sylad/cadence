import { join } from 'node:path';
import { planLoader } from '../src/config.js';
import type { Lot } from '../src/plan.js';

/**
 * Les lots du plan réel du dépôt, actifs et archivés (`raf archive`, L396) : un test qui a besoin d'un lot du plan du dépôt passe par ici,
 * jamais par une lecture directe de `.cadence/raf.yaml`, qui ne porte plus les lots clos (L404 : etape-spec-back-fiche rouge depuis l'archive).
 */
export function lotsDuPlanReel(): Lot[] {
  return planLoader(join(import.meta.dirname, '..'))().lots();
}

/** Vrai quand le source d'un test lit le fichier du plan réel du dépôt (`.cadence/raf.yaml`) au lieu de passer par le chargeur (les lignes de commentaire ne comptent pas). */
export function readsRealPlanDirectly(source: string): boolean {
  const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return /\bread\w*\(\s*join\((?:ROOT|root|REPO|repoRoot|__dirname|import\.meta\.dirname)\b[^)]*['"]\.cadence['"]\s*,\s*['"]raf\.yaml['"]/.test(code)
    || /\bread\w*\(\s*join\((?:ROOT|root|REPO|repoRoot|__dirname|import\.meta\.dirname)\b[^)]*['"]\.cadence\/raf\.yaml['"]/.test(code);
}
