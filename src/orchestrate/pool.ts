import { runLot, type LotCtx } from './cycle.js';
import { lotKey, lotRepoPaths, type LotState } from './state.js';

/** Valeur de repli de `runPool` quand l'appelant ne donne pas de plafond ; le réglage réel est DEFAULT_MAX_SESSIONS, `--max-sessions` ou CADENCE_MAX_SESSIONS (command.ts). */
export const SLOTS = 2;

/**
 * Les groupes de lots qui partagent un dépôt (le leur, ou un dépôt voisin déclaré par `repos:`, L62), chacun dans l'ordre donné : deux lots qui partagent un dépôt sont dans
 * le même groupe. Un groupe se joue à la suite, ou — avec des worktrees (L279) — ses lots en parallèle.
 */
export function groupLots(ctxs: LotCtx[]): LotCtx[][] {
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
  return groups.map((g) => g.lots);
}

/**
 * Ordonnanceur : une file par dépôt, les lots d'un dépôt l'un après l'autre dans l'ordre donné, `slots` files au plus en parallèle. Deux lots qui partagent un dépôt
 * sont dans la même file : jamais deux sessions dans un même dépôt (le plafond global des sessions de toutes les vagues est tenu par command.ts).
 * `parallel(groupe)` (L279) : les lots de ce groupe sont chacun leur propre file — ils jouent ensemble, chacun dans son worktree, dans la limite de `slots` ;
 * un lot qui dépend d'un lot du groupe attend qu'il soit fini (ready après son intégration) avant de partir, et le lot en attente d'une place n'est pas commencé
 * (son worktree n'existe pas encore, R3). `answers` (L407) : à chaque tour, et au plus tard après `pollMs`, les lots en question dont le lead a déposé la réponse repartent comme une file de plus (un créneau libre ; sans worktree, jamais en même temps qu'un autre lot du même dépôt). `onSettled` est appelé quand un lot a fini de jouer (L132 : command.ts libère alors les dépôts que plus aucun lot ne tient). Le budget, le quota et les incidents sont vérifiés par le cycle avant chaque session.
 */
/**
 * La file des réponses du lead à une vague vivante (L407) : `take(canRun)` applique les réponses déposées aux lots en question que `canRun` accepte et rend ces lots,
 * prêts à être rejoués ; `pollMs` est l'attente entre deux lectures quand aucune file ne finit.
 */
export interface AnswerFeed {
  take: (canRun: (c: LotCtx) => boolean) => LotCtx[];
  pollMs: number;
}

export async function runPool(ctxs: LotCtx[], slots = SLOTS, known: LotState[] = [], onSettled: (c: LotCtx) => void = () => {}, parallel: (lots: LotCtx[]) => boolean = () => false, answers?: AnswerFeed): Promise<void> {
  const pending = groupLots(ctxs).flatMap((g) => (parallel(g) ? g.map((c) => [c]) : [g]));
  // Les lots pas encore finis de jouer (en file ou en cours) : un lot ne part pas tant que l'un d'eux est sa dépendance.
  const live = new Set(ctxs);

  const runQueue = async (queue: LotCtx[]) => {
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
          live.delete(c);
          onSettled(c);
          continue;
        }
        if (c.lot.outcome?.startsWith('en attente de : ')) c.lot.outcome = null;
        progress = true;
        await runLot(c);
        live.delete(c);
        onSettled(c);
      }
      todo = waiting;
    }
    for (const c of queue) live.delete(c);
  };

  /** La file d'un lot seul (groupe en parallèle) dont une dépendance joue encore : elle ne part pas. */
  const blocked = (queue: LotCtx[]) =>
    queue.length === 1 &&
    (queue[0].lot.dependsOn ?? []).some((id) => {
      const dep = ctxs.find((o) => o.lot.project === queue[0].lot.project && o.lot.lot === id);
      return !!dep && live.has(dep) && dep.lot.status !== 'ready';
    });

  const running = new Map<Promise<void>, LotCtx[]>();
  const start = (queue: LotCtx[]) => {
    const p = runQueue(queue).finally(() => running.delete(p));
    running.set(p, queue);
  };
  // Sans worktree, un lot repris ne joue pas pendant qu'un autre lot du même dépôt joue, attend un créneau ou vient d'être accepté dans ce même tour (jamais deux sessions dans un dépôt).
  const admitted: LotCtx[] = [];
  const sameRepo = (a: LotCtx, b: LotCtx) => lotRepoPaths(a.lot).some((r) => lotRepoPaths(b.lot).includes(r));
  const canRun = (c: LotCtx) => {
    if (c.tree) return true;
    if ([...running.values(), ...pending].some((q) => q.some((o) => sameRepo(c, o))) || admitted.some((o) => sameRepo(c, o))) return false;
    admitted.push(c);
    return true;
  };
  for (;;) {
    admitted.length = 0;
    for (const c of answers?.take(canRun) ?? []) {
      live.add(c);
      pending.push([c]);
    }
    while (running.size < slots) {
      const next = pending.findIndex((q) => !blocked(q));
      if (next < 0) break;
      start(pending.splice(next, 1)[0]!);
    }
    if (running.size === 0) {
      // Plus rien ne joue et chaque file restante attend une autre : le départ forcé laisse `runQueue` rendre ou garder en attente, comme avant.
      if (!pending.length) break;
      start(pending.shift()!);
      continue;
    }
    if (!answers) await Promise.race(running.keys());
    else {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([...running.keys(), new Promise<void>((res) => (timer = setTimeout(res, answers.pollMs)))]);
      clearTimeout(timer);
    }
  }
}
