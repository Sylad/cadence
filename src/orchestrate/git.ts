import { execFileSync } from 'node:child_process';

/** Une commande git dans `cwd`, sa sortie sans les blancs de bord ; lève si elle échoue. Commune à l'orchestration (worktrees, intégration, cycle). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Le message d'une commande git qui a échoué : sa sortie d'erreur (sur une ligne), à défaut le message de l'exception. */
export function gitFailure(e: unknown): string {
  const err = (e as { stderr?: unknown }).stderr;
  const text = typeof err === 'string' && err.trim() ? err : e instanceof Error ? e.message : String(e);
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/** Comme `git`, null quand la commande échoue. */
export const tryGit = (cwd: string, ...args: string[]): string | null => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};
