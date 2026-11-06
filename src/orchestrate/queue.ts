import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStart } from '../proc.js';
import { holderAlive } from './lock.js';

/**
 * La file des lots approuvés (L498) : `queue.json` dans l'état commun aux vagues (`cadenceHome`, à côté de `waves/` et `slots/`).
 * Une liste ordonnée de lots, chacun « en attente », « réservé » par la vague qui est en train de le tirer, ou « tiré » (il reste en file, avec l'id de la vague).
 * Écrite par renommage atomique sous un verrou (`queue.json.lock`) ; ni commit ni écriture dans un plan.
 */
export type QueueState = 'pending' | 'reserved' | 'drawn';

export interface QueueEntry {
  /** `projet:lot`, le projet tel que donné depuis le dossier de lancement. */
  key: string;
  /** Dossier de lancement des vagues qui tirent ce lot : les clés se lisent depuis lui. */
  dir: string;
  state: QueueState;
  /** Vague qui a réservé ou reçu le lot. */
  wave?: string;
  /** Réservation : pid (et heure de démarrage) de la vague, de quoi savoir si elle vit encore. */
  pid?: number;
  start?: string;
}

/** Un lot tiré de la file : sa clé dans la file (`.:L1` depuis un projet — le lot de la vague porte, lui, le nom de son dossier, `a:L1`) et sa position. */
export interface Queued {
  entry: string;
  position: number;
}

/** `unreadable` : JSON invalide ; `locked` : verrou d'écriture tenu au-delà du délai. */
export class QueueError extends Error {
  constructor(readonly kind: 'unreadable' | 'locked', message: string) {
    super(message);
  }
}

/** Délai d'attente du verrou d'écriture (R16). */
export const QUEUE_LOCK_MS = 10_000;

export const queuePath = (home: string): string => join(home, 'queue.json');

/** Une réservation dont la vague ne vit plus (processus mort, ou pid repris par un autre) : lue comme « en attente » (R14). */
export const orphaned = (e: QueueEntry): boolean => e.state === 'reserved' && !(e.pid !== undefined && holderAlive(e.pid, e.start));

/** L'état tel que le tirage et `show` le lisent : une réservation orpheline est « en attente ». */
export const effectiveState = (e: QueueEntry): QueueState => (orphaned(e) ? 'pending' : e.state);

/** La file ; absente, elle est vide ; illisible, elle n'est ni lue ni réécrite (R16). */
export function readQueue(home: string): QueueEntry[] {
  const file = queuePath(home);
  if (!existsSync(file)) return [];
  const unreadable = () => new QueueError('unreadable', `queue : file illisible (${file}) : corriger ou supprimer le fichier à la main`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw unreadable();
  }
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.some((e) => typeof e?.key !== 'string' || typeof e?.dir !== 'string' || !['pending', 'reserved', 'drawn'].includes(e?.state))) throw unreadable();
  return entries as QueueEntry[];
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Prend le verrou d'écriture : un porteur mort est écarté, un porteur vivant est attendu jusqu'à `waitMs`. */
function lock(home: string, waitMs: number): () => void {
  const file = `${queuePath(home)}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? undefined }), { flag: 'wx' });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder: { pid?: number; start?: string } | null = null;
    try {
      holder = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // verrou en cours d'écriture, ou illisible : attendu comme un porteur vivant
    }
    if (holder && typeof holder.pid === 'number' && !holderAlive(holder.pid, holder.start)) {
      rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new QueueError('locked', `queue : file verrouillée depuis plus de ${QUEUE_LOCK_MS / 1000} s : réessayer`);
    sleepMs(20);
  }
}

/** Lit la file sous verrou, la passe à `change` (qui la modifie en place et rend son résultat) et la réécrit atomiquement ; rien n'est écrit si `change` lève. */
export function updateQueue<T>(home: string, change: (entries: QueueEntry[]) => T, waitMs = QUEUE_LOCK_MS): T {
  mkdirSync(home, { recursive: true });
  const release = lock(home, waitMs);
  try {
    const entries = readQueue(home);
    const before = JSON.stringify(entries);
    const result = change(entries);
    if (JSON.stringify(entries) !== before) {
      const file = queuePath(home);
      writeFileSync(`${file}.tmp`, JSON.stringify({ entries }, null, 2));
      renameSync(`${file}.tmp`, file);
    }
    return result;
  } finally {
    release();
  }
}

const same = (e: QueueEntry, key: string, dir: string) => e.key === key && e.dir === dir;

/** Les lots de la file propres à ce dossier de lancement, dans l'ordre (leur rang dans cette liste est leur position). */
export const entriesOf = (entries: QueueEntry[], dir: string): QueueEntry[] => entries.filter((e) => e.dir === dir);

/**
 * Ce que la file fait pour UNE vague : réserver le lot qu'elle va tirer (atomique : une seule vague le prend, R7), le rendre à la file si le tirage échoue,
 * le passer à « tiré » une fois le lot dans la vague (R13). Elle ne touche que son propre dossier de lancement.
 */
export class QueueSession {
  /** Lots réservés par cette vague et pas encore passés à « tiré ». */
  private reserved = new Set<string>();

  constructor(
    readonly home: string,
    readonly dir: string,
    readonly wave: () => string,
    private readonly waitMs = QUEUE_LOCK_MS,
  ) {}

  /** Les lots de ce dossier, avec leur état lu comme le tirage le lit (voir `effectiveState`). */
  list(): QueueEntry[] {
    return entriesOf(readQueue(this.home), this.dir);
  }

  /** Réserve `key` : « ok » ; « orphan » (réservation d'une vague morte reprise, avec l'id de cette vague) ; « taken » quand une autre vague l'a pris ou que le lot n'est plus en file. */
  reserve(key: string): 'ok' | 'taken' | { orphan: string } {
    return updateQueue(
      this.home,
      (entries) => {
        const e = entries.find((x) => same(x, key, this.dir));
        if (!e) return 'taken' as const;
        const previous = e.wave;
        if (effectiveState(e) !== 'pending') return 'taken' as const;
        const wasOrphan = e.state === 'reserved';
        Object.assign(e, { state: 'reserved', wave: this.wave(), pid: process.pid, start: processStart(process.pid) ?? undefined });
        this.reserved.add(key);
        return wasOrphan ? { orphan: previous ?? '?' } : ('ok' as const);
      },
      this.waitMs,
    );
  }

  /** Rend la réservation à la file (en attente) ; sans effet si ce n'est plus la sienne. */
  release(key: string): void {
    this.reserved.delete(key);
    updateQueue(
      this.home,
      (entries) => {
        const e = entries.find((x) => same(x, key, this.dir));
        if (e?.state === 'reserved' && e.pid === process.pid) Object.assign(e, { state: 'pending', wave: undefined, pid: undefined, start: undefined });
      },
      this.waitMs,
    );
  }

  /** Le lot est dans la vague : « tiré par la vague <id> », il reste en file. */
  drawn(key: string): void {
    this.reserved.delete(key);
    updateQueue(
      this.home,
      (entries) => {
        const e = entries.find((x) => same(x, key, this.dir));
        if (e?.state === 'reserved' && e.pid === process.pid) Object.assign(e, { state: 'drawn', wave: this.wave(), pid: undefined, start: undefined });
      },
      this.waitMs,
    );
  }

  /** Le lot a été poussé par `--add` dans la vague vivante `wave` qui tient son dépôt (R9) : « tiré par la vague <wave> », il reste en file. */
  drawnBy(key: string, wave: string): void {
    this.reserved.delete(key);
    updateQueue(
      this.home,
      (entries) => {
        const e = entries.find((x) => same(x, key, this.dir));
        if (e?.state === 'reserved' && e.pid === process.pid) Object.assign(e, { state: 'drawn', wave, pid: undefined, start: undefined });
      },
      this.waitMs,
    );
  }

  /** Le lancement a été refusé après le « tiré » : ces lots, tirés par cette vague, redeviennent en attente. */
  undraw(keys: string[]): void {
    updateQueue(
      this.home,
      (entries) => {
        for (const e of entries) if (e.dir === this.dir && keys.includes(e.key) && e.state === 'drawn' && e.wave === this.wave()) Object.assign(e, { state: 'pending', wave: undefined });
      },
      this.waitMs,
    );
  }

  /** Rend à la file toutes les réservations de cette vague qui n'ont pas abouti (échec ou interruption entre la réservation et le « tiré »). */
  releaseAll(): void {
    for (const key of [...this.reserved]) {
      try {
        this.release(key);
      } catch {
        // file illisible ou verrouillée : la réservation orpheline sera reprise par `reserve` (R14)
      }
    }
  }
}

/**
 * Journal de la file pour une vague (R6) : une ligne « lot sauté » n'est écrite qu'une fois par cause tant que la cause du lot ne change pas ;
 * une cause qui change est écrite, et si l'ancienne revient elle l'est de nouveau.
 */
export class SkipLog {
  private last = new Map<string, string>();

  /** Vrai quand cette cause est nouvelle pour ce lot dans cette vague. */
  changed(key: string, cause: string): boolean {
    if (this.last.get(key) === cause) return false;
    this.last.set(key, cause);
    return true;
  }
}
