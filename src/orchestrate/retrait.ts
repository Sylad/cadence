import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRoot } from '../git.js';
import type { Args, OrchestrateIo } from './command.js';
import { addKey } from './ajout.js';
import { atWaveEnd } from './geste.js';
import { keptTrees, removeTree } from './worktree.js';

/**
 * `--remove-worktree projet:lot` (L279, R20) : seule commande qui retire un worktree conservé. Refus (code 2, rien retiré) pour le worktree d'une vague vivante (même avec `--abandon-commits`), et tant qu'un commit du lot n'est ni
 * intégré à la branche du dépôt ni confirmé abandonné par `--abandon-commits` ; un worktree entièrement intégré se retire sans option. `--wave` désigne la vague
 * quand plusieurs ont laissé un worktree pour ce lot.
 */
export function removeWorktree(args: Args, io: OrchestrateIo): number {
  const t = args.removeWorktree!;
  const key = addKey(io.cwd, t); // le projet résolu (`.` depuis le dépôt → son nom), la clé sous laquelle prepareTree a rangé le worktree
  const projectDir = t.project ? resolve(io.cwd, t.project) : io.cwd;
  const repo = existsSync(projectDir) ? gitRoot(projectDir) : null;
  const kept = repo ? keptTrees(repo, { includeActive: true }).filter((k) => k.lot === key && (args.wave === undefined || k.wave === args.wave)) : [];
  if (!repo || kept.length === 0) {
    io.err(`orchestrate : ${key} : aucun worktree conservé`);
    return 2;
  }
  if (kept.length > 1) {
    io.err(`orchestrate : ${key} : plusieurs worktrees conservés (vagues ${kept.map((k) => k.wave).join(', ')}) : précisez --wave`);
    return 2;
  }
  const k = kept[0]!;
  if (k.active) {
    // une vague vivante joue encore ce lot (ses sessions travaillent dans ce dossier) : refus sans rien retirer, même avec --abandon-commits
    io.err(`orchestrate : ${key} : la vague ${k.wave} est vivante et joue ce lot : worktree non retirable (arrêter la vague d'abord) ; ${atWaveEnd(`cadence orchestrate --remove-worktree ${t.project ?? '.'}:${t.lot} --wave ${k.wave}`)}`);
    return 2;
  }
  const gone = removeTree({ repo, dir: k.dir ?? '', branch: k.branch, base: k.base }, { abandon: args.abandonCommits });
  if (!gone.ok) {
    io.err(gone.dirty ? `orchestrate : ${key} : fichiers suivis modifiés dans le worktree (${gone.dirty.join(', ')}), --abandon-commits pour les abandonner` : gone.untracked ? `orchestrate : ${key} : fichiers non suivis dans le worktree (${gone.untracked.join(', ')}), --abandon-commits pour les abandonner` : `orchestrate : ${key} : ${gone.unintegrated} commit(s) non intégré(s), --abandon-commits pour les abandonner`);
    return 2;
  }
  io.out(`orchestrate : ${key} : worktree retiré (${gone.abandoned} commit(s) abandonné(s))`);
  return 0;
}
