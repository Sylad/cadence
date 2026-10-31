import { existsSync, realpathSync } from 'node:fs';
import { liveWaves } from './registry.js';
import { lotKey, lotRepoPaths, RunStore } from './state.js';
import { lotTreeDir } from './worktree.js';

/** Les étapes d'un lot où une session de la vague écrit dans le dépôt (L475) : le lot en file, en question, prêt, rendu, en échec ou suspendu n'y touche pas. */
const WRITING = new Set(['implementing', 'reviewing', 'fixing']);

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Lots de la vague vivante `pid` dont une session travaille dans l'ARBRE PRINCIPAL de `repo` (L475) : un lot en implémentation, revue ou correction qui ne joue pas dans un worktree
 * (vague sans worktree, ou lot dont le dossier de worktree n'existe pas). Un commit de plan du lead y est un commit de plus dans l'historique que la revue ou l'intégration compare
 * à celui du lot : le lot est rendu (cas du 30-10). Clés `projet:lot` ; liste vide si aucun ; null si l'état de la vague est illisible.
 */
export function mainTreeWorkers(home: string, pid: number, repo: string): string[] | null {
  try {
    const w = liveWaves(home).find((x) => x.pid === pid);
    const store = w && RunStore.find(w.cwd, w.wave);
    if (!store) return null;
    return store
      .lots()
      .filter((l) => WRITING.has(l.status) && lotRepoPaths(l).some((r) => real(r) === real(repo)) && !existsSync(lotTreeDir(store.dir, l.project, l.lot, l.repo)))
      .map((l) => lotKey(l.project, l.lot));
  } catch {
    return null;
  }
}
