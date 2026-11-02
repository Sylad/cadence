import { statSync } from 'node:fs';
import { join } from 'node:path';
import { gitRoot } from './git.js';
import { activeLock, REPO_LOCK, type OLock } from './orchestrate/lock.js';
import { INTEGRATION_LOCK } from './orchestrate/integrate.js';
import { mainTreeWorkers } from './orchestrate/main-tree.js';
import { cadenceHome, openLotsIn } from './orchestrate/registry.js';
import { sharedStateDir } from './state.js';
import { heldRefusal, localLotOf } from './local-task.js';
import { RafError } from './plan.js';

// Ce que `raf`, `deliver` et `spec` lisent du verrou du dépôt : une orchestration (ou une tâche locale du lead, L519) qui le tient, ou une intégration en cours.

/**
 * Avertit (stderr, sans refuser) quand une intégration du dépôt est en cours (L425) : le plan écrit dans l'arbre principal est un fichier suivi modifié, et
 * l'intégration en cours le voit et refuse son lot (« arbre du dépôt modifié »). Seul l'arbre principal est concerné : dans le worktree d'un lot, l'écriture
 * ne change pas l'arbre que l'intégration contrôle.
 */
export function warnIntegrating(root: string, err: (line: string) => void): void {
  const top = gitRoot(root);
  if (!top || !statSync(join(top, '.git')).isDirectory()) return;
  const holder = activeLock(join(sharedStateDir(root), INTEGRATION_LOCK));
  if (holder) err(`avertissement : intégration en cours (vague ${holder.wave}, pid ${holder.pid}) — ce plan est un fichier suivi modifié de l'arbre principal, l'intégration en cours peut refuser son lot (arbre du dépôt modifié) : committer le plan sans attendre`);
}

/**
 * Avertit (stderr, sans refuser) quand une session de vague écrit dans l'arbre principal du dépôt (L475) : un lot en implémentation, revue ou correction sans worktree.
 * Un commit de plan du lead à ce moment-là rend le lot (cas du 30-10 : cadence L458 rendu par le commit du plan). Sans effet dans le worktree d'un lot, ou depuis une session de la vague (c'est elle qui tient l'arbre).
 */
export function warnWaveWorking(root: string, env: Record<string, string | undefined>, err: (line: string) => void): void {
  if (env.CADENCE_ORCHESTRATED) return;
  const top = gitRoot(root);
  if (!top || !statSync(join(top, '.git')).isDirectory()) return;
  const holder = activeLock(join(sharedStateDir(root), REPO_LOCK));
  if (!holder) return;
  const working = mainTreeWorkers(cadenceHome(), holder.pid, top);
  if (working?.length) err(`avertissement : la vague ${holder.wave} (pid ${holder.pid}) travaille dans l'arbre principal de ce dépôt (${working.join(', ')}) — un commit de plan maintenant rendrait ces lots à la revue ; attendre la fin de leur étape, ou écrire le plan sans le committer`);
}

/** La vague qui tient le verrou du dépôt tant qu'un de ses lots y travaille encore (état illisible : on la tient pour active) ; null si le dépôt est libre. Une tâche locale du lead (L519) la tient toujours (elle n'a pas de lots de vague à lire). Avec `refusing` (le nom de la commande), une tâche locale refuse la commande d'un `RafError` qui la nomme et dit comment la finir, sans lire de vague ni conseiller `--sha` : `deliver` et `raf move`. Partagé par `deliver`, `raf move`, le hook pre-push et `spec reseal`. */
export function waveHolding(root: string, refusing?: string): OLock | null {
  const orchestrating = activeLock(join(sharedStateDir(root), REPO_LOCK));
  if (!orchestrating) return null;
  if (refusing && localLotOf(orchestrating.wave)) throw new RafError(`${refusing} : ${heldRefusal(root, orchestrating)}`);
  const stillOpen = openLotsIn(cadenceHome(), orchestrating.pid, root);
  return stillOpen === null || stillOpen.length > 0 ? orchestrating : null;
}
