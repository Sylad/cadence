import { coversFile, hasPaths, resourcesTouching, type Resources } from '../resources.js';
import { baseBranchOf, branchExists, git, gitFailure, tryGit } from './worktree.js';

/** Le diff d'un lot (R6) : les fichiers de ses commits ; `failure` dit la cause d'un diff que git n'a pas pu lire (R12 : les fichiers sont alors vides). */
export interface LotDiff {
  files: string[];
  failure: string | null;
}

/** Un diff vide sans cause, neuf à chaque appel (les appelants peuvent garder la liste). */
const none = (): LotDiff => ({ files: [], failure: null });

/**
 * Les fichiers des COMMITS de la branche d'un lot depuis le point de départ de sa base (R6) : `git diff --name-only --no-renames <merge-base>..<branche>`,
 * un renommage comptant l'ancien et le nouveau chemin ; rien de ce qui n'est pas commité. Branche absente ou sans clé `cadence-base` : diff vide,
 * sans cause. Git qui échoue (base disparue ou renommée, merge-base vide, dépôt illisible) : diff vide avec la cause (R12), jamais une exception.
 */
export function lotDiff(repo: string, branch: string): LotDiff {
  if (!branchExists(repo, branch)) return none();
  const base = baseBranchOf(repo, branch);
  if (base === null) return none();
  try {
    const start = git(repo, 'merge-base', `refs/heads/${branch}`, `refs/heads/${base}`);
    if (!start) return { files: [], failure: 'git merge-base ne rend rien' };
    return { files: git(repo, 'diff', '--name-only', '--no-renames', `${start}..refs/heads/${branch}`).split('\n').filter(Boolean), failure: null };
  } catch (e) {
    return { files: [], failure: gitFailure(e) };
  }
}

/**
 * Les ressources déclarées que le diff du lot touche (R5, R6), relues à chaque appel sans cache (le diff change à chaque commit). Aucune ressource
 * à chemins : rien n'est lu (R1). `warn` reçoit la cause d'un diff illisible (R12) ; le lot ne déduit alors rien.
 */
export function deducedResources(repo: string, branch: string, declared: Resources, warn: (cause: string) => void = () => {}): string[] {
  if (!hasPaths(declared)) return [];
  const d = lotDiff(repo, branch);
  if (d.failure !== null) warn(d.failure);
  return [...resourcesTouching(declared, d.files).keys()];
}

/** Commits listés par fichier dans la note de conflit (R11) ; au-delà, « +N autre(s) ». */
const CONFLICT_COMMITS = 3;

/**
 * Le complément du message de conflit d'intégration (R11) : pour chaque ressource qu'un fichier en conflit couvre, « ; ressource « <nom> » : <fichier> modifié dans
 * <base> depuis le départ du lot par <sha7> <sujet>[, …] », avec les commits de la base qui ont touché ce fichier depuis le point de départ du lot (le merge-base
 * de la branche avec la base au moment du conflit, exact après un rebase rejoué), trois au plus puis « +N autre(s) ». Rien pour un fichier hors ressource,
 * sans commit de base, ou quand git ne rend rien.
 */
export function conflictNotes(work: string, base: string, files: string[], declared: Resources): string {
  if (files.length === 0 || !hasPaths(declared)) return '';
  const start = tryGit(work, 'merge-base', 'HEAD', `refs/heads/${base}`);
  if (!start) return '';
  const notes: string[] = [];
  for (const [name, paths] of declared.paths) {
    for (const file of files.filter((f) => paths.some((p) => coversFile(p, f)))) {
      const commits = (tryGit(work, 'log', '--format=%H %s', `${start}..refs/heads/${base}`, '--', file) ?? '').split('\n').filter(Boolean);
      if (!commits.length) continue;
      const more = commits.length - CONFLICT_COMMITS;
      const shown = commits.slice(0, CONFLICT_COMMITS).map((c) => `${c.slice(0, 7)} ${c.slice(41)}`);
      notes.push(` ; ressource « ${name} » : ${file} modifié dans ${base} depuis le départ du lot par ${shown.join(', ')}${more > 0 ? `, +${more} autre${more > 1 ? 's' : ''}` : ''}`);
    }
  }
  return notes.join('');
}
