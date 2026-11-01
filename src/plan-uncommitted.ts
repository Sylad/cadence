import { relative } from 'node:path';
import { dirtyPaths, gitRoot } from './git.js';
import { PLAN_ACTIONS, planCommitMessage } from './plan-commit.js';
import type { Plan } from './plan.js';

/**
 * `raf done`, `raf ux <lot>` et `raf review <lot>` (L509) écrivent le plan et ne le commitent jamais (voulu : raf n'a pas de réglage qui commite, docs/raf.md) : la commande de commit du plan et des fichiers
 * que `plan.onWrite` produit, au gabarit `plan.commit` du projet (L371). Null hors d'un dépôt git ou quand rien n'est à commiter.
 */
function uncommittedPlanCommand(plan: Plan, root: string, lot: string, template: string | undefined, action: string = PLAN_ACTIONS.done): string | null {
  const repo = gitRoot(root);
  if (!repo) return null;
  // Seuls les chemins que git voit modifiés : `git add` d'un chemin absent ou ignoré est fatal.
  const paths = dirtyPaths(repo, [relative(repo, plan.path), ...plan.files, ...plan.produced, ...plan.archiveFiles().map((f) => relative(repo, f))]);
  if (paths.length === 0) return null;
  const quote = (t: string) => (/^[\w./-]+$/.test(t) ? t : `'${t.replaceAll("'", "'\\''")}'`);
  const message = planCommitMessage(template, { lot, action });
  const list = paths.map(quote).join(' ');
  return `plan non commité : raf ne commite jamais (voulu, ce n'est pas un réglage), à commiter :\n  git add -- ${list} && git commit -m ${quote(message)} -- ${list}`;
}

/** Dit sur `out` la commande de commit du plan, quand il y a quelque chose à commiter (rien sinon). */
export function printUncommittedPlan(out: (line: string) => void, ...args: Parameters<typeof uncommittedPlanCommand>): void {
  const command = uncommittedPlanCommand(...args);
  if (command) out(command);
}
