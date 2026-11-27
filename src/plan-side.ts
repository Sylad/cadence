// Les fichiers d'un commit de plan seul vus par le hook pre-push (L784, L786) : le plan, tout ce qui vit sous `.cadence/` (registre des demandes, archives,
// notes) et ce que `plan.onWrite` régénère (`plan.onWrite.files` de cadence.yaml) ; jamais la configuration, dont les commandes de porte changent ce qui est jugé.
// Le 19-11, deux commits de plan (création d'un lot et d'une demande sous .cadence/demandes/) citant des lots ouverts étaient comptés comme du code de ces
// lots sans revue, et le sha qu'un run venait d'intégrer perdait son verdict de porte sous un tel commit.
// Revue r1 (m1, m3) : une seule définition pour la revue (src/audit.ts) et la porte (src/push-guard.ts), et `plan.onWrite.files` lu dans le cadence.yaml du
// commit jugé, jamais dans l'arbre courant : une sortie déclarée après coup ne fait pas hériter du code d'un verdict rendu sans elle.
import { isAbsolute, posix } from 'node:path';
import { parse } from 'yaml';
import { fileAt } from './git.js';

/** Le dossier de cadence à la racine du dépôt : rien n'y est du code d'un lot. */
const CADENCE_DIR = '.cadence/';

/**
 * Un document du registre des demandes (`.cadence/demandes/<id>.json`, L920) : comme le plan, aucun test de la porte n'est censé le lire, et un commit qui ne
 * touche que lui et le plan se pousse sans porte, même quand `orchestrate.gate.readsPlan` déclare qu'un test lit le plan (vécu 27-11 : « registre: D-4 livrée »
 * refusé au push dans ol-companion, toute la porte à rejouer pour un JSON).
 */
export function isRequestFile(file: string): boolean {
  return /^\.cadence\/demandes\/[^/]+\.json$/.test(file);
}

/** Le plan et la configuration, chemins relatifs à la racine du dépôt. */
export interface PlanSideRefs {
  planFile: string;
  config: string;
}

/** Le prédicat « fichier du plan » : chemins relatifs à la racine du dépôt (`planFile`, `config`, `produced`). */
function planSide(o: PlanSideRefs & { produced: readonly string[] }): (file: string) => boolean {
  const produced = new Set(o.produced);
  return (f) => f !== o.config && (f === o.planFile || f.startsWith(CADENCE_DIR) || produced.has(f));
}

/** `plan.onWrite.files` du cadence.yaml de `rev` (normalisés comme src/config-onwrite.ts) ; vide sans la clé, hors du dépôt ou illisible. */
function onWriteFilesAt(root: string, rev: string, config: string): string[] {
  try {
    const files = (parse(fileAt(root, rev, config) ?? '') as { plan?: { onWrite?: { files?: unknown } } } | null)?.plan?.onWrite?.files;
    const list = Array.isArray(files) ? files : typeof files === 'string' ? [files] : [];
    return list.filter((f): f is string => typeof f === 'string' && !!f.trim()).map((f) => posix.normalize(f.trim().replace(/\\/g, '/')))
      .filter((f) => f !== '.' && f !== '..' && !f.startsWith('../') && !isAbsolute(f));
  } catch {
    return [];
  }
}

/** « Fichier du plan » au commit `rev` : le plan, `.cadence/**` et les sorties de `plan.onWrite` déclarées dans le cadence.yaml de ce commit, jamais la configuration. */
export function planSideAt(root: string, rev: string, refs: PlanSideRefs): (file: string) => boolean {
  return planSide({ ...refs, produced: onWriteFilesAt(root, rev, refs.config) });
}
