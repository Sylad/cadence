import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { isPlanOnly } from './audit.js';
import { changedFiles, fileAt, isAncestor, readCommits } from './git.js';
import type { Plan } from './plan.js';
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
/**
 * Les lots qu'une livraison peut nommer. Plan en lecture seule : ceux en cours au départ ; et, avec `ctx.planAt` (`deliver --constat`, L765),
 * ceux qui l'étaient déjà dans le plan du sha livré : un constat vise souvent un sha antérieur à la tête, où un lot démarré APRÈS lui est en
 * cours sans avoir aucun commit dessous — un commit d'avant qui le nomme en passant (« suite en Q-COUPE0 ») ne le livre pas.
 */
function knownLots(ctx: DeliveredCtx, plan: Plan, sha: string): Set<string> {
  const lots = plan.lots();
  if (!plan.readonly) return new Set(lots.map((l) => l.id));
  const doing = (list: readonly { id: string; status: string }[]) => new Set(list.filter((l) => l.status === 'doing').map((l) => l.id));
  const now = doing(lots);
  if (!ctx.planAt) return now;
  const then = doing(ctx.planAt(sha)?.lots() ?? []);
  return new Set([...now].filter((id) => then.has(id)));
}

/** Lots cités par les commits livrés depuis la livraison précédente ; vide quand elle est inconnue ou hors de l'historique. */
export function deliveredIds(ctx: DeliveredCtx, prev: string | null, sha: string): string[] {
  if (!ctx.plan || !prev || prev === sha || !isAncestor(ctx.root, prev, sha)) return [];
  const known = knownLots(ctx, ctx.plan, sha);
  const ids = new Set<string>();
  // --block (L469) : seuls les commits qui touchent un chemin du bloc comptent, dans la plage de CETTE livraison seulement.
  const paths = ctx.block === undefined ? undefined : ctx.config?.blocks?.[ctx.block];
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

/**
 * Le plan tel qu'il était à un sha (L765) : son fichier à ce commit, chargé par `load` (les réglages du projet, format d'un plan en
 * lecture seule compris) ; null quand le fichier n'existait pas à ce commit ou ne s'y lit pas.
 */
export function planAtSha(root: string, planPath: string, load: (path: string) => Plan): (sha: string) => Plan | null {
  return (sha) => {
    const text = fileAt(root, sha, relative(root, planPath));
    if (text === null) return null;
    const dir = mkdtempSync(join(tmpdir(), 'cadence-plan-at-'));
    try {
      const file = join(dir, basename(planPath));
      writeFileSync(file, text);
      return load(file);
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
