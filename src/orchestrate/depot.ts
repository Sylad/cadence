import { basename, join } from 'node:path';
import { sharedStateDir } from '../state.js';
import { addHint, type RunEnv } from './ajout.js';
import { canInstallPrePush, gitProcessRunning, indexLockRefusal, snapshot } from './guard.js';
import { activeLock, REPO_LOCK } from './lock.js';
import { heldRefusal } from '../local-task.js';

/** Les fichiers suivis modifiés d'un dépôt. */
export async function trackedDirty(repo: string): Promise<string[]> {
  return (await snapshot(repo, { remote: false })).tracked.map((l) => l.slice(3));
}

/**
 * Les refus propres à un dépôt avant qu'une vague y joue (arbre sale, `index.lock`, hook de push, orchestration en cours), les mêmes pour un lot lancé, repris ou ajouté.
 * L421 : le dépôt que tient la vague qui reçoit l'ajout (`addTo`) est le sien : son arbre porte le travail de ses lots et son hook de push est le sien. `resume` : un dépôt tenu n'est pas refusé.
 */
export async function repoRefusals(repo: string, t: { projectDir: string; lot: string }, run: RunEnv, opts: { resume?: boolean; addTo?: { wave: string } }): Promise<string[]> {
  const busy = activeLock(join(sharedStateDir(repo), REPO_LOCK));
  const ours = !!opts.addTo && busy?.wave === opts.addTo.wave;
  const name = basename(repo);
  const out: string[] = [];
  if (!ours) {
    const dirty = await trackedDirty(repo);
    if (dirty.length) out.push(`${name} : arbre sale, ${dirty.length} fichier(s) suivi(s) modifié(s) : ${dirty.join(', ')}`);
    const locked = indexLockRefusal(repo, run.io.now(), run.deps.gitRunning ?? gitProcessRunning);
    if (locked) out.push(`${name} : ${locked}`);
    const hook = canInstallPrePush(repo);
    if (hook) out.push(`${name} : ${hook}`);
  }
  if (busy && !opts.resume && !ours) out.push(`${heldRefusal(repo, busy)}${addHint(t, busy.wave, run.launch)}`);
  return out;
}
