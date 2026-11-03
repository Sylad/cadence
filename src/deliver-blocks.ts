import { posix } from 'node:path';

/** Blocs de livraison (`deliver.blocks`, L469) : nom → chemins relatifs au dépôt, normalisés. */
export type Blocks = Record<string, string[]>;

/** Un chemin de bloc normalisé comme les fichiers de `plan.onWrite` (séparateurs, « ./ » initial, « / » final retirés), ou la raison de son refus. */
function blockPath(raw: string): { path: string } | { why: string } {
  if (raw.trim() === '') return { why: 'un chemin vide' };
  const rel = posix.normalize(raw.trim().replace(/\\/g, '/')).replace(/(?<=.)\/$/, '');
  if (rel === '.') return { why: `« ${raw} » désigne tout le dépôt (un bloc se déclare par un sous-chemin)` };
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return { why: `« ${raw} » est hors du dépôt` };
  return { path: rel };
}

/** Clé `deliver.blocks` lue ; `bad` fabrique l'erreur « cadence.yaml : deliver.<ce qui cloche> ». */
export function readBlocks(v: unknown, bad: (what: string) => Error): Blocks {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('blocks : un objet { nom: [chemins] } attendu');
  const blocks: Blocks = {};
  for (const [name, paths] of Object.entries(v)) {
    if (name.trim() === '') throw bad('blocks : nom de bloc vide');
    if (!Array.isArray(paths) || paths.length === 0) throw bad(`blocks.${name} : au moins un chemin attendu`);
    blocks[name] = paths.map((p) => {
      if (typeof p !== 'string') throw bad(`blocks.${name} : un chemin est un texte`);
      const r = blockPath(p);
      if ('why' in r) throw bad(`blocks.${name} : ${r.why}`);
      return r.path;
    });
  }
  return blocks;
}

/** Un fichier appartient à un chemin quand il lui est égal ou situé dessous, par segments (« src/api » ne retient pas « src/api2/x.ts »). */
export const underPath = (file: string, path: string): boolean => file === path || file.startsWith(`${path}/`);

/** Les blocs que touche une liste de fichiers. */
export function blocksTouched(files: string[], blocks: Blocks): string[] {
  return Object.keys(blocks).filter((b) => files.some((f) => blocks[b].some((p) => underPath(f, p))));
}

/** Les noms des blocs de `deliver.blocks`, [] sans la clé : de quoi lire la ligne d'où part une livraison (`lastDeliveryFor`). */
export const declaredBlocks = (config: { blocks?: Blocks }): string[] => Object.keys(config.blocks ?? {});
