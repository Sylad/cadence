import { existsSync, readFileSync, rmSync } from 'node:fs';
import { processStart } from './proc.js';
import { linkNewFile, pidAlive, readLockJson, removeStaleFile } from './state.js';

/** Attente maximale d'un verrou tenu par une autre session avant de refuser l'écriture (30 s, comme le verrou de l'étude M6). */
const WAIT_MS = 30_000;
const STEP_MS = 50;
/** Un fichier de verrou illisible plus jeune que ceci est une pose en cours ailleurs, pas un verrou périmé. */
const UNREADABLE_GRACE_MS = 5_000;

interface PlanLock {
  pid: number;
  started: string;
  /** Heure de démarrage du porteur : avec le pid, son identité (un pid se réutilise). */
  start?: string;
}

/** Un pid absent ou non entier (JSON valide mais pas un verrou) vaut 0 : jamais vivant, et égal à lui-même à la relecture (NaN ne l'est pas). */
const pidOf = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : 0);

const read = (file: string) =>
  readLockJson<PlanLock>(file, (raw) => ({ pid: pidOf(raw?.pid), started: String(raw.started), start: raw.start === undefined ? undefined : String(raw.start) }), { pid: 0, started: '?' });

function held(l: NonNullable<ReturnType<typeof read>>): boolean {
  if (l.unreadable) return l.ageMs < UNREADABLE_GRACE_MS;
  if (!pidAlive(l.pid)) return false;
  return !l.start || (processStart(l.pid) ?? l.start) === l.start;
}

/** L'attente voulue : `CADENCE_PLAN_LOCK_WAIT_MS` (entier ≥ 0, pour les tests et les CI lentes), sinon 30 s. */
function waitMs(): number {
  const v = process.env.CADENCE_PLAN_LOCK_WAIT_MS;
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : WAIT_MS;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Joue `fn` avec le verrou `file` (L468) : un fichier posé de façon atomique, porteur identifié par pid et heure de démarrage. Un verrou
 * tenu par un processus vivant fait attendre (jusqu'à `CADENCE_PLAN_LOCK_WAIT_MS`, 30 s par défaut) puis refuser ; un verrou dont le porteur est
 * mort (ou dont le pid a été repris) est écarté. Le verrou est rendu quoi qu'il arrive à `fn`.
 */
export function withPlanLock<T>(file: string, refuse: (message: string) => Error, fn: () => T): T {
  const lock: PlanLock = { pid: process.pid, started: new Date().toISOString(), start: processStart(process.pid) ?? undefined };
  const limit = Date.now() + waitMs();
  for (;;) {
    if (linkNewFile(file, JSON.stringify(lock), process.pid)) break;
    const seen = read(file);
    if (seen && !held(seen)) {
      removeStaleFile(file, (aside) => {
        const now = read(aside);
        return !!now && now.pid === seen.pid && now.started === seen.started && now.start === seen.start && !!now.unreadable === !!seen.unreadable;
      });
      continue;
    }
    if (Date.now() >= limit) {
      const who = seen && !seen.unreadable ? `pid ${seen.pid}, depuis ${seen.started}` : 'verrou en cours de pose';
      throw refuse(`plan tenu par une autre session (${who}) — écriture refusée après ${waitMs() / 1000} s, plan inchangé ; relancer quand elle a fini (ou retirer ${file} si plus aucun processus ne l'écrit)`);
    }
    pause(STEP_MS);
  }
  try {
    return fn();
  } finally {
    const mine = read(file);
    if (mine && mine.pid === process.pid && mine.started === lock.started) rmSync(file, { force: true });
  }
}

/**
 * Le plan sur le disque est-il encore celui que ce processus a lu ou écrit en dernier (`seen`) ? Rend son texte actuel ; sinon refuse (`refuse`) :
 * une autre session l'a changé depuis, l'écraser perdrait son changement.
 */
export function assertPlanUnchanged(path: string, seen: string, refuse: (message: string) => Error): string {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current !== seen) throw refuse(`plan modifié par une autre session depuis sa lecture (${path}) — écriture refusée, son changement est gardé ; relancer la commande pour repartir du plan à jour`);
  return current;
}
