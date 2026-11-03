import { relative } from 'node:path';
import { commitPaths, dirtyPaths } from './git.js';
import { PLAN_ACTIONS, planCommitMessage } from './plan-commit.js';
import type { DeliveredCtx } from './deliver.js';

/**
 * Livré ≠ terminé (L469) : les lots terminés cités par les commits de la livraison reçoivent `delivered: { date, sha }` (et l'état
 * `plan.deliveredState`), le plan est commité avec les fichiers d'archive modifiés et ceux de `plan.onWrite`. `ids` : les lots cités
 * (lot ou sous-tâche) par la plage de la livraison ; le plan est relu ici, le script du projet a pu fermer des lots depuis le départ.
 * Un lot ouvert, déjà livré, ou dont `plan.transitions` refuse l'état livré n'est pas marqué. Plan en lecture seule : rien n'est écrit.
 * Une erreur n'en est pas une pour la livraison, déjà faite : elle est dite, jamais levée. Le plan ou ces fichiers déjà modifiés avant
 * l'écriture (le lead y a des modifications que ce commit emporterait) : marqué, non commité, et le message le dit.
 */
export function markDelivered(ctx: DeliveredCtx, ids: string[], sha: string): void {
  if (!ctx.plan || ctx.plan.readonly || ids.length === 0) return;
  try {
    const plan = ctx.plan.reloaded();
    const wanted = new Set(ids);
    const pending = plan.lots().filter((l) => wanted.has(l.id) && l.status === 'done' && !l.delivered).map((l) => l.id);
    const marked = pending.filter((id) => {
      const refused = plan.markDelivered(id, { date: ctx.today, sha });
      if (refused) ctx.err(`deliver : ${id} non marqué livré : ${refused}`);
      return !refused;
    });
    if (marked.length === 0) return;
    const held = [...new Set([...plan.holdingFiles(marked), plan.path])].map((f) => relative(ctx.root, f));
    const files = [...held, ...plan.produced];
    const wasDirty = dirtyPaths(ctx.root, files).length > 0;
    plan.save();
    let state = 'plan modifié, à commiter';
    if (wasDirty) state = 'plan déjà modifié avant la livraison, non commité : à commiter avec vos modifications';
    else {
      const message = planCommitMessage(ctx.planCommit, { lot: marked.join(', '), action: PLAN_ACTIONS.delivered, wave: ctx.waveId });
      try {
        state = `plan commité ${commitPaths(ctx.root, dirtyPaths(ctx.root, [...held, ...plan.produced]), message)}`;
      } catch (e) {
        ctx.err(`deliver : lots livrés non marqués : commit du plan refusé (${(e as Error).message}) — delivered: écrit dans le plan, à commiter`);
        return;
      }
    }
    ctx.out(`lots marqués livrés : ${marked.join(', ')} — delivered: ${ctx.today} ${sha.slice(0, 7)} (${state})`);
  } catch (e) {
    ctx.err(`deliver : lots livrés non marqués : ${(e as Error).message}`);
  }
}
