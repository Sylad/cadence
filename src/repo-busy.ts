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
  const held = mainTreeHeld(root, env);
  if (held) err(`avertissement : ${held.where} — un commit de plan maintenant rendrait ces lots à la revue ; attendre la fin de leur étape, ou écrire le plan sans le committer`);
}

/**
 * La vague vivante qui écrit dans l'arbre principal du dépôt (L475), ou null : `where` la nomme avec les lots qui y travaillent.
 * Partagé par l'avertissement de `raf add|note` et le refus de `raf done` (L521).
 */
function mainTreeHeld(root: string, env: Record<string, string | undefined>): { wave: string; where: string } | null {
  if (env.CADENCE_ORCHESTRATED) return null;
  const top = gitRoot(root);
  if (!top || !statSync(join(top, '.git')).isDirectory()) return null;
  const holder = activeLock(join(sharedStateDir(root), REPO_LOCK));
  if (!holder) return null;
  const working = mainTreeWorkers(cadenceHome(), holder.pid, top);
  if (!working?.length) return null;
  return { wave: holder.wave, where: `la vague ${holder.wave} (pid ${holder.pid}) travaille dans l'arbre principal de ce dépôt (${working.join(', ')})` };
}

/**
 * `raf done` différé (L521) : dans un dépôt sans worktrees, écrire le plan pendant qu'une session travaille dans l'arbre principal le lui laisse modifié
 * (le lot suivant est rendu « dépôt sale après implement », avatar L57 le 01-11). Refuse sans rien écrire et dit l'ordre sûr ; `--now` passe outre.
 */
export function refuseDoneInMainTree(root: string, env: Record<string, string | undefined>, a: { command: string; lot: string; now?: boolean }): void {
  if (a.command !== 'done' || a.now) return;
  const held = mainTreeHeld(root, env);
  if (held) throw new RafError(`done différé : ${held.where} — écrire le plan maintenant lui laisserait un arbre modifié (le lot suivant serait rendu « dépôt sale après implement »). Ordre sûr : attendre la fin de leur étape (cadence orchestrate --status), puis relancer \`raf done ${a.lot}\` ; ou \`--now\` pour écrire tout de suite et accepter que ces lots soient rendus`);
}

/** La vague qui tient le verrou du dépôt tant qu'un de ses lots y travaille encore (état illisible : on la tient pour active) ; null si le dépôt est libre. Une tâche locale du lead (L519) la tient toujours (elle n'a pas de lots de vague à lire). Avec `refusing` (le nom de la commande), une tâche locale refuse la commande d'un `RafError` qui la nomme et dit comment la finir, sans lire de vague ni conseiller `--sha` : `deliver`, `raf move`, `spec reseal` et `spec green`. Partagé par `deliver`, `raf move`, le hook pre-push, `spec reseal` et `spec green`. */
export function waveHolding(root: string, refusing?: string): OLock | null {
  const orchestrating = activeLock(join(sharedStateDir(root), REPO_LOCK));
  if (!orchestrating) return null;
  if (refusing && localLotOf(orchestrating.wave)) throw new RafError(`${refusing} : ${heldRefusal(root, orchestrating)}`);
  const stillOpen = openLotsIn(cadenceHome(), orchestrating.pid, root);
  return stillOpen === null || stillOpen.length > 0 ? orchestrating : null;
}
