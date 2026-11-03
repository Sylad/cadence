import { isPlanOnly } from './audit.js';
import { changedFiles, isAncestor, readCommits } from './git.js';
import { underPath } from './deliver-blocks.js';
import { citedRefs } from './link.js';
import type { DeliveredCtx } from './deliver.js';

/**
 * Ligne des lots cités depuis la livraison précédente, ou null (première livraison, rien de cité).
 *
 * Plan en lecture seule : seuls les lots EN COURS sont annoncés. Ses identifiants sont de forme libre, et
 * un message cite volontiers un numéro qui en a la forme (réserve « R1 » d'une revue) ou un lot clos
 * nommé pour le contexte — les annoncer « livrés » ferait fermer à tort. L'état est celui du départ de
 * la livraison : le plan a été lu avant que le script du projet ne ferme lui-même les lots qu'il livre.
 */
/** Lots cités par les commits livrés depuis la livraison précédente ; vide quand elle est inconnue ou hors de l'historique. */
export function deliveredIds(ctx: DeliveredCtx, prev: string | null, sha: string): string[] {
  if (!ctx.plan || !prev || prev === sha || !isAncestor(ctx.root, prev, sha)) return [];
  const lots = ctx.plan.lots();
  const known = new Set((ctx.plan.readonly ? lots.filter((l) => l.status === 'doing') : lots).map((l) => l.id));
  const ids = new Set<string>();
  // --block (L469) : seuls les commits qui touchent un chemin du bloc comptent, dans la plage de CETTE livraison seulement.
  const paths = ctx.block === undefined ? undefined : ctx.blocks?.[ctx.block];
  for (const c of readCommits(ctx.root, { range: `${prev}..${sha}` })) {
    if (isPlanOnly(c.sha, ctx.plan, ctx.root)) continue; // entretien du plan : ne livre rien, même s'il cite des lots
    if (paths && !changedFiles(ctx.root, c.sha).some((f) => paths.some((p) => underPath(f, p)))) continue;
    for (const r of citedRefs(c, ctx.plan.refs)) if (known.has(r.lot)) ids.add(r.lot);
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function deliveredLots(ctx: DeliveredCtx, ids: string[], prev: string | null, sha: string): string | null {
  if (!ctx.plan || !prev || prev === sha) return null;
  if (!isAncestor(ctx.root, prev, sha)) {
    return `livraison précédente (${prev.slice(0, 7)}) hors de l'historique de ${sha.slice(0, 7)} (réécrit ?) : lots livrés non calculés`;
  }
  if (ids.length === 0) return null;
  return `livré : ${ids.join(', ')} — ${ctx.plan.readonly ? "à fermer avec l'outil du projet" : 'raf done'} si l'effet est celui attendu`;
}
