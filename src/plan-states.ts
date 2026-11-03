import type { YAMLMap } from 'yaml';
import type { Day } from './dates.js';
import { isObject, list } from './yaml-keys.js';
import { STATUSES, type Lot, type Status } from './plan.js';

/**
 * États détaillés d'un projet (cadence.yaml : `plan.states`, L463). Chaque état a un statut de base (todo, doing, done, dropped) :
 * le statut du lot en est dérivé, les portes de cadence (`raf done`, revue, UX…) ne lisent que lui.
 */
export interface StateModel {
  /** État → statut de base, dans l'ordre déclaré. */
  states: Record<string, Status>;
  /** État → états permis ensuite. Absent : aucune garde ; présent, un état sans entrée est terminal. */
  transitions?: Record<string, string[]>;
  /** État que pose `raf done` (le « terminé non livré ») ; absent : le premier état done. */
  done?: string;
  /** État que pose la livraison (`plan.deliveredState`, L469) sur un lot terminé qu'elle contient ; absent : l'état n'est jamais modifié par la livraison. */
  delivered?: string;
  /** État bloqué : `raf status` y mémorise l'état d'avant (`state_before:`), `--back` y revient. */
  blocked?: string;
}


type Bad = (what: string) => Error;

function parseBases(raw: unknown, bad: Bad): Record<string, Status> {
  if (!isObject(raw)) throw bad('states doit être un objet { état: statut de base }');
  const states: Record<string, Status> = {};
  for (const [name, base] of Object.entries(raw)) {
    if (!STATUSES.includes(base as Status)) throw bad(`states.${name} : statut de base « ${String(base)} » inconnu (attendu : ${STATUSES.join(', ')})`);
    states[name] = base as Status;
  }
  const bases = Object.values(states);
  if (!['todo', 'doing', 'done'].every((b) => bases.includes(b as Status))) throw bad('states doit déclarer au moins un état todo, un doing et un done');
  return states;
}

function parseTransitions(raw: unknown, states: Record<string, Status>, bad: Bad): Record<string, string[]> {
  if (!isObject(raw)) throw bad('transitions doit être un objet { état: [états permis] }');
  const transitions: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(raw)) {
    if (!Object.hasOwn(states, from)) throw bad(`transitions : « ${from} » n'est pas un état déclaré`);
    for (const to of list(tos)) if (!Object.hasOwn(states, to)) throw bad(`transitions.${from} : « ${to} » n'est pas un état déclaré`);
    transitions[from] = list(tos);
  }
  return transitions;
}

function requireNames(p: Record<string, unknown>, bad: Bad): void {
  for (const k of ['doneState', 'deliveredState', 'blockedState']) if (p[k] != null && typeof p[k] !== 'string') throw bad(`${k} : un nom d'état attendu`);
}

/**
 * Lit `plan.states`, `plan.transitions`, `plan.doneState`, `plan.deliveredState` et `plan.blockedState` de cadence.yaml : `{ states }` ou `{}` quand rien n'est déclaré.
 * `foreign` : le plan est tenu par un autre outil (lots, fields, statuses, estimates), dont les états sont les siens.
 */
export function parseStates(p: Record<string, unknown>, bad: Bad, foreign: boolean): { states?: StateModel } {
  if (p.states == null) {
    for (const k of ['transitions', 'doneState', 'deliveredState', 'blockedState']) if (p[k] != null) throw bad(`${k} demande plan.states`);
    return {};
  }
  if (foreign) throw bad('states ne va pas avec un plan tenu par un autre outil (lots, fields, statuses, estimates) : ses états sont les siens');
  const states = parseBases(p.states, bad);
  const model: StateModel = { states };
  if (p.transitions != null) model.transitions = parseTransitions(p.transitions, states, bad);
  requireNames(p, bad);
  if (p.doneState != null) {
    if (states[String(p.doneState)] !== 'done') throw bad(`doneState : « ${String(p.doneState)} » n'est pas un état done`);
    model.done = String(p.doneState);
  }
  if (p.deliveredState != null) {
    if (states[String(p.deliveredState)] !== 'done') throw bad(`deliveredState : « ${String(p.deliveredState)} » n'est pas un état done`);
    model.delivered = String(p.deliveredState);
  }
  if (p.blockedState != null) {
    const base = states[String(p.blockedState)];
    if (base !== 'todo' && base !== 'doing') throw bad(`blockedState : « ${String(p.blockedState)} » doit être un état todo ou doing`);
    model.blocked = String(p.blockedState);
  }
  return { states: model };
}

/** L'état que prend un lot qui entre dans ce statut de base : `doneState` pour done, sinon le premier état déclaré de ce statut. */
export function defaultState(model: StateModel, base: Status): string | undefined {
  if (base === 'done' && model.done) return model.done;
  return Object.keys(model.states).find((s) => model.states[s] === base);
}

/** L'état d'un lot : celui qu'il porte, sinon l'état par défaut de son statut (lot écrit avant la déclaration). */
export function currentState(model: StateModel, lot: Pick<Lot, 'state' | 'status'>): string {
  return lot.state ?? defaultState(model, lot.status) ?? lot.status;
}

/** Pourquoi `from → to` est refusé par `plan.transitions` ; `null` quand c'est permis ou que rien n'est déclaré. */
export function transitionProblem(model: StateModel, from: string, to: string): string | null {
  if (!model.transitions) return null;
  const allowed = model.transitions[from];
  if (allowed?.includes(to)) return null;
  return `${from} → ${to} n'est pas permis (${allowed?.length ? `depuis ${from} : ${allowed.join(', ')}` : 'état terminal'})`;
}

/** Les écarts d'un état écrit à la main : état non déclaré, ou statut de base qui contredit `status:`. */
export function stateProblems(model: StateModel, lot: Pick<Lot, 'state' | 'status'>): string[] {
  if (lot.state === undefined) return [];
  const base = Object.hasOwn(model.states, lot.state) ? model.states[lot.state] : undefined;
  if (base === undefined) return [`état « ${lot.state} » non déclaré (cadence.yaml : plan.states)`];
  return base === lot.status ? [] : [`état « ${lot.state} » (${base}) contredit status: ${lot.status}`];
}

/**
 * Applique à `node` le changement de statut de base de `raf status` : todo → doing démarre le lot, doing → todo le remet en attente
 * (`started:` retiré) — refusé, comme `raf todo`, dès qu'un commit cite le lot : le remettre en attente perdrait leur lien. Rend le refus
 * (`move` nomme le lot, l'état visé et son statut de base), `undefined` quand le changement est fait. Autre changement : rien n'est touché,
 * le refus renvoie à sa commande.
 */
export function rebase(node: YAMLMap, lot: Lot, move: { ref: string; to: string; base: Status }, today: Day, commits: () => number): string | undefined {
  const { ref, to, base } = move;
  if (lot.status === 'todo' && base === 'doing') {
    node.set('status', 'doing');
    if (!lot.started) node.set('started', today);
    return undefined;
  }
  if (lot.status === 'doing' && base === 'todo') {
    const n = commits();
    if (n > 0) return `${ref} a ${n} commit(s) qui le citent : le remettre en attente perdrait leur lien — un état doing (raf status ${ref} <état>), ou raf drop ${ref}`;
    node.set('status', 'todo');
    node.delete('started');
    return undefined;
  }
  const command = base === 'done' ? 'done' : base === 'dropped' ? 'drop' : 'todo';
  return `${ref} : ${to} a pour statut de base ${base}, ${lot.status} aujourd'hui — passer par raf ${command} ${ref}`;
}
