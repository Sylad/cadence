import { runLot, type LotCtx } from './cycle.js';
import { lotKey, type LotState } from './state.js';

/** Deux sessions au plus en même temps (imposé ici, pas de --parallel) : deux dépôts à la fois. */
export const SLOTS = 2;

/**
 * Ordonnanceur : une file par dépôt, les lots d'un dépôt l'un après l'autre dans l'ordre donné, deux dépôts
 * au plus en parallèle. Le budget, le quota et les incidents sont vérifiés par le cycle avant chaque session.
 */
export async function runPool(ctxs: LotCtx[], slots = SLOTS, known: LotState[] = []): Promise<void> {
  const queues = new Map<string, LotCtx[]>();
  for (const c of ctxs) queues.set(c.lot.repo, [...(queues.get(c.lot.repo) ?? []), c]);
  const pending = [...queues.values()];

  const worker = async () => {
    for (let queue = pending.shift(); queue; queue = pending.shift()) {
      // Un lot en attente est revisité tant qu'un tour de la file en fait avancer un autre (sa dépendance peut venir après lui).
      for (let todo = queue, progress = true; todo.length && progress; ) {
        const waiting: LotCtx[] = [];
        progress = false;
        for (const c of todo) {
        const state = (id: string) => [...ctxs.map((o) => o.lot), ...known].find((o) => o.project === c.lot.project && o.lot === id)?.status;
        const missing = (c.lot.dependsOn ?? []).filter((id) => state(id) !== 'ready');
        if (missing.length && c.lot.steps.length === 0 && (c.lot.status === 'queued' || c.lot.status === 'suspended')) {
          // Une dépendance suspendue, en question ou pas encore jouée (reprise) : le lot attend, il reste reprenable.
          // Seule une dépendance rendue au lead ou en échec le rend aussi.
          const dead = missing.filter((id) => ['handed-back', 'failed'].includes(state(id) ?? 'failed'));
          if (dead.length === 0) {
            c.lot.outcome = `en attente de : ${missing.join(', ')}`;
            c.wave.store.writeLot(c.lot);
            c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} — ${c.lot.outcome}`);
            waiting.push(c);
            continue;
          }
          c.lot.status = 'handed-back';
          c.lot.outcome = `dépendance non prête dans la vague : ${missing.join(', ')}`;
          c.wave.store.writeLot(c.lot);
          c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} → handed-back — ${c.lot.outcome}`);
          progress = true;
          continue;
        }
        if (c.lot.outcome?.startsWith('en attente de : ')) c.lot.outcome = null;
        progress = true;
        await runLot(c);
        }
        todo = waiting;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, pending.length) }, worker));
}
