import { tryGit } from './git.js';
import { blockingLots, LABEL } from './orchestrate/table.js';
import type { LotState } from './orchestrate/state.js';

const ZERO = /^0+$/;
/** Combien de commits de la plage on essaie, du plus récent au plus ancien, pour trouver le dernier livrable. */
const SAFE_SEARCH = 200;

/**
 * Le refus d'un push (hook pre-push de la vague, L405) : une ligne de l'entrée standard de git (`<réf locale> <sha local> <réf distante> <sha distant>`)
 * dont l'ascendance du sha local (la garde de `deliver --sha`, pas la seule plage `distant..local`) tient un commit d'un lot de la vague qui n'est pas prêt,
 * ou dont un lot pas prêt a des commits illisibles (plan qui ne le connaît plus, dépôt absent) : la vague refuserait ce push de toute façon (`leadDelivery`),
 * le hook le refuse donc aussi, comme `deliver --sha`. Le message nomme les lots et leur état, et donne la commande sûre :
 * `git push <remote> <dernier sha livrable>:<branche distante>` (le remote reçu en argument du hook, la branche de la réf distante) ; un lot illisible
 * n'en laisse aucune, puisqu'aucun sha ne passe la garde tant qu'il l'est ; une réf poussée hors `refs/heads/` (un tag) n'en a jamais non plus (pousser un autre sha sous ce nom publierait un tag qui ne nomme pas son commit). Une suppression de branche, un sha illisible ou une plage sans lot pas prêt passent (null).
 */
export function pushRefusal(root: string, wave: string, lots: LotState[], input: string, remoteName = 'origin'): string | null {
  for (const entry of input.split('\n')) {
    const [ref, local, remoteRef, remote] = entry.trim().split(/\s+/);
    if (!ref || !local || ZERO.test(local) || !/^[0-9a-f]{7,64}$/.test(local)) continue;
    const base = remote && !ZERO.test(remote) ? remote : null;
    // La garde de la vague (`leadDelivery`, `deliver --sha`) : toute l'ascendance du sha poussé, pas seulement la plage. Un commit pas prêt déjà sur le distant bloque encore.
    const { blocking, unreadable } = blockingLots(lots, root, local);
    if (blocking.length === 0 && unreadable.length === 0) continue;
    const target = remoteRef || ref;
    // Hors refs/heads/ (un tag, une autre réf) : `<sha>:refs/tags/<tag>` créerait sur le distant un tag qui ne nomme pas le commit du tag local. Pas de commande sûre.
    const notBranch = target.startsWith('refs/') && !target.startsWith('refs/heads/');
    const branch = target.replace(/^refs\/heads\//, '');
    const range = unreadable.length > 0 || notBranch ? null : tryGit(root, ['rev-list', '--first-parent', `-n${SAFE_SEARCH}`, base ? `${base}..${local}` : local]);
    const safe = (range ?? '').split('\n').filter(Boolean).find((c) => {
      const g = blockingLots(lots, root, c);
      return g.blocking.length === 0 && g.unreadable.length === 0;
    });
    const name = (l: LotState) => `${l.project}:${l.lot} (${LABEL[l.status]})`;
    const why = [
      blocking.length > 0 ? `emporte des commits de lots pas prêts : ${blocking.map(name).join(', ')}` : null,
      unreadable.length > 0 ? `commits illisibles (plan du projet ou dépôt) des lots pas prêts ${unreadable.map(name).join(', ')} : push non vérifiable` : null,
    ].filter(Boolean).join(' ; ');
    const how = notBranch ? `${target} doit nommer son propre commit : attendre que ces lots soient prêts, ou poser la réf sur un commit livrable` : safe ? `pousser seulement le livrable : git push ${remoteName} ${safe}:${branch}` : unreadable.length > 0 ? `rétablir le plan ou attendre la fin de ces lots` : `aucun commit livrable dans cette plage : attendre la fin de ces lots`;
    return `push refusé — vague ${wave} vivante : ${local.slice(0, 7)} ${why} ; ${how} (--no-verify pour passer outre)`;
  }
  return null;
}
