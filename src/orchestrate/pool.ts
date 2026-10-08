import { runLot, type LotCtx } from './cycle.js';
import { lotKey, lotRepoPaths, type LotState } from './state.js';

/** Valeur de repli de `runPool` quand l'appelant ne donne pas de plafond ; le réglage réel est DEFAULT_MAX_SESSIONS, `--max-sessions` ou CADENCE_MAX_SESSIONS (command.ts). */
export const SLOTS = 2;

/**
 * Ordonnanceur : une file par dépôt, les lots d'un dépôt l'un après l'autre dans l'ordre donné, `slots` dépôts
 * au plus en parallèle. Deux lots qui partagent un dépôt (le leur, ou un dépôt voisin déclaré par `repos:`, L62) sont dans la
 * même file : jamais deux sessions dans un même dépôt (le plafond global des sessions de toutes
 * les vagues est tenu par command.ts). `onSettled` est appelé quand un lot a fini de jouer (L132 : command.ts libère alors les dépôts que plus aucun lot ne tient). Le budget, le quota et les incidents sont vérifiés par le cycle avant chaque session.
 */
export async function runPool(ctxs: LotCtx[], slots = SLOTS, known: LotState[] = [], onSettled: (c: LotCtx) => void = () => {}): Promise<void> {
  const groups: { repos: Set<string>; lots: LotCtx[] }[] = [];
  for (const c of ctxs) {
    const mine = lotRepoPaths(c.lot);
    const hit = groups.filter((g) => mine.some((r) => g.repos.has(r)));
    const group = hit[0] ?? { repos: new Set<string>(), lots: [] };
    if (!hit.length) groups.push(group);
    for (const other of hit.slice(1)) {
      other.repos.forEach((r) => group.repos.add(r));
      group.lots.push(...other.lots);
      groups.splice(groups.indexOf(other), 1);
    }
    mine.forEach((r) => group.repos.add(r));
    group.lots.push(c);
    group.lots.sort((x, y) => ctxs.indexOf(x) - ctxs.indexOf(y));
  }
  const pending = groups.map((g) => g.lots);

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
          onSettled(c);
          continue;
        }
        if (c.lot.outcome?.startsWith('en attente de : ')) c.lot.outcome = null;
        progress = true;
        await runLot(c);
        onSettled(c);
        }
        todo = waiting;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, pending.length) }, worker));
}
