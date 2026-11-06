import { relative } from 'node:path';
import { gitRoot } from '../git.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import { fillRoom, fillStop, queueVerdict, type FillFacts, type FillPlan } from './continue.js';
import type { LotCtx } from './cycle.js';
import { measuredBudgetsAt } from './budget-mesure.js';
import { effectiveState, QueueError, QueueSession, SkipLog, type Queued, type QueueEntry } from './queue.js';
import { cadenceHome, freeSlots, liveHolds, liveWaves, type LiveWave } from './registry.js';
import { lotFinished, lotKey, type LotState, type RunStore, type WaveState } from './state.js';

/**
 * La file approuvée au service d'une vague (L498) : ce que la vague en tire, le journal qu'elle en tient et la réservation des lots (R7).
 * Toute vague vivante tire de la file avant le plan (R19), un lot par créneau libéré (R20) ; le tirage lui-même est dans `draw.ts` (premier tour,
 * entre deux tours) et dans `queueFill` (un créneau libéré en cours de vague, par le remplissage de L587).
 */

export const QUEUE_DOWN = "file : illisible ou verrouillée, rien n'est tiré à ce créneau";

/** Ligne du journal de la file ; `skip` : le lot sauté et sa cause, pour n'écrire qu'une fois par cause (R6) ; `warn` : avertissement (sortie d'erreur). */
export interface QueueNote {
  line: string;
  warn?: boolean;
  skip?: { key: string; cause: string };
}

export const skipNote = (key: string, cause: string): QueueNote => ({ line: `file : lot sauté — ${key} : ${cause}`, skip: { key, cause } });

export type Say = (line: string, warn?: boolean) => void;

/** Une ligne sur la sortie (d'erreur pour un avertissement) et, la vague existant, dans son journal. */
export const sayTo = (io: OrchestrateIo, store?: RunStore): Say => (line, warn) => {
  (warn ? io.err : io.out)(line);
  store?.journal(line);
};

const runs = new WeakMap<WaveState, QueueRun>();

/** Ce que la file a de propre à une vague : sa réservation, son journal (une ligne par cause), les lignes à écrire et les lots du premier tirage qu'elle a choisis (clé du lot → sa place). */
export class QueueRun {
  wave = '';
  readonly session: QueueSession;
  readonly log = new SkipLog();
  readonly notes: QueueNote[] = [];
  readonly queued = new Map<string, Queued>();
  /** Les poussées par `--add` refusées (clé de la file → vague receveuse) : pas rejouées tant que la même vague tient le dépôt (une poussée relit le contrôle préalable). */
  readonly pushRefused = new Map<string, string>();

  constructor(
    readonly launch: string,
    deps: OrchestrateDeps,
  ) {
    this.session = new QueueSession(cadenceHome(), launch, () => this.wave, deps.queueLockMs);
  }

  /** La file de la vague `wave`, la même d'un tour à l'autre (le journal ne redit pas une cause) ; créée au premier appel. */
  static of(wave: WaveState, launch: string, deps: OrchestrateDeps): QueueRun {
    let q = runs.get(wave);
    if (!q) {
      q = new QueueRun(launch, deps);
      q.wave = wave.id;
      runs.set(wave, q);
    }
    return q;
  }

  /** La vague existe : ses tirages suivants (`QueueRun.of`) retrouvent cette file. */
  bind(wave: WaveState): void {
    this.wave = wave.id;
    runs.set(wave, this);
  }

  note(n: QueueNote): void {
    this.notes.push(n);
  }

  /** Écrit les lignes en attente, en sautant un « lot sauté » dont la cause n'a pas changé depuis la dernière fois dans cette vague (R6). */
  emit(say: Say): void {
    for (const n of this.notes.splice(0)) if (!n.skip || this.log.changed(n.skip.key, n.skip.cause)) say(n.line, n.warn);
  }

  /** Les lots en attente de ce dossier (une réservation orpheline en est un, R14), avec leur position dans la file ; lève `QueueError` (R16). */
  pending(): { entry: QueueEntry; position: number }[] {
    return this.session.list().map((entry, i) => ({ entry, position: i + 1 })).filter((x) => effectiveState(x.entry) === 'pending');
  }

  /** Des lots attendent dans la file (ou elle est illisible : le tirage le dira). */
  mayDraw(): boolean {
    try {
      return this.pending().length > 0;
    } catch {
      return true;
    }
  }

  /** Réserve l'entrée (R7) : « ok » quand le lot est à cette vague (une réservation orpheline reprise est dite, R14) ; « taken » quand une autre vague l'a pris ; « down » quand la file est illisible ou verrouillée (dit, R16). */
  claim(entry: string): 'ok' | 'taken' | 'down' {
    try {
      const r = this.session.reserve(entry);
      if (r === 'taken') return 'taken';
      if (r !== 'ok') this.note({ line: `file : réservation orpheline reprise — ${entry} (vague ${r.orphan})`, warn: true });
      return 'ok';
    } catch (e) {
      if (!(e instanceof QueueError)) throw e;
      this.note({ line: QUEUE_DOWN, warn: true });
      return 'down';
    }
  }

  /** Ce que le remplissage d'un créneau libre (`AddFeed.fill`) demande à la file pour un lot qu'il tire : le réserver avant de le prendre, le dire tiré une fois admis, le rendre si la prise est refusée, dire pourquoi il le saute (une fois par cause, R6). */
  hooks(log: (line: string) => void): QueueHooks {
    const safely = (what: string, entry: string, write: () => void): void => {
      try {
        write();
      } catch (e) {
        if (!(e instanceof QueueError)) throw e;
        log(`file : ${entry} : état « ${what} » non écrit (${e.message})`);
      }
    };
    return {
      claim: (entry) => this.claim(entry) === 'ok',
      drawn: (entry) => safely('tiré', entry, () => this.session.drawn(entry)),
      release: (entry) => safely('en attente', entry, () => this.session.release(entry)),
      skip: (entry, cause) => this.note(skipNote(entry, cause)),
    };
  }
}

/** Les gestes de la file qu'un remplissage de créneau fait pour un lot tiré d'elle (voir `QueueRun.hooks`). */
export interface QueueHooks {
  claim: (entry: string) => boolean;
  drawn: (entry: string) => void;
  release: (entry: string) => void;
  skip: (entry: string, cause: string) => void;
}

/**
 * Lance les sessions d'un tour dont `queued` nomme les lots tirés de la file : ils passent à « tiré » avec l'id de la vague (R13) et le journal dit « file : tire <projet:lot> (position n) »,
 * avant que la session ne parte. Un lancement refusé (code 2) ou qui lève les rend à la file, en attente : sans cela un lot resterait « tiré » par une vague qui n'a rien joué, et `drop` le refuserait (R7).
 */
export async function launchWithQueue(q: QueueRun, queued: Map<string, Queued>, say: Say, run: () => Promise<number>): Promise<number> {
  for (const from of queued.values()) {
    q.session.drawn(from.entry);
    say(`file : tire ${from.entry} (position ${from.position})`);
  }
  const give = () => {
    try {
      q.session.undraw([...queued.values()].map((x) => x.entry));
    } catch {
      // file illisible ou verrouillée : le lot reste « tiré », le lead le reprend à la main (queue drop, puis add)
    }
  };
  let code: number;
  try {
    code = await run();
  } catch (e) {
    give();
    throw e;
  }
  if (code === 2) give();
  return code;
}

/** La poussée d'un lot de la file dans la vague vivante qui tient son dépôt (R9) : le mécanisme de `--add` (L421), joué par l'appelant ; `refusals` dit pourquoi quand elle est refusée. */
export type PushToWave = (target: { project: string; lot: string }, holder: LiveWave) => Promise<{ ok: boolean; refusals: string[] }>;

/** Pousse le lot dans la vague `holder` par `--add` : réservé d'abord (R7), « tiré par la vague <holder> » une fois la poussée acceptée (R13), rendu à la file et dit si elle est refusée. */
async function pushTo(q: QueueRun, from: Queued, lot: { dir: string; id: string }, holder: LiveWave, push: PushToWave): Promise<boolean> {
  if (q.pushRefused.get(from.entry) === holder.wave) return false; // déjà refusée par cette vague : dite, pas rejouée
  if (q.claim(from.entry) !== 'ok') return false;
  const r = await push({ project: relative(holder.cwd, lot.dir) || '.', lot: lot.id }, holder);
  if (r.ok) {
    q.session.drawnBy(from.entry, holder.wave);
    q.note({ line: `file : tire ${from.entry} (position ${from.position}) — poussé par --add dans la vague ${holder.wave}` });
    return true;
  }
  q.session.release(from.entry);
  q.pushRefused.set(from.entry, holder.wave);
  const cause = `--add refusé : ${r.refusals.join(' ; ')}`;
  q.note({ line: `file : --add refusé — ${from.entry} : ${r.refusals.join(' ; ')}`, skip: { key: from.entry, cause } });
  return false;
}

/** Ce que le remplissage d'un créneau libéré a besoin de savoir de la vague, en plus des faits du remplissage du plan (`FillFacts`). */
export interface QueueFillFacts extends Omit<FillFacts, 'exclude'> {
  /** Plafond de sessions de la vague (R8 : les créneaux que prennent les autres vagues et les sessions du lead ne sont pas libres). */
  cap: number;
}

/** Les gestes que le remplissage par la file emprunte à la vague : prendre des lots comme `AddFeed.fill`, savoir si un lot peut jouer, pousser un lot dans une autre vague par `--add`. */
export interface QueueFillGestures {
  fill: (plan: FillPlan, lanes: number, canRun: (c: LotCtx) => boolean) => Promise<LotCtx[]>;
  canRun: (c: LotCtx) => boolean;
  push: PushToWave;
}

/** Ce qu'un remplissage par la file rend : les lots pris, les clés des lots qui attendent dans la file (le plan ne les tire pas, R19) et si la file était illisible (le plan n'est pas tiré à ce créneau, R16). */
export interface QueueFilled {
  added: LotCtx[];
  waiting: Set<string>;
  down: boolean;
}

/** Ce qu'un parcours de la file accumule : les lots mûrs à prendre, ceux qui attendent, les sautés et les poussés. */
interface Scan {
  remaining: number;
  held: LotState[];
  measured: ReturnType<typeof measuredBudgetsAt>;
  others: LiveWave[];
  inWave: Set<string>;
  waiting: Set<string>;
  targets: FillPlan['targets'];
  skipped: number;
  pushed: number;
}

/** Juge un lot en attente de la file (R5, R12, R15) : sauté et dit, poussé par `--add` dans la vague vivante qui tient son dépôt (R9), ou retenu pour le remplissage. */
async function scanEntry(q: QueueRun, f: QueueFillFacts, p: { entry: QueueEntry; position: number }, s: Scan, push: PushToWave): Promise<void> {
  const skip = (cause: string): void => {
    q.note(skipNote(p.entry.key, cause));
    s.skipped++;
  };
  const v = queueVerdict(p.entry.key, f.launch, { home: f.home, remaining: s.remaining, held: s.held, measured: s.measured });
  if ('cause' in v) return skip(v.cause);
  const { project, dir, lot } = v.candidate;
  const key = lotKey(project, lot.id);
  s.waiting.add(key);
  if (s.inWave.has(key)) return;
  const repo = gitRoot(dir);
  if (!repo) return skip('introuvable');
  const holder = s.others.find((w) => w.repos.includes(repo));
  if (holder) {
    if (await pushTo(q, { entry: p.entry.key, position: p.position }, { dir, id: lot.id }, holder, push)) s.pushed++;
    else s.skipped++;
    return;
  }
  s.targets.push({ project, projectDir: dir, repo, lot: lot.id, model: 'sonnet', uses: lot.uses ?? [], queued: { entry: p.entry.key, position: p.position } });
}

/**
 * Un créneau libéré en cours de vague (L587, `AddFeed.fill`) : la file approuvée passe avant le plan (R19). Dans l'ordre de la file, chaque lot en attente est jugé (`scanEntry`) ;
 * un lot dont le dépôt est tenu par une autre vague vivante lui est poussé par `--add` (R9) ; les autres lots mûrs sont pris par le remplissage comme des lots du plan, au plus un par créneau libre (R20),
 * les créneaux des autres vagues et les sessions du lead déduits (R8), réservés avant d'être pris (R7). Les lignes du journal sont laissées à `q.emit`.
 */
export async function queueFill(q: QueueRun, f: QueueFillFacts, vacant: number, g: QueueFillGestures): Promise<QueueFilled> {
  const none: QueueFilled = { added: [], waiting: new Set(), down: false };
  const remaining = fillRoom(f);
  if (vacant <= 0 || fillStop(f, remaining)) return none;
  let pending: ReturnType<QueueRun['pending']>;
  try {
    pending = q.pending();
  } catch (e) {
    if (!(e instanceof QueueError)) throw e;
    q.note({ line: QUEUE_DOWN, warn: true });
    return { ...none, down: true };
  }
  const slots = Math.min(vacant, freeSlots(liveWaves(f.home), f.cap, liveHolds(f.home, f.io.now()).length));
  if (!pending.length || slots <= 0) return none;
  const s: Scan = { remaining, held: f.all.filter((l) => !lotFinished(l)), measured: measuredBudgetsAt(f.launch, f.io), others: liveWaves(f.home).filter((w) => w.pid !== process.pid), inWave: new Set(f.all.map((l) => lotKey(l.project, l.lot))), waiting: new Set(), targets: [], skipped: 0, pushed: 0 };
  for (const p of pending) await scanEntry(q, f, p, s, g.push);
  const added = s.targets.length ? await g.fill({ targets: s.targets, room: remaining }, slots, g.canRun) : [];
  if (!added.length && !s.pushed) q.note({ line: `file : aucun lot mûr (${s.skipped} sauté(s))`, skip: { key: '', cause: `aucun lot mûr (${s.skipped})` } });
  return { added, waiting: s.waiting, down: false };
}
