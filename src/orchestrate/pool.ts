import { runLot, type LotCtx } from './cycle.js';
import { slowWaitLog } from './cycle/plan-writes.js';
import { WAIT_LOG_MS } from './integrate.js';
import { deducedResources } from './lot-diff.js';
import { declaredFor } from '../resources.js';
import { lotKey, lotRepoPaths, type LotState } from './state.js';

/** Valeur de repli de `runPool` quand l'appelant ne donne pas de plafond ; le réglage réel est DEFAULT_MAX_SESSIONS, `--max-sessions` ou CADENCE_MAX_SESSIONS (command-args.ts). */
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
 * Ordonnanceur : une file par dépôt, les lots d'un dépôt l'un après l'autre dans l'ordre donné, `slots` files au plus qui tiennent un créneau en parallèle (L591 : une file dont le lot attend son tour d'intégration n'en tient pas, `holdingSlots`). Deux lots qui partagent un dépôt
 * sont dans la même file : jamais deux sessions dans un même dépôt (le plafond global des sessions de toutes les vagues est tenu par execute.ts).
 * `parallel(groupe)` (L279) : les lots de ce groupe sont chacun leur propre file — ils jouent ensemble, chacun dans son worktree, dans la limite de `slots` ;
 * un lot qui dépend d'un lot du groupe attend qu'il soit fini (ready après son intégration) avant de partir, et le lot en attente d'une place n'est pas commencé
 * (son worktree n'existe pas encore, R3). Les lots qui portent la même ressource `uses:` (L551) jouent l'un après l'autre : la file qui en veut une que tient une file qui joue attend qu'elle ait fini (les dépôts différents ne s'en préoccupent pas, la ressource est un verrou de plus). `answers` (L407) : à chaque tour, et au plus tard après `pollMs`, les lots en question dont le lead a déposé la réponse repartent comme une file de plus (un créneau libre ; sans worktree, jamais en même temps qu'un autre lot du même dépôt). `onSettled` est appelé quand un lot a fini de jouer (L132 : execute.ts libère alors les dépôts que plus aucun lot ne tient). L670 : une file encore en attente après `wave.integrate.slowMs` (WAIT_LOG_MS, 10 s) écrit une ligne au journal avec ce qui la retient (les files qui tiennent les créneaux, la dépendance qui joue, la ressource tenue), une fois par attente. Le budget, le quota et les incidents sont vérifiés par le cycle avant chaque session.
 */
/**
 * La file des demandes du lead à une vague vivante (L407 : réponses, L421 : lots ajoutés) : `take(canRun, vacantLanes)` applique les réponses déposées aux lots en question que `canRun` accepte et ajoute les lots demandés,
 * et rend ces lots, prêts à être joués ; `vacantLanes` (L527) est le nombre de créneaux DE LA VAGUE que ni une file qui joue ni une file en attente n'occupe, de quoi tirer le lot prêt suivant du plan — pas les « créneaux libres » de la machine (`freeSlots` du registre, plafond commun à toutes les vagues : voir docs/concepts.md, « Slots and holds ») ;
 * `pollMs` est l'attente entre deux lectures quand aucune file ne finit.
 */
export interface AnswerFeed {
  take: (canRun: (c: LotCtx) => boolean, vacantLanes: number) => LotCtx[] | Promise<LotCtx[]>;
  pollMs: number;
}

/** Les dépendances d'un lot qui ne sont pas prêtes (`ctxs` et `known` disent l'état de chacune). */
function missingDeps(c: LotCtx, ctxs: LotCtx[], known: LotState[]): string[] {
  const state = (id: string) => [...ctxs.map((o) => o.lot), ...known].find((o) => o.project === c.lot.project && o.lot === id)?.status;
  return (c.lot.dependsOn ?? []).filter((id) => state(id) !== 'ready');
}

/** Un lot pas encore commencé (aucune étape) dont une dépendance n'est pas prête : il attend, aucune session ne joue pour lui (L520). */
export function awaitsDependency(c: LotCtx, ctxs: LotCtx[], known: LotState[]): boolean {
  return c.lot.steps.length === 0 && (c.lot.status === 'queued' || c.lot.status === 'suspended') && missingDeps(c, ctxs, known).length > 0;
}

/** Les dépendances d'un lot seul (groupe en parallèle) qui jouent encore : sa file ne part pas tant qu'il y en a une. */
function playingDeps(queue: LotCtx[], ctxs: LotCtx[], live: Set<LotCtx>): string[] {
  if (queue.length !== 1) return [];
  return (queue[0].lot.dependsOn ?? []).filter((id) => {
    const dep = ctxs.find((o) => o.lot.project === queue[0].lot.project && o.lot.lot === id);
    return !!dep && live.has(dep) && dep.lot.status !== 'ready';
  });
}

/**
 * Les ressources tenues par les files qui jouent (L551) : les `uses:` des lots non finis de ces files, lus du plan une fois, plus celles que le diff de leur
 * worktree déduit (L558, R5 : ressources à chemins déclarées dans le cadence.yaml parent), relu à chaque appel sans cache (R7 : le diff change à chaque commit).
 * `wanted(queue)` rend les ressources tenues qu'un lot de la file veut par ses `uses:` (vide : la file peut partir). `warn(c, cause)` reçoit un diff que git n'a pas pu lire (R12) : le lot ne
 * tient alors que ses `uses:` ; la même cause n'est redite pour un lot que si elle a changé. Exporté pour ses tests ; `runPool` en est le seul appelant.
 */
export function resourceLock(running: Map<Promise<void>, LotCtx[]>, live: Set<LotCtx>, warn: (c: LotCtx, cause: string) => void = () => {}): { wanted: (queue: LotCtx[]) => string[] } {
  const cache = new WeakMap<LotCtx, string[]>();
  const usesOf = (c: LotCtx): string[] => {
    if (!cache.has(c)) cache.set(c, c.loadPlan().lots().find((l) => l.id === c.lot.lot)?.uses ?? []);
    return cache.get(c)!;
  };
  const warned = new WeakMap<LotCtx, string>();
  const heldBy = (c: LotCtx): string[] => {
    if (!c.tree) return usesOf(c);
    const causes: string[] = [];
    const deduced = deducedResources(c.lot.repo, c.tree.branch, declaredFor(c.lot.repo), (why) => causes.push(why));
    const cause = causes[0];
    if (cause === undefined) warned.delete(c);
    else if (warned.get(c) !== cause) {
      warned.set(c, cause);
      warn(c, cause);
    }
    return [...usesOf(c), ...deduced];
  };
  return {
    wanted: (queue) => {
      const held = new Set([...running.values()].flatMap((q) => q.filter((o) => live.has(o)).flatMap(heldBy)));
      return held.size > 0 ? [...new Set(queue.flatMap((c) => usesOf(c).filter((r) => held.has(r))))] : [];
    },
  };
}

/**
 * Les files qui tiennent un créneau (L591) : celle dont le lot attend son tour d'intégration n'en occupe pas ; il le reprend sans le redemander (les files en cours peuvent alors dépasser `slots` le temps de sa revue courte).
 * L624 : celle dont le lot joue sa porte sur l'hôte `gate.host` non plus (aucune session claude, aucun processeur local) ; la porte finie, le lot reprend sa place pour la suite, comme à l'intégration.
 */
const holdsSlot = (q: LotCtx[]): boolean => !q.some((c) => c.waitsTurn || c.lot.gate?.remote);
const holdingSlots = (running: Map<Promise<void>, LotCtx[]>): number => [...running.values()].filter(holdsSlot).length;

/** Réveille l'ordonnanceur quand un lot entre dans l'attente de son tour d'intégration ou en sort (L591) : `arm` à chaque tour, avant de compter les files, `poked` pour l'attendre. */
function turnWatch(): { hear: (c: LotCtx) => void; arm: () => void; poked: () => Promise<void> } {
  let poke = () => {};
  let poked = Promise.resolve();
  return {
    hear: (c) => {
      c.turnChanged = () => poke();
    },
    arm: () => {
      poked = new Promise<void>((res) => (poke = res));
    },
    poked: () => poked,
  };
}

/** Place les lots pris à ce tour (L620) : une intégration reprise (`next: integrate`, déposée par le lead : sa revue est faite) passe devant les files en attente, dans l'ordre où elle est prise ; réponses et lots ajoutés se placent derrière. */
function enqueueTaken(pending: LotCtx[][], taken: LotCtx[], live: Set<LotCtx>, hear: (c: LotCtx) => void): void {
  const front: LotCtx[][] = [];
  for (const c of taken) {
    live.add(c);
    hear(c);
    (c.lot.next === 'integrate' ? front : pending).push([c]);
  }
  pending.unshift(...front);
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
        const missing = missingDeps(c, ctxs, known);
        if (awaitsDependency(c, ctxs, known)) {
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

  const running = new Map<Promise<void>, LotCtx[]>();
  const resources = resourceLock(running, live, (c, cause) => c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} diff illisible (git : ${cause}) : aucune ressource déduite`));

  /** La file qui ne part pas : celle d'un lot seul (groupe en parallèle) dont une dépendance joue encore, ou celle dont un lot veut une ressource qu'une file qui joue tient (L551). */
  const blocked = (queue: LotCtx[]) => playingDeps(queue, ctxs, live).length > 0 || resources.wanted(queue).length > 0;

  // L670 : une file encore en attente après `slowMs` (10 s) dit au journal ce qui la retient, une fois par attente (L477 : 18,6 min sans ligne derrière des files pleines) ; le minuteur est effacé quand la file part.
  const key = (c: LotCtx) => lotKey(c.lot.project, c.lot.lot);
  const retains = (queue: LotCtx[]): string => {
    const deps = playingDeps(queue, ctxs, live);
    if (deps.length) return `la fin du lot ${deps.join(', ')} dont il dépend, qui joue encore`;
    const wanted = resources.wanted(queue);
    if (wanted.length) return `la ressource ${wanted.join(', ')}, tenue par une file qui joue`;
    const held = [...running.values()].filter(holdsSlot).map((q) => q.filter((c) => live.has(c)).map(key).join(' puis '));
    return `un créneau de session (${slots} créneau${slots > 1 ? 'x' : ''}, tenu${slots > 1 ? 's' : ''} par ${held.length > 1 ? 'les files' : 'la file'} ${held.join(', ')})`;
  };
  const slowTimers = new Map<LotCtx[], NodeJS.Timeout>();
  const watch = (queue: LotCtx[]) => {
    if (slowTimers.has(queue)) return;
    const c = queue.find((o) => live.has(o)) ?? queue[0]!;
    const timer = setTimeout(() => {
      if (pending.includes(queue)) slowWaitLog(c, 'sa session suivante')(retains(queue));
    }, c.wave.integrate?.slowMs ?? WAIT_LOG_MS);
    timer.unref?.();
    slowTimers.set(queue, timer);
  };
  const unwatch = (queue: LotCtx[]) => {
    clearTimeout(slowTimers.get(queue));
    slowTimers.delete(queue);
  };

  const start = (queue: LotCtx[]) => {
    unwatch(queue);
    const p = runQueue(queue).finally(() => running.delete(p));
    running.set(p, queue);
  };
  // Sans worktree, un lot repris ne joue pas pendant qu'un autre lot du même dépôt joue, attend un créneau ou vient d'être accepté dans ce même tour (jamais deux sessions dans un dépôt).
  const admitted: LotCtx[] = [];
  const sameRepo = (a: LotCtx, b: LotCtx) => lotRepoPaths(a.lot).some((r) => lotRepoPaths(b.lot).includes(r));
  const canRun = (c: LotCtx) => {
    if (c.tree) return true;
    const taken = [...running.values(), ...pending].some((q) => q.some((o) => sameRepo(c, o))) || admitted.some((o) => sameRepo(c, o));
    return !taken && admitted.push(c) > 0;
  };
  const turns = turnWatch();
  ctxs.forEach(turns.hear);
  try {
    for (;;) {
      admitted.length = 0;
      enqueueTaken(pending, (await answers?.take(canRun, Math.max(0, slots - holdingSlots(running) - pending.filter((q) => !blocked(q)).length))) ?? [], live, turns.hear);
      turns.arm();
      while (holdingSlots(running) < slots) {
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
      pending.forEach(watch);
      if (!answers) await Promise.race([...running.keys(), turns.poked()]);
      else {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([...running.keys(), turns.poked(), new Promise<void>((res) => (timer = setTimeout(res, answers.pollMs)))]);
        clearTimeout(timer);
      }
    }
  } finally {
    slowTimers.forEach((t) => clearTimeout(t));
  }
}
