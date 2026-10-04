import { runLot, type LotCtx } from './cycle.js';
import { lotKey } from './state.js';

/** Deux sessions au plus en même temps (imposé ici, pas de --parallel) : deux dépôts à la fois. */
export const SLOTS = 2;

/**
 * Ordonnanceur : une file par dépôt, les lots d'un dépôt l'un après l'autre dans l'ordre donné, deux dépôts
 * au plus en parallèle. Le budget, le quota et les incidents sont vérifiés par le cycle avant chaque session.
 */
export async function runPool(ctxs: LotCtx[], slots = SLOTS): Promise<void> {
  const queues = new Map<string, LotCtx[]>();
  for (const c of ctxs) queues.set(c.lot.repo, [...(queues.get(c.lot.repo) ?? []), c]);
  const pending = [...queues.values()];

  const worker = async () => {
    for (let queue = pending.shift(); queue; queue = pending.shift()) {
      for (const c of queue) {
        const missing = (c.lot.dependsOn ?? []).filter((id) => ctxs.find((o) => o.lot.project === c.lot.project && o.lot.lot === id)?.lot.status !== 'ready');
        if (missing.length && c.lot.status === 'queued') {
          c.lot.status = 'handed-back';
          c.lot.outcome = `dépendance non prête dans la vague : ${missing.join(', ')}`;
          c.wave.store.writeLot(c.lot);
          c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} → handed-back — ${c.lot.outcome}`);
          continue;
        }
        await runLot(c);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, pending.length) }, worker));
}
