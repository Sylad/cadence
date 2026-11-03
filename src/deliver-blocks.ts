import { posix } from 'node:path';
import { lastDeliveryFor } from './state.js';

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

/** Clé `deliver.blocks` lue (undefined sans la clé) ; `bad` fabrique l'erreur « cadence.yaml : deliver.<ce qui cloche> ». */
export function readBlocks(v: unknown, bad: (what: string) => Error): Blocks | undefined {
  if (v === undefined) return undefined;
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

/** Les noms des blocs de `deliver.blocks`, [] sans la clé. */
const declaredBlocks = (config: { blocks?: Blocks }): string[] => Object.keys(config.blocks ?? {});

/** Sha de la livraison précédente d'où part cette livraison : la ligne du bloc livré, ou celle de la livraison complète (`lastDeliveryFor`). */
export const previousDelivery = (ctx: { state: string; block?: string; config: { blocks?: Blocks } }): string | null => lastDeliveryFor(ctx.state, ctx.block, declaredBlocks(ctx.config));

/** Pourquoi `--block` est refusé (bloc inconnu, ou aucun bloc déclaré) ; null quand le bloc est déclaré. */
export function blockProblem(block: string, config: { blocks?: Blocks }): string | null {
  const declared = declaredBlocks(config);
  if (declared.length === 0) return `--block ${block} : aucun bloc déclaré (deliver.blocks dans cadence.yaml)`;
  return declared.includes(block) ? null : `--block ${block} : bloc inconnu (déclarés : ${declared.join(', ')})`;
}
