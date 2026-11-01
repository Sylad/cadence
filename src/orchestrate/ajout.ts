import { basename, join, relative } from 'node:path';
import type { Args, OrchestrateDeps, OrchestrateIo, Target } from './command.js';
import type { LotCtx, WaveCtx } from './cycle.js';
import { lotFinished, lotKey, lotRepoPaths, type LotState, type RunStore, type WaveState } from './state.js';
import { cadenceHome, liveWaves } from './registry.js';
import { REPO_LOCK, takeLock } from './lock.js';
import { installPrePush } from './guard.js';
import { sharedStateDir } from '../state.js';
import { waveReadsAdds } from './snapshot.js';
import type { AnyModel } from './launch.js';

/** Une demande de la file d'ajouts (`adds.log`). */
export type AddEntry = { id: number; project?: string; lot: string; model?: string };

/** Un lot de la vague (ou déjà en file d'ajout) vu par le contrôle préalable d'un ajout. */
export type KnownLot = { project: string; lot: string; queued?: boolean };

/** Où et avec quoi tourne la commande : sa sortie, ses dépendances et le dossier de lancement. */
export interface RunEnv {
  io: OrchestrateIo;
  deps: OrchestrateDeps;
  launch: string;
}

/** Les contrôles de lancement de command.ts, passés par l'appelant : ce module ne les importe pas (command.ts l'importe). */
export interface LaunchChecks {
  resolveTargets: (args: Pick<Args, 'lots'>, io: OrchestrateIo, refusals: string[]) => Target[];
  /** Le contrôle préalable d'un lot de lancement, pour des lots ajoutés à la vague `addTo.wave` (qui porte déjà `addTo.lots`). */
  preflight: (targets: Target[], run: RunEnv, addTo: { wave: string; lots: KnownLot[] }) => Promise<{ refusals: string[]; lots: LotState[] }>;
}

const ALONE: (keyof Args)[] = ['lots', 'resume', 'status', 'drop', 'stopAfterCurrent', 'budget', 'lotBudgets', 'dryRun', 'continue', 'answers', 'integrate', 'removeWorktree', 'waits', 'goal', 'maxSessions'];

/** `--add` ne se combine avec rien d'autre que `--wave` (L421) : vrai quand une autre action est donnée. */
export const addNotAlone = (args: Args): boolean => ALONE.some((k) => (Array.isArray(args[k]) ? (args[k] as unknown[]).length > 0 : !!args[k] || args[k] === 0));

/** La clé d'un lot tel que le lead l'a nommé : le projet donné, ou le dossier de lancement. */
export const addKey = (launch: string, t: { project?: string; lot: string }): string => lotKey(t.project ?? basename(launch), t.lot);

/** La commande qui ajoute le lot à la vague vivante qui tient le dépôt, quand cette vague a été lancée depuis ce dossier (`--add` ne voit que celles-là) ; sinon rien. */
export function addHint(t: { projectDir: string; lot: string }, wave: string, launch: string): string {
  if (!liveWaves(cadenceHome()).some((w) => w.wave === wave && w.cwd === launch)) return '';
  return ` ; pour y ajouter ce lot : cadence orchestrate --add ${relative(launch, t.projectDir) || '.'}:${t.lot} --wave ${wave}`;
}

/** Refus d'un ajout (code 2) ou rien : les lots déjà dans la vague ou en file ne sont pas rejoués, le budget restant doit tenir celui de chaque lot ajouté. */
function budgetRefusals(lots: LotState[], wave: WaveState | null): string[] {
  let remaining = wave ? wave.budget - wave.consumed : Infinity;
  const out: string[] = [];
  for (const l of lots) {
    if (l.budget! > remaining) out.push(`${lotKey(l.project, l.lot)} : le budget restant de la vague (${Math.max(0, Math.round(remaining))} tokens) ne tient pas le budget du lot (${l.budget})`);
    remaining -= l.budget!;
  }
  return out;
}

/**
 * `--add` sur une vague VIVANTE (L421) : chaque lot passe le contrôle préalable d'un lot donné au lancement (dépôt tenu par CETTE vague admis, dépendances comptées dans la vague), puis est déposé
 * dans la file d'ajouts que la vague prend entre deux étapes. Tout est refusé avant d'agir (code 2) dès qu'un lot l'est, comme `--answer`.
 */
export async function addToLive(args: Args, run: RunEnv, store: RunStore, checks: LaunchChecks): Promise<number> {
  const { io, launch } = run;
  const refusals: string[] = [];
  const targets = checks.resolveTargets({ lots: args.add }, io, refusals);
  if (!waveReadsAdds(store.dir)) refusals.push(`la vague ${store.id} ne lit pas la file d'ajouts (lancée avec une version de cadence d'avant L421) : attendre sa fin, puis lancer le lot dans une vague`);
  const queued = store.addQueue().map((e) => ({ project: e.project ?? basename(launch), lot: e.lot, queued: true }));
  const pre = refusals.length ? { refusals: [] as string[], lots: [] as LotState[] } : await checks.preflight(targets, run, { wave: store.id, lots: [...store.lots(), ...queued] });
  refusals.push(...pre.refusals, ...budgetRefusals(pre.lots, store.readWave()));
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  for (const a of args.add) {
    const key = addKey(launch, a);
    const id = store.requestAdd({ project: a.project, lot: a.lot, model: a.model });
    // La vague a pu finir entre le contrôle et le dépôt : sa file ne sera plus lue, la demande est retirée.
    if (!liveWaves(cadenceHome()).some((w) => w.wave === store.id)) {
      store.markAddTaken(id);
      io.err(`orchestrate : ${key} : la vague ${store.id} vient de finir, lot non ajouté : le lancer dans une nouvelle vague`);
      return 2;
    }
    store.journal(`demande : ajouter ${key} à la vague`);
    io.out(`${key} : ajout déposé — la vague ${store.id} le prend entre deux étapes et le joue dès qu'un créneau est libre`);
  }
  return 0;
}

/** Ce que la vague en cours d'`execute` prête à la file d'ajouts : ses états partagés (mutés par l'ajout) et les gestes de command.ts. */
export interface AddEnv {
  store: RunStore;
  wave: WaveState;
  wctx: WaveCtx;
  io: OrchestrateIo;
  deps: OrchestrateDeps;
  launch: string;
  /** Les contextes de la vague, les lots de la vague (reprise comprise) et ceux du tour en cours (le même tableau au premier tour). */
  ctxs: LotCtx[];
  all: LotState[];
  lots: LotState[];
  /** Les verrous de dépôt tenus, les dépôts libérés et les dépôts de la vague. */
  held: string[];
  freed: Set<string>;
  repos: string[];
  freeRepo: (repo: string) => void;
  saveWave: () => void;
  /** Pourquoi la vague ne prend plus de lot (incident, limite d'usage, budget épuisé, arrêt demandé), ou null. */
  stopCause: () => string | null;
  budgetLeft: () => number;
  /** Le registre des vagues vivantes : dépôts tenus et créneaux occupés. */
  announce: () => void;
  checks: LaunchChecks;
  /** Résout, contrôle et prépare un lot : son contexte, ou les refus. */
  build: (target: Target, known: KnownLot[]) => Promise<{ ctx: LotCtx } | { refusals: string[] }>;
}

/**
 * Les lots déposés par `--add` (L421), pris par la vague entre deux étapes comme les réponses du lead. Un lot dont le dépôt est occupé par un lot qui joue attend dans `waiting`
 * (déjà contrôlé : il n'est pas relu à chaque tour) ; un lot qui ne tient plus au moment de la prise est écarté et dit au journal.
 */
export class AddFeed {
  private waiting = new Map<number, LotCtx>();

  constructor(private e: AddEnv) {}

  private discard(entry: AddEntry, why: string): null {
    this.e.wctx.log(`${addKey(this.e.launch, entry)} : ajout écarté (${why})`);
    this.e.store.markAddTaken(entry.id);
    this.waiting.delete(entry.id);
    return null;
  }

  /** Le contexte du lot demandé, contrôlé comme au lancement ; null quand il est écarté (dit au journal). */
  private async prepare(entry: AddEntry): Promise<LotCtx | null> {
    const e = this.e;
    const key = addKey(e.launch, entry);
    const stop = e.stopCause();
    if (stop) return this.discard(entry, stop);
    const refusals: string[] = [];
    const targets = e.checks.resolveTargets({ lots: [{ project: entry.project, lot: entry.lot, model: entry.model as AnyModel | undefined }] }, e.io, refusals);
    const known = [...e.ctxs, ...this.waiting.values()].map((c) => ({ project: c.lot.project, lot: c.lot.lot }));
    const built = refusals.length ? { refusals } : await e.build(targets[0]!, known);
    if ('refusals' in built) return this.discard(entry, built.refusals.map((r) => (r.startsWith(`${key} : `) ? r.slice(key.length + 3) : r)).join(' ; '));
    if (built.ctx.lot.budget! > e.budgetLeft()) return this.discard(entry, `le budget restant de la vague ne tient pas le budget du lot (${built.ctx.lot.budget})`);
    return built.ctx;
  }

  /** Prend le verrou et la garde de push d'un dépôt que la vague ne tient pas (ou plus) ; rend la cause du refus. */
  private hold(repo: string, fresh: string[]): string | null {
    const e = this.e;
    const file = join(sharedStateDir(repo), REPO_LOCK);
    if (e.held.includes(file)) return null;
    const l = takeLock(file, { pid: process.pid, wave: e.wave.id, started: new Date().toISOString() });
    if (!l.ok && l.held.pid !== process.pid) return `${basename(repo)} : une orchestration y est déjà en cours (${l.held.wave}, pid ${l.held.pid})`;
    e.held.push(file);
    fresh.push(repo);
    if (l.ok && l.stale) e.wctx.log(`orchestrate : verrou de dépôt périmé retiré (${basename(repo)}, pid ${l.stale.pid} mort)`);
    const hook = installPrePush(repo, e.wave.id);
    if (!hook.ok) return `${basename(repo)} : ${hook.reason}`;
    e.freed.delete(repo);
    if (!e.repos.includes(repo)) e.repos.push(repo);
    return null;
  }

  /** Les verrous de tous les dépôts du lot ; en cas de refus, ceux pris pour lui sont rendus. */
  private holdAll(c: LotCtx): string | null {
    const fresh: string[] = [];
    const refused = lotRepoPaths(c.lot).map((r) => this.hold(r, fresh)).find((x) => x) ?? null;
    if (refused) for (const r of fresh) this.e.freeRepo(r);
    return refused;
  }

  private admit(entry: AddEntry, c: LotCtx): void {
    const e = this.e;
    e.ctxs.push(c);
    e.all.push(c.lot);
    if (e.lots !== e.all) e.lots.push(c.lot);
    e.wave.lots.push(lotKey(c.lot.project, c.lot.lot));
    e.store.writeLot(c.lot);
    e.saveWave();
    e.store.markAddTaken(entry.id);
    this.waiting.delete(entry.id);
    e.wctx.log(`${lotKey(c.lot.project, c.lot.lot)} : ajouté à la vague ${e.wave.id}`);
  }

  /** Les lots ajoutés à ce tour, prêts à être joués ; `canRun` dit si le dépôt du lot est libre (jamais deux sessions dans un même dépôt hors worktree). */
  async take(canRun: (c: LotCtx) => boolean): Promise<LotCtx[]> {
    const added: LotCtx[] = [];
    for (const entry of this.e.store.addQueue()) {
      const c = this.waiting.get(entry.id) ?? (await this.prepare(entry));
      if (!c) continue;
      if (!canRun(c)) {
        this.waiting.set(entry.id, c);
        continue;
      }
      const refused = this.holdAll(c);
      if (refused) this.discard(entry, refused);
      else {
        this.admit(entry, c);
        added.push(c);
      }
    }
    if (added.length) this.e.announce();
    return added;
  }

  /** Les demandes encore en file quand plus rien ne joue ne seront plus lues : écartées et dites. */
  drain(why: string): void {
    this.waiting.clear();
    for (const entry of this.e.store.addQueue()) this.discard(entry, why);
  }
}

/** Un lot est-il encore à jouer dans ce dépôt (utilisé pour décider d'un worktree) ? */
export const openInRepo = (ctxs: LotCtx[], c: LotCtx): LotCtx[] => ctxs.filter((o) => !lotFinished(o.lot) && lotRepoPaths(o.lot).some((r) => lotRepoPaths(c.lot).includes(r)));
