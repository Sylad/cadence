// Revue L779 r1 : un lot peut être démarré sans que le plan le dise encore. `raf start` sur une branche tenue va au plan en attente (L779), et un
// `cadence run --lot` sert un lot que personne n'a démarré. Le tour, raf next et les ressources libres le voient pourtant en cours : sinon le lead
// relancerait le lot pendant son propre run, ou un lot qui partage sa ressource `uses:`.
import { resolve } from 'node:path';
import { liveRuns } from './orchestrate/registry.js';
import type { Lot } from './plan.js';
import { readPending } from './repo-held.js';

/** Les lots du dépôt `root` démarrés hors du plan, avec ce qui les démarre : « raf start en attente » ou « cadence run <id> » (run vivant de `home`). */
export function startedElsewhere(root: string, home: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const w of readPending(root)) if (w.argv[0] === 'start' && w.argv[1]) out.set(w.argv[1], 'raf start en attente');
  } catch {
    // plan en attente illisible : raf attente le dit
  }
  const repo = resolve(root);
  for (const r of liveRuns(home)) if (r.lot && resolve(r.repo) === repo && !out.has(r.lot)) out.set(r.lot, `cadence run ${r.id}`);
  return out;
}

/** Les lots du plan, ceux de `started` encore todo vus `doing` (pour `nextUp`) ; le plan lui-même n'est pas touché. */
export const withStarted = (lots: Lot[], started: Map<string, string>): Lot[] =>
  started.size ? lots.map((l) => (l.status === 'todo' && started.has(l.id) ? { ...l, status: 'doing' as const } : l)) : lots;
