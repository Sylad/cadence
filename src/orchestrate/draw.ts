import { rmSync } from 'node:fs';
import { gitRoot } from '../git.js';
import { candidates, queueVerdict, readPriority, resolveQueueLot, type Candidate } from './continue.js';
import { lotKey, lotRepoPaths, type LotState, type RunStore } from './state.js';
import { measuredBudgetsAt } from './budget-mesure.js';
import { preflight } from './preflight.js';
import { QueueError, type Queued, type QueueEntry } from './queue.js';
import { QUEUE_DOWN, skipNote, type QueueRun } from './queue-draw.js';
import { cadenceHome, freeSlots, liveHolds, liveWaves, type LiveWave } from './registry.js';
import { maxSessions } from './status.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';

export const priorityOf = (args: Args, launch: string) => args.priority ?? readPriority(launch);

/** Ce qu'un tirage a besoin de savoir de la vague qui tire. */
export interface DrawCtx {
  args: Args;
  io: OrchestrateIo;
  deps: OrchestrateDeps;
  launch: string;
}

/** La file approuvée au service d'un tirage (L498). Sans `reserve` (premier tirage : la vague n'existe pas encore, ou simulation) les lots sont choisis, l'appelant les réserve ensuite (`claimFirstDraw`). `cap` : plafond de sessions de la vague. */
export interface QueueDraw {
  run: QueueRun;
  reserve: boolean;
  cap: number;
}

export interface Drawn {
  lots: LotState[];
  skipped: string[];
  /** Lots tirés de la file (L498) : clé du lot → sa place dans la file. */
  queued: Map<string, Queued>;
}

type Pre = Awaited<ReturnType<typeof preflight>>;

/** Un lot que le tour a renvoyé au second passage (son dépôt est déjà pris) ; `from` : sa place dans la file approuvée, absente pour un lot du plan. */
interface Deferred {
  c: Candidate;
  repo: string;
  pre?: Pre;
  from?: Queued;
}

/**
 * Un tirage : jusqu'à `n` lots prêts, la file approuvée d'abord (L498, R19) puis, avec `--continue`, le plan (L147), dans l'ordre de priorité ; chacun passé au contrôle préalable comme un lot donné.
 * Un lot refusé est sauté, sa cause rendue dans `skipped` (ou, pour un lot de la file, dans les lignes de la file). `exclude` reçoit chaque lot tiré ou refusé pour lui-même, pas ceux d'un
 * dépôt refusé ni un lot qui ne tient pas dans le reste du budget (il tiendra peut-être au tour suivant).
 * Un tour tire au plus UN lot par dépôt (le pool joue à la suite les lots d'un même dépôt, `--max-sessions` ne servirait à rien) ;
 * les lots écartés pour cela complètent le tour, dans l'ordre, quand aucun autre dépôt n'a de lot prêt.
 */
class Tirage {
  private readonly lots: LotState[] = [];
  private readonly skipped: string[] = [];
  private readonly queued = new Map<string, Queued>();
  /** Clés (nom du dossier) des lots qui attendent dans la file : le plan ne les tire pas, ils attendent leur créneau (R19). */
  private readonly waiting = new Set<string>();
  /** La file est illisible ou verrouillée : rien n'est tiré à ce créneau, ni d'elle ni du plan (R16, R19). */
  private down = false;
  private readonly badRepos = new Set<string>();
  private readonly used = new Set<string>();
  private readonly deferred: Deferred[] = [];
  /** Créneaux libres pour la file à ce tour (R20) ; les lots de la file renvoyés au second passage ne le dépassent pas. */
  private queueRoom = Infinity;

  constructor(
    private readonly x: DrawCtx,
    private readonly exclude: Set<string>,
    private remaining: number,
    private readonly n: number,
    private readonly queue?: QueueDraw,
  ) {}

  async run(): Promise<Drawn> {
    if (this.queue) await this.fromQueue(this.queue);
    await this.complete((d) => d.from !== undefined); // les lots de la file renvoyés passent avant le plan (R19)
    if (this.x.args.continue && !this.down) await this.fromPlan();
    await this.complete((d) => d.from === undefined);
    return { lots: this.lots, skipped: this.skipped, queued: this.queued };
  }

  /** Second passage : les lots renvoyés (`which`) complètent le tour, sans dépasser les créneaux libres de la file ; un lot déjà tiré ou refusé entre-temps n'est pas rejoué (R7). */
  private async complete(which: (d: Deferred) => boolean): Promise<void> {
    for (const d of this.deferred.filter(which)) {
      if (this.lots.length >= this.n) break;
      if (d.from && this.queued.size >= this.queueRoom) continue;
      if (this.exclude.has(lotKey(d.c.project, d.c.lot.id))) continue;
      await this.attempt(d.c, d.repo, false, d.pre, d.from);
    }
  }

  private async fromPlan(): Promise<void> {
    const { args, io, launch } = this.x;
    const exclude = new Set([...this.exclude, ...this.waiting]);
    for (const c of candidates(launch, { priority: priorityOf(args, launch), exclude, remaining: this.remaining, measured: measuredBudgetsAt(launch, io) })) {
      if (this.lots.length >= this.n) break;
      const repo = gitRoot(c.dir);
      if (repo) await this.attempt(c, repo, true);
    }
  }

  /** `spread` : premier passage, un dépôt déjà pris ce tour renvoie le lot au second ; sinon (second passage) le lot complète le tour. */
  private async attempt(c: Candidate, repo: string, spread: boolean, checked?: Pre, from?: Queued): Promise<void> {
    const key = lotKey(c.project, c.lot.id);
    if (this.badRepos.has(repo)) return;
    if (spread && this.used.has(repo)) return void this.deferred.push({ c, repo, from });
    const { args, io, deps, launch } = this.x;
    const pre = checked ?? (await preflight(args, [{ project: c.project, projectDir: c.dir, repo, lot: c.lot.id, model: 'sonnet' }], io, deps, launch));
    if (pre.refusals.length) return this.refused(key, repo, pre.refusals, from);
    const lot = pre.lots[0];
    if (lot.budget! > this.remaining) return; // pas exclu : le budget du tour suivant le permettra peut-être
    if (spread && lotRepoPaths(lot).some((r) => this.used.has(r))) return void this.deferred.push({ c, repo, pre, from }); // un dépôt voisin déjà pris ce tour
    if (from && !this.claim(from.entry)) return;
    this.exclude.add(key);
    this.remaining -= lot.budget!;
    this.lots.push(lot);
    if (from) this.queued.set(key, from);
    for (const r of lotRepoPaths(lot)) this.used.add(r);
  }

  /**
   * Un refus propre au lot l'écarte pour la vague ; celui d'un dépôt (arbre sale, orchestration en cours, pre-push) est passager :
   * le dépôt est sauté pour ce tirage seulement, une ligne, et ses lots restent tirables au suivant. Un lot de la file dit sa cause dans le journal de la file (R10).
   */
  private refused(key: string, repo: string, refusals: string[], from?: Queued): void {
    const own = refusals.filter((r) => r.startsWith(`${key} : `));
    if (own.length) this.exclude.add(key);
    if (own.length < refusals.length) this.badRepos.add(repo);
    if (!from) this.skipped.push(...refusals.filter((r) => !this.skipped.includes(r)));
    else for (const r of refusals) this.queue!.run.note(skipNote(from.entry, r.startsWith(`${key} : `) ? r.slice(key.length + 3) : r));
  }

  /** Le lot de la file est à moi : réservé (sauf sans `reserve` : la vague n'existe pas encore, ou simulation). Faux quand une autre vague l'a pris, ou que la file est illisible ou verrouillée. */
  private claim(entry: string): boolean {
    if (!this.queue?.reserve) return true;
    const r = this.queue.run.claim(entry);
    if (r === 'down') this.down = true;
    return r === 'ok';
  }

  /** La file avant le plan (R19) : au plus un lot par créneau libre (R20) — les créneaux que prennent les autres vagues et les sessions du lead ne le sont pas (R8) — dans l'ordre de la file, le premier lot mûr (R5). */
  private async fromQueue(queue: QueueDraw): Promise<void> {
    let pending: ReturnType<QueueRun['pending']>;
    try {
      pending = queue.run.pending();
    } catch (e) {
      if (!(e instanceof QueueError)) throw e;
      queue.run.note({ line: QUEUE_DOWN, warn: true });
      this.down = true;
      return;
    }
    const home = cadenceHome();
    const room = Math.min(this.n, freeSlots(liveWaves(home), queue.cap, liveHolds(home, this.x.io.now()).length));
    this.queueRoom = room;
    const inVague = this.noteWaiting(pending.map((p) => p.entry));
    const todo = room > 0 ? pending.filter((p) => !inVague.has(p.entry.key)) : [];
    const others = liveWaves(home).filter((w) => w.pid !== process.pid);
    let skipped = 0;
    for (const p of todo) {
      if (this.lots.length >= room) break;
      if (!(await this.tryEntry(queue, p.entry, p.position, others))) skipped++;
    }
    if (todo.length && this.queued.size === 0) queue.run.note({ line: `file : aucun lot mûr (${skipped} sauté(s))`, skip: { key: '', cause: `aucun lot mûr (${skipped})` } });
  }

  /** Retient les lots en attente dans la file (le plan ne les tire pas) ; rend les clés de la file de ceux que la vague a déjà. */
  private noteWaiting(waiting: QueueEntry[]): Set<string> {
    const inVague = new Set<string>();
    for (const e of waiting) {
      const ref = resolveQueueLot(this.x.launch, e.key);
      if (!('lot' in ref)) continue;
      const key = lotKey(ref.project, ref.lot.id);
      this.waiting.add(key);
      if (this.exclude.has(key)) inVague.add(e.key);
    }
    return inVague;
  }

  /** Vrai quand le lot est tiré ou renvoyé au second passage ; faux quand il est sauté (sa cause est dans les lignes de la file). */
  private async tryEntry(queue: QueueDraw, e: QueueEntry, position: number, others: LiveWave[]): Promise<boolean> {
    const { launch, io } = this.x;
    const verdict = queueVerdict(e.key, launch, { home: cadenceHome(), remaining: this.remaining, held: this.lots, measured: measuredBudgetsAt(launch, io) });
    if ('cause' in verdict) return this.skipEntry(queue, e.key, verdict.cause);
    const repo = gitRoot(verdict.candidate.dir);
    if (!repo) return this.skipEntry(queue, e.key, 'introuvable');
    // Le lot irait dans une vague vivante qui tient son dépôt : c'est elle qui le tire à son prochain créneau libre, ou une vague vivante l'y pousse par --add (R9, `queueFill`) ; un tirage de tour n'écrit rien chez elle (R18).
    const holder = others.find((w) => w.repos.includes(repo));
    if (holder) return this.skipEntry(queue, e.key, `dépôt tenu par la vague ${holder.wave}`);
    const before = this.lots.length;
    await this.attempt(verdict.candidate, repo, true, undefined, { position, entry: e.key });
    return this.lots.length > before || this.deferred.some((d) => d.c === verdict.candidate);
  }

  private skipEntry(queue: QueueDraw, key: string, cause: string): false {
    queue.run.note(skipNote(key, cause));
    return false;
  }
}

export const draw = (x: DrawCtx, exclude: Set<string>, remaining: number, n: number, queue?: QueueDraw): Promise<Drawn> => new Tirage(x, exclude, remaining, n, queue).run();

/**
 * Le premier tour tiré : sans lot donné, `--continue` ou `--queue` le tire ; rien de prêt, ou tout refusé, vaut un refus avant d'agir : 2 pour `--queue` seul (les causes sont dites), sinon
 * les causes rejoignent `refusals`. Avec des lots donnés (déjà dans `into.pre.lots`) et `--queue`, les lots donnés passent avant et la file complète les créneaux restants (R11) ; le plan n'est pas tiré.
 * `into.pre.lots` reçoit les lots tirés, `q.queued` ceux de la file (réservés une fois la vague créée : `claimFirstDraw`).
 */
export async function firstDraw(x: DrawCtx, budget: number, into: { pre: { lots: LotState[] }; skipped: string[]; refusals: string[] }, q: QueueRun): Promise<number | undefined> {
  const given = into.pre.lots.length;
  const room = maxSessions(x.args, x.io) - given;
  if (room <= 0) return undefined;
  const spent = into.pre.lots.reduce((sum, l) => sum + (l.budget ?? 0), 0);
  const ctx = given ? { ...x, args: { ...x.args, continue: false } } : x;
  const first = await draw(ctx, new Set(into.pre.lots.map((l) => lotKey(l.project, l.lot))), budget - spent, room, { run: q, reserve: false, cap: room + given });
  into.pre.lots.push(...first.lots);
  into.skipped.push(...first.skipped);
  for (const [key, queued] of first.queued) q.queued.set(key, queued);
  if (first.lots.length || given) return undefined;
  q.emit((line) => x.io.err(line));
  if (!x.args.continue) {
    x.io.err('orchestrate --queue : aucun lot mûr dans la file approuvée');
    return 2;
  }
  into.refusals.push(...(first.skipped.length ? first.skipped : ["--continue : aucun lot prêt dont l'estimation tient dans le budget"]));
  return undefined;
}

/** La vague existe : réserve les lots que le premier tirage a pris dans la file ; ceux qu'une autre vague a pris entre-temps, ou que la file illisible ne permet pas de réserver, sortent de la vague (R7, R16). Faux (et rien n'est gardé de la vague) quand aucun lot ne reste à jouer. */
export function claimFirstDraw(pre: { lots: LotState[] }, q: QueueRun, store: RunStore, io: OrchestrateIo): boolean {
  if (!q.queued.size) return true;
  pre.lots = pre.lots.filter((l) => {
    const key = lotKey(l.project, l.lot);
    const from = q.queued.get(key);
    if (!from || q.claim(from.entry) === 'ok') return true;
    q.queued.delete(key);
    return false;
  });
  if (pre.lots.length) return true;
  rmSync(store.dir, { recursive: true, force: true });
  q.emit((line) => io.err(line));
  io.err('orchestrate --queue : aucun lot mûr dans la file approuvée');
  return false;
}
