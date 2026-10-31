import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { isOpen, RafError, RESOURCE_NAME, RESOURCES_BAD_LIST, type Lot } from './plan.js';

/** Les ressources déclarées (clé `resources:`, L251) et le cadence.yaml qui les déclare, ou celui du dossier parent quand aucun n'en porte. */
interface Resources {
  file: string;
  names: string[];
}

/**
 * Clé `resources:` du cadence.yaml le plus proche en remontant depuis le dossier parent de `root` : le premier fichier qui porte la clé
 * (même vide) l'emporte. Aucun ne la porte : liste vide, attribuée au cadence.yaml du parent direct. Un fichier illisible ou une clé
 * qui n'est pas une liste de noms valides est une `RafError` nommant le fichier, jamais une liste vide silencieuse.
 */
export function readResources(root: string): Resources {
  const fallback = join(dirname(root), 'cadence.yaml');
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    const file = join(dir, 'cadence.yaml');
    if (existsSync(file) && statSync(file).isFile()) {
      let raw: unknown;
      try {
        raw = parse(readFileSync(file, 'utf8'));
      } catch (e) {
        throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
      }
      if (raw != null && typeof raw === 'object' && Object.hasOwn(raw, 'resources')) {
        const list = (raw as { resources: unknown }).resources ?? [];
        if (!Array.isArray(list) || !list.every((n) => typeof n === 'string' && RESOURCE_NAME.test(n))) throw new RafError(`${file} : resources ${RESOURCES_BAD_LIST}`);
        return { file, names: [...new Set(list as string[])] };
      }
    }
    if (dirname(dir) === dir) return { file: fallback, names: [] };
  }
}

/**
 * Un écart par ressource d'un lot ouvert que le cadence.yaml des dossiers parents ne déclare pas. Le fichier n'est lu que si un lot ouvert
 * porte `uses:` : un plan qui n'en porte pas donne le contrôle d'avant, quel que soit l'état du dossier parent.
 */
export function resourceIssues(lots: Lot[], root: string): { message: string }[] {
  const using = lots.filter((l) => isOpen(l.status) && l.uses?.length);
  if (using.length === 0) return [];
  let declared: Resources;
  try {
    declared = readResources(root);
  } catch (e) {
    if (e instanceof RafError) return [{ message: e.message }];
    throw e;
  }
  return using.flatMap((l) => l.uses!.filter((n) => !declared.names.includes(n)).map((n) => ({ message: `${l.id} utilise la ressource « ${n} », non déclarée dans ${declared.file} (resources:)` })));
}
