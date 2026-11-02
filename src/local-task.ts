import { basename, join } from 'node:path';
import type { Day } from './dates.js';
import { REPO_LOCK, activeLock, lockOverdue, releaseLock, takeLock, type OLock } from './orchestrate/lock.js';
import { longDuration } from './orchestrate/guard.js';
import { Plan, RafError } from './plan.js';
import { tryGit } from './git.js';
import { sharedStateDir } from './state.js';

/** Nom de « vague » sous lequel la tâche locale d'un lot tient le verrou du dépôt : les refus des vagues le citent tel quel. */
export const localWave = (lot: string): string => `local:${lot}`;

/** Le lot d'un verrou de tâche locale (`local:<lot>`), null pour le verrou d'une vague. */
export const localLotOf = (wave: string): string | null => (wave.startsWith('local:') ? wave.slice('local:'.length) : null);

/** Durée annoncée (minutes) d'une tâche locale sans `--ttl` : celle de `lead hold` — de quoi finir une retouche, pas de quoi oublier le dépôt verrouillé toute la journée. */
export const LOCAL_TTL_MINUTES = 60;

export interface LocalDeps {
  /** Le processus qui pose le verrou, cité dans les messages ; il ne le porte PAS : le verrou d'une tâche locale est déclaré, il tient jusqu'à `local done` ou `local abort`. */
  pid: number;
  today: Day;
  now: () => Date;
  /** Échéance annoncée de la tâche (minutes, `--ttl`) ; passée, le verrou tient toujours et se signale en ⚠. */
  ttlMinutes?: number;
  /** La porte du projet (`orchestrate.build` puis `orchestrate.test`) au HEAD : 0 vert, 1 rouge, 2 rien à rejouer. */
  gate: () => Promise<number>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const lockFile = (repo: string): string => join(sharedStateDir(repo), REPO_LOCK);

/** Le refus qu'un verrou tenu oppose à une tâche locale ou à une vague : une tâche locale est nommée comme telle, avec sa sortie. */
export function heldRefusal(repo: string, held: OLock): string {
  const local = localLotOf(held.wave);
  if (local) return `${repoName(repo)} : une tâche locale du lead y est en cours (${local}, depuis ${held.started}) — la finir (cadence local done ${local}) ou l'abandonner (cadence local abort ${local})`;
  return `${repoName(repo)} : une orchestration y est déjà en cours (${held.wave}, pid ${held.pid})`;
}

/**
 * `cadence local start <lot>` : le lead va modifier lui-même ce dépôt pour un lot marqué `local`. Le dépôt est verrouillé comme par une vague (aucune vague n'y démarre,
 * `--add` y est refusé par le même contrôle de dépôt) et le lot passe à `doing`. Le verrou est DÉCLARÉ (`until`) : le shell qui lance la commande meurt à la fin de l'appel de l'outil
 * Bash et la session du lead (Claude desktop) n'a pas de nom de processus stable — aucun processus ne le porte, il tient jusqu'à `local done` ou `local abort`, et au TTL échu il se
 * signale (⚠) au lieu de tomber. Refus (`RafError`, rien n'est verrouillé ni écrit ; si l'écriture du plan échoue, le verrou pris est relâché) : lot inconnu, non marqué local, déjà
 * fini, une orchestration ou une autre tâche locale qui tient le dépôt, un autre lot du dépôt en cours.
 */
export function startLocal(repo: string, plan: Plan, lotId: string, d: Pick<LocalDeps, 'pid' | 'today' | 'now' | 'ttlMinutes'>): void {
  const lot = plan.lots().find((l) => l.id === lotId);
  if (!lot) throw new RafError(`lot inconnu : ${lotId}`);
  if (!lot.local) throw new RafError(`${lotId} n'est pas marqué local : le lead ne modifie pas lui-même le dépôt pour un lot de vague (raf add --local pour en créer un)`);
  if (lot.status === 'done' || lot.status === 'dropped') throw new RafError(`${lotId} est ${lot.status} : une tâche locale ne reprend pas un lot fini`);
  const held = activeLock(lockFile(repo));
  if (held) throw new RafError(held.wave === localWave(lotId) ? `${lotId} : la tâche locale est déjà en cours (depuis ${held.started}) — cadence local done ${lotId} à sa fin` : `${heldRefusal(repo, held)} — attendre sa fin`);
  const others = plan.lots().filter((l) => l.status === 'doing' && l.id !== lotId);
  if (others.length) throw new RafError(`${repoName(repo)} : un lot du dépôt est en cours (${others.map((l) => l.id).join(', ')}) — le finir, ou raf todo, avant la tâche locale`);
  const now = d.now();
  const until = new Date(now.getTime() + (d.ttlMinutes ?? LOCAL_TTL_MINUTES) * 60_000).toISOString();
  const taken = takeLock(lockFile(repo), { pid: d.pid, wave: localWave(lotId), started: now.toISOString(), until });
  if (!taken.ok) throw new RafError(`${heldRefusal(repo, taken.held)} — attendre sa fin`);
  if (lot.status === 'todo') {
    try {
      plan.setStatus(lotId, 'doing', d.today);
      plan.save();
    } catch (e) {
      releaseLock(lockFile(repo), d.pid);
      throw e;
    }
  }
}

/** Le verrou de la tâche locale de `lotId` s'il tient le dépôt ; `RafError` sinon (dépôt libre, vague, ou tâche d'un autre lot). */
function localHeld(repo: string, lotId: string): OLock {
  const held = activeLock(lockFile(repo));
  if (!held || held.wave !== localWave(lotId)) throw new RafError(`aucune tâche locale en cours pour ${lotId} (cadence local start ${lotId})`);
  return held;
}

/**
 * `cadence local done <lot>` : la tâche locale du lead est finie. La porte du projet est jouée UNE fois ; verte, le verrou tombe (la capture, la revue du diff par le lead,
 * la livraison et `raf done` restent au lead, dans cet ordre) ; rouge ou sans verdict, le verrou reste : le lead corrige et rejoue. Refus (`RafError`) quand ce n'est pas la tâche locale de ce lot qui tient le dépôt.
 */
export async function finishLocal(repo: string, lotId: string, d: LocalDeps): Promise<number> {
  const held = localHeld(repo, lotId);
  const code = await d.gate();
  if (code === 1) {
    d.err(`${lotId} : porte rouge — le dépôt reste verrouillé ; corriger, puis cadence local done ${lotId}`);
    return 1;
  }
  if (code !== 0) {
    d.err(`${lotId} : la porte n'a rien rejoué (orchestrate.build / orchestrate.test absents ?) — le dépôt reste verrouillé`);
    return 2;
  }
  releaseLock(lockFile(repo), held.pid);
  d.out(`${lotId} : porte verte, dépôt libéré. Suite : la capture d'un lot visible, relire le diff du lot et poser son verdict (raf review ${lotId} "…" — raf done le demande), cadence deliver, puis raf done ${lotId}`);
  return 0;
}

/** `cadence local abort <lot>` : lève le verrou de la tâche locale sans jouer la porte ; le plan n'est pas touché (le lot reste `doing` : `raf todo <lot>` pour l'abandonner). */
export function abortLocal(repo: string, lotId: string, out: (line: string) => void = () => {}): void {
  const held = localHeld(repo, lotId);
  releaseLock(lockFile(repo), held.pid);
  out(`${lotId} : tâche locale abandonnée, dépôt libéré sans porte ; le lot reste doing (raf todo ${lotId} pour le remettre à todo)`);
}

/**
 * Une ligne ⚠ par dépôt dont une tâche locale a dépassé son TTL à `now` (lead tour, orchestrate --status) : le verrou tient toujours, le lead le finit ou l'abandonne. Vide sans tâche échue.
 * Un dépôt illisible est sauté.
 */
export function localOverdueLines(repos: string[], now: Date): string[] {
  const lines: string[] = [];
  for (const repo of new Set(repos)) {
    let held: OLock | null;
    try {
      held = activeLock(lockFile(repo));
    } catch {
      continue;
    }
    const lot = held && localLotOf(held.wave);
    if (!held || !lot || !lockOverdue(held, now)) continue;
    const since = Date.parse(held.started);
    const age = Number.isFinite(since) ? `démarrée depuis ${longDuration(now.getTime() - since)}, ` : '';
    lines.push(`⚠ tâche locale échue : ${lot} (${basename(repo)} · ${age}échue depuis ${longDuration(now.getTime() - Date.parse(held.until!))}) — le dépôt reste verrouillé : la finir (cadence local done ${lot}) ou l'abandonner (cadence local abort ${lot})`);
  }
  return lines;
}

/** Ce que le tableau du lead dit du dépôt : « tâche locale L1 », avec « (échue) » au TTL passé ; null sans tâche locale. */
export function localRepoNote(repo: string, now: Date): string | null {
  const held = activeLock(lockFile(repo));
  const lot = held && localLotOf(held.wave);
  if (!held || !lot) return null;
  return `tâche locale ${lot}${lockOverdue(held, now) ? ' (échue)' : ''}`;
}

const repoName = (repo: string): string => repo.split('/').filter(Boolean).pop() ?? repo;

/** `cadence local start|done|abort <lot> [--ttl minutes]` : l'analyse de la commande, puis `startLocal`, `finishLocal` ou `abortLocal` ; `gate(sha)` joue la porte du projet au sha. */
export async function localCommand(rest: string[], ttl: string | undefined, c: { repo: string; loadPlan: () => Plan; gate: (sha: string) => Promise<number> } & Omit<LocalDeps, 'pid' | 'gate' | 'ttlMinutes'>): Promise<number> {
  const usage = 'usage : cadence local start <lot> [--ttl minutes] | cadence local done <lot> | cadence local abort <lot>';
  if (rest.length !== 2 || (rest[0] !== 'start' && rest[0] !== 'done' && rest[0] !== 'abort')) throw new RafError(usage);
  const [sub, lot] = rest as ['start' | 'done' | 'abort', string];
  if (ttl !== undefined && sub !== 'start') throw new RafError(`--ttl ne va qu'avec local start (${usage})`);
  const minutes = ttl === undefined ? undefined : Number(ttl);
  if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 1)) throw new RafError(`--ttl invalide : ${ttl} (un nombre entier de minutes ≥ 1)`);
  const deps: LocalDeps = { ...c, pid: process.pid, ttlMinutes: minutes, gate: () => c.gate(tryGit(c.repo, ['rev-parse', 'HEAD']) ?? 'HEAD') };
  if (sub === 'done') return finishLocal(c.repo, lot, deps);
  if (sub === 'abort') {
    abortLocal(c.repo, lot, c.out);
    return 0;
  }
  startLocal(c.repo, c.loadPlan(), lot, deps);
  c.out(`${lot} : dépôt verrouillé (tâche locale, ${minutes ?? LOCAL_TTL_MINUTES} min annoncées) — aucune vague n'y démarre, le verrou tient jusqu'à cadence local done ${lot} (ou local abort ${lot}) ; au-delà du délai il se signale en ⚠`);
  return 0;
}
