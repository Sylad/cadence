import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStart } from '../proc.js';
import { holderAlive } from './lock.js';
import { lotKey, type LotState } from './state.js';
import { priorityRank, readPriority } from './continue.js';

const waitersDir = (home: string) => join(home, 'waiters');

/** Une session qui attend un créneau (L531) : l'ordre dans lequel les attentes de toutes les vagues se servent. */
interface Waiter {
  pid: number;
  start?: string;
  wave: string;
  /** Heure d'inscription (ms) puis numéro d'ordre dans le processus : départage deux attentes de même rang. */
  since: number;
  seq: number;
  /** Premier pas d'un lot tout juste tiré (vrai) ou étape suivante d'un lot déjà en cours (faux : passe avant). */
  fresh: boolean;
  /** Rang du projet dans `priority:` (0 = le plus haut) ; plus grand = plus tard. */
  rank: number;
}

let waiterSeq = 0;

/** Les attentes vivantes, toutes vagues confondues, de la première servie à la dernière : étape en cours avant nouveau tirage, puis rang de priorité, puis ancienneté. */
function liveWaiters(home: string): Array<Waiter & { file: string }> {
  let names: string[];
  try {
    names = readdirSync(waitersDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Array<Waiter & { file: string }> = [];
  for (const n of names) {
    const file = join(waitersDir(home), n);
    try {
      const r = JSON.parse(readFileSync(file, 'utf8'));
      const w = {
        pid: Number(r.pid),
        start: r.start === undefined ? undefined : String(r.start),
        wave: String(r.wave),
        since: Number(r.since),
        seq: Number(r.seq),
        fresh: !!r.fresh,
        rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : Number.MAX_SAFE_INTEGER,
        file,
      };
      if (holderAlive(w.pid, w.start)) out.push(w);
      else rmSync(file, { force: true }); // le processus est mort sans désinscrire son attente
    } catch {
      // inscription illisible (en cours d'écriture) : ignorée à ce tour
    }
  }
  return out.sort((a, b) => Number(a.fresh) - Number(b.fresh) || a.rank - b.rank || a.since - b.since || a.pid - b.pid || a.seq - b.seq);
}

/** Inscrit une attente de créneau le temps de `run`, qui reçoit la question « est-ce mon tour ? » ; désinscrite à la fin, obtenue ou abandonnée (L531). */
export async function whileWaiting<T>(home: string, o: { wave: string; fresh?: boolean; rank?: number }, run: (myTurn: () => boolean) => Promise<T>): Promise<T> {
  const me: Waiter = {
    pid: process.pid,
    start: processStart(process.pid) ?? undefined,
    wave: o.wave,
    since: Date.now(),
    seq: waiterSeq++,
    fresh: o.fresh ?? false,
    rank: o.rank ?? Number.MAX_SAFE_INTEGER,
  };
  const file = join(waitersDir(home), `${me.pid}-${me.seq}.json`);
  mkdirSync(waitersDir(home), { recursive: true });
  writeFileSync(file, JSON.stringify(me));
  try {
    return await run(() => liveWaiters(home)[0]?.file === file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Un créneau est à prendre quand le total est sous le plafond et qu'aucune attente vivante ne passe avant la nôtre. */
export const hasRoom = (taken: () => number, limit: number, myTurn: () => boolean): boolean => taken() < limit && myTurn();

/**
 * La place dans la file des créneaux de la session que le lot `key` (`projet:lot`) lance : un lot qui n'a qu'un pas (celui qui part, déjà inscrit) n'a rien joué (`fresh`) ;
 * le rang est celui de son projet dans `priority:` (`--priority`, sinon le cadence.yaml du dossier de lancement ; illisible : rang neutre). Lot inconnu : place neutre.
 */
export function slotPlace(all: LotState[], launch: string, given: string[] | undefined, key?: string): { fresh?: boolean; rank?: number } {
  const l = key ? all.find((x) => lotKey(x.project, x.lot) === key) : undefined;
  if (!l) return {};
  const fresh = l.steps.length <= 1;
  try {
    return { fresh, rank: priorityRank(l.project, given ?? readPriority(launch)) };
  } catch {
    return { fresh }; // priority: illisible : rang neutre (après tous les déclarés), le lancement n'en dépend pas
  }
}
