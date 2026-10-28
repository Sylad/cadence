import { isAncestor, tryGit } from './git.js';
import { blockingLots, LABEL } from './orchestrate/table.js';
import type { LotState } from './orchestrate/state.js';

const ZERO = /^0+$/;
/** Combien de commits de la plage on essaie, du plus récent au plus ancien, pour trouver le dernier livrable. */
const SAFE_SEARCH = 200;

/**
 * Le refus d'un push (hook pre-push de la vague, L405) : une ligne de l'entrée standard de git (`<réf locale> <sha local> <réf distante> <sha distant>`)
 * dont la plage `distant..local` emporte un commit d'un lot de la vague qui n'est pas prêt. Le message nomme le lot et son état, et donne la commande
 * sûre : `git push <remote> <dernier sha livrable>:<branche distante>` (le remote reçu en argument du hook, la branche de la réf distante). Une suppression de branche, un sha illisible ou une plage sans commit de lot pas prêt
 * passent (null) ; les lots dont les commits ne se lisent pas n'empêchent rien ici, le texte l'avertit seulement.
 */
export function pushRefusal(root: string, wave: string, lots: LotState[], input: string, remoteName = 'origin'): { refusal: string | null; warning: string | null } {
  const warnings: string[] = [];
  for (const entry of input.split('\n')) {
    const [ref, local, remoteRef, remote] = entry.trim().split(/\s+/);
    if (!ref || !local || ZERO.test(local) || !/^[0-9a-f]{7,64}$/.test(local)) continue;
    const base = remote && !ZERO.test(remote) ? remote : null;
    // Seuls les commits que ce push emporte comptent : un commit déjà sur le distant a été poussé avant.
    const carried = (_repo: string, c: string, sha: string) => isAncestor(root, c, sha) && (base === null || !isAncestor(root, c, base));
    const { blocking, unreadable } = blockingLots(lots, root, local, carried);
    if (unreadable.length > 0) warnings.push(`commits illisibles des lots ${unreadable.map((l) => `${l.project}:${l.lot}`).join(', ')} : push non vérifié pour eux`);
    if (blocking.length === 0) continue;
    const branch = (remoteRef || ref).replace(/^refs\/heads\//, '');
    const range = tryGit(root, ['rev-list', '--first-parent', `-n${SAFE_SEARCH}`, base ? `${base}..${local}` : local]);
    const safe = (range ?? '').split('\n').filter(Boolean).find((c) => blockingLots(lots, root, c, carried).blocking.length === 0);
    const lines = blocking.map((l) => `${l.project}:${l.lot} (${LABEL[l.status]})`).join(', ');
    const how = safe ? `pousser seulement le livrable : git push ${remoteName} ${safe}:${branch}` : `aucun commit livrable dans cette plage : attendre la fin de ces lots`;
    return { refusal: `push refusé — vague ${wave} vivante : ${local.slice(0, 7)} emporte des commits de lots pas prêts : ${lines} ; ${how} (--no-verify pour passer outre)`, warning: null };
  }
  return { refusal: null, warning: warnings.length ? warnings.join(' ; ') : null };
}
