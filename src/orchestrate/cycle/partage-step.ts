import { partageOf } from '../partage.js';
import { lotKey } from '../state.js';
import { type LotCtx, workDir as wd } from './ctx.js';

/**
 * Précheck de partage (L500) : au départ d'un lot (pas d'un lot repris de sa branche conservée), les tests scellés d'autres lots et les fichiers que touche aussi un autre lot de la vague ou un
 * worktree conservé, pour ce que son texte (titre, goal, notes, sous-tâches) cite. Rangé dans `partage` du lot (brief de l'implémentation, tableau) ; une lecture
 * impossible n'arrête pas le lot : un avertissement au journal.
 */
export function notePartage(c: LotCtx): void {
  const l = c.lot;
  if (l.resumedFrom) return; // ses commits sont les siens : le lot repart de sa branche conservée
  try {
    const lot = c.loadPlan().lot(l.lot);
    const text = [lot.title, l.goal ?? lot.goal, ...lot.notes.map((n) => n.text), ...lot.tasks.map((t) => t.title)].filter(Boolean).join('\n');
    const found = partageOf({ root: wd(c), repo: l.repo, specDir: c.config.spec.dir, lot: l.lot, key: lotKey(l.project, l.lot), text });
    if (found) l.partage = found;
  } catch (e) {
    l.warnings.push(`précheck de partage : lecture impossible (${(e as Error).message})`);
  }
}
