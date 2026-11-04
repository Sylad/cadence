import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Args, OrchestrateDeps, OrchestrateIo, Target } from './command.js';
import type { FillPlan } from './continue.js';
import type { LotCtx, WaveCtx } from './cycle.js';
import { lotFinished, lotKey, lotRepoPaths, type LotState, type RunStore, type WaveState } from './state.js';
import { cadenceHome, liveWaves } from './registry.js';
import { REPO_LOCK, takeLock } from './lock.js';
import { heldRefusal } from '../local-task.js';
import { installPrePush } from './guard.js';
import { addableHandBack, addGesture } from './geste.js';
import { baseBranchOf, lotBranch, lotTreeDir, trackedDirty } from './worktree.js';
import { lotSpent } from './cycle/budget.js';
import { firstReview, toFix } from './cycle/review.js';
import { firstWrite } from './cycle/spec-steps.js';
import { sharedStateDir } from '../state.js';
import { waveReadsAdds } from './snapshot.js';
import type { AnyModel } from './launch.js';

/** Une demande de la file d'ajouts (`adds.log`). */
export type AddEntry = { id: number; project?: string; lot: string; model?: string };

/** Un lot de la vague (ou déjà en file d'ajout) vu par le contrôle préalable d'un ajout. */
export type KnownLot = { project: string; lot: string; queued?: boolean; /** État du lot de la vague (absent d'un lot en file) : un lot retiré par --drop se relance dans une nouvelle vague (L554). */ status?: LotState['status']; outcome?: string | null; /** L'étape où le lot a été rendu : `integrate` n'est jamais ajoutable (L563). */ next?: LotState['next'] };

/** Où et avec quoi tourne la commande : sa sortie, ses dépendances et le dossier de lancement. */
export interface RunEnv {
  io: OrchestrateIo;
  deps: OrchestrateDeps;
  launch: string;
}

/** Les contrôles de lancement d'execute.ts (LAUNCH_CHECKS), passés par l'appelant : ce module ne les importe pas (execute.ts l'importe). */
export interface LaunchChecks {
  resolveTargets: (args: Pick<Args, 'lots'>, io: OrchestrateIo, refusals: string[]) => Target[];
  /** Le contrôle préalable d'un lot de lancement, pour des lots ajoutés à la vague `addTo.wave` (qui porte déjà `addTo.lots`). */
  preflight: (targets: Target[], run: RunEnv, addTo: { wave: string; lots: KnownLot[] }) => Promise<{ refusals: string[]; lots: LotState[] }>;
}

const ALONE: (keyof Args)[] = ['lots', 'resume', 'status', 'drop', 'stopAfterCurrent', 'budget', 'lotBudgets', 'dryRun', 'continue', 'answers', 'integrate', 'removeWorktree', 'waits', 'goal', 'maxSessions'];

/** `--add` ne se combine avec rien d'autre que `--wave` (L421) : vrai quand une autre action est donnée. */
export const addNotAlone = (args: Args): boolean => ALONE.some((k) => (Array.isArray(args[k]) ? (args[k] as unknown[]).length > 0 : !!args[k] || args[k] === 0));

/**
 * L'identifiant d'un projet dans la vague, le même quelle que soit la façon de le taper : le chemin donné résolu depuis le dossier de lancement (`./b`, `b/../b` → `b`),
 * et le nom du dossier de lancement quand le projet est ce dossier (`.`, ou rien). Sans cela une vague lancée dans un dépôt avec `L1` rangeait son lot sous `a:L1` et
 * `--add .:L2` cherchait ses lots et ses doublons sous `.` : dépendance non reconnue, doublon admis.
 */
export function projectName(cwd: string, project?: string): string {
  if (!project) return basename(cwd);
  return relative(cwd, resolve(cwd, project)) || basename(cwd);
}

/** La clé d'un lot tel que la vague le range : le projet résolu (`projectName`) et le lot. */
export const addKey = (launch: string, t: { project?: string; lot: string }): string => lotKey(projectName(launch, t.project), t.lot);

/**
 * Vrai quand une cible tapée (`--integrate .:L1`, `--answer L1`, `--drop a:L1`) désigne ce lot de la vague : son projet, s'il est donné, résolu depuis le dossier de
 * lancement comme la vague l'a rangé (`projectName`), ou n'importe quel projet sinon. Sans cela `.:L1` tapé depuis le dépôt — la forme que les gestes imprimés
 * donnent (L554) — cherchait un projet `.` et répondait « lot inconnu ».
 */
export const namesLot = (launch: string, t: { project?: string; lot: string }, l: { project: string; lot: string }): boolean => l.lot === t.lot && (!t.project || l.project === projectName(launch, t.project));

/** La commande qui ajoute le lot à la vague vivante qui tient le dépôt, quand cette vague a été lancée depuis ce dossier (`--add` ne voit que celles-là) ; sinon rien. */
export function addHint(t: { projectDir: string; lot: string }, wave: string, launch: string): string {
  if (!liveWaves(cadenceHome()).some((w) => w.wave === wave && w.cwd === launch)) return '';
  return ` ; pour y ajouter ce lot : cadence orchestrate --add ${relative(launch, t.projectDir) || '.'}:${t.lot} --wave ${wave}`;
}

/**
 * R4 (L563) : pourquoi un lot rendu ne peut pas être repris, ou null. Son worktree conservé et la branche de la vague doivent exister, et l'arbre n'a aucun fichier suivi modifié (le correctif du lead est commité) :
 * le programme ne commite ni ne jette jamais l'arbre du lead, le refus nomme les fichiers et la commande à rejouer après le commit.
 */
export function resumeRefusal(store: RunStore, l: Pick<LotState, 'project' | 'lot' | 'repo'>, launch: string): string | null {
  const dir = lotTreeDir(store.dir, l.project, l.lot, l.repo);
  const branch = lotBranch(store.id, l.project, l.lot);
  if (!baseBranchOf(l.repo, branch)) return `la branche ${branch} de la vague n'existe plus`;
  if (!existsSync(dir)) return `le worktree ${dir} n'existe plus`;
  if (!existsSync(join(dir, '.git'))) return `${dir} n'est plus un worktree git`;
  const dirty = trackedDirty(dir);
  return dirty.length ? `fichiers non commités dans ${dir} : ${dirty.join(', ')} ; les commiter, puis rejouer : ${addGesture(store.id, lotKey(l.project, l.lot), launch)}` : null;
}

/** Choix optionnels du lot (R2) : absents de l'ancien lot, ils le restent après la reprise, même si le ctx neuf du préflight les porte. */
const CHOIX_DU_LOT = ['goal', 'light', 'express', 'repos'] as const;

/**
 * La prise d'un lot rendu (L563) : le ctx neuf (`c`, de `e.build` : steps vides, sans constats) reçoit une COPIE de l'état de l'ancien ctx de la vague (`old`), puis, dans cet ordre (R6) :
 * pass 0, escalade vidée, budget = dépensé + budget d'un lot neuf, steps gardés, queued sans outcome ; l'état de reprise (R11 : `resumedFrom` = la vague, `resumedReviewed`, comme execute.ts:planTrees) ;
 * ENFIN `next`, car `runLot` ne passe pas par son bloc de départ pour un lot qui garde ses steps : `toFix` sur les constats de revue de code (pass déjà à 0), sinon `firstReview` (la revue du correctif
 * du lead) quand le lot a passé une revue, sinon `firstWrite`. Rend l'étape choisie, pour le journal.
 */
export function resumeNext(c: LotCtx, old: LotCtx): 'correction' | 'revue' | 'écriture' {
  const l = c.lot;
  const { budget, escalationReserve, node } = l;
  // R2 : c.lot reçoit une copie de old.lot, model, visible, small, light, express, repos et goal compris (le lot repris garde ce que la vague lui avait donné, constat de revue L563) ;
  // seuls config, tree et plan du ctx neuf restent, et les valeurs que R6 pose ci-dessous. Le ctx neuf ne comble que les champs de structure absents d'un vieil état (constats…),
  // jamais un choix optionnel que l'ancien lot n'avait pas.
  Object.assign(l, structuredClone(old.lot));
  for (const k of CHOIX_DU_LOT) if (old.lot[k] === undefined) delete l[k];
  l.node = node;
  l.escalationReserve = escalationReserve;
  l.pass = 0;
  delete l.escalation;
  l.budget = lotSpent(old.lot) + budget!;
  l.status = 'queued';
  l.outcome = null;
  const reviewed = l.constats.some((k) => k.source === 'code');
  l.resumedFrom = c.wave.id;
  l.resumedReviewed = !!old.lot.resumedReviewed || reviewed || l.steps.some((st) => st.kind.startsWith('review'));
  if (reviewed) {
    toFix(c, l.constats, 'reprise du lot rendu');
    return 'correction';
  }
  l.next = l.resumedReviewed ? firstReview(c) : firstWrite(c);
  return l.resumedReviewed ? 'revue' : 'écriture';
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
  // R4 (L563) : un lot rendu qu'on reprend doit avoir son worktree conservé, commité, avant toute écriture.
  const inWave = store.lots();
  for (const t of targets) {
    const rendu = inWave.find((l) => lotKey(l.project, l.lot) === addKey(launch, t));
    const why = rendu && addableHandBack(rendu) ? resumeRefusal(store, rendu, launch) : null;
    if (why) refusals.push(`${lotKey(rendu!.project, rendu!.lot)} : worktree du lot introuvable ou arbre sale : ${why}`);
  }
  const queued = store.addQueue().map((e) => ({ project: projectName(launch, e.project), lot: e.lot, queued: true }));
  const pre = refusals.length ? { refusals: [] as string[], lots: [] as LotState[] } : await checks.preflight(targets, run, { wave: store.id, lots: [...inWave, ...queued] });
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

/** Ce que la vague en cours d'`execute` prête à la file d'ajouts : ses états partagés (mutés par l'ajout) et les gestes d'execute.ts. */
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
  /** Pourquoi le lot ne se joue plus d'après son plan (fini entre-temps, disparu, plan illisible), ou null. */
  planState: (c: LotCtx) => string | null;
  /** Le registre des vagues vivantes : dépôts tenus et créneaux occupés. */
  announce: () => void;
  checks: LaunchChecks;
  /** Résout, contrôle et prépare un lot : son contexte, ou les refus. */
  build: (target: Target, known: KnownLot[]) => Promise<{ ctx: LotCtx } | { refusals: string[] }>;
}

/**
 * Les lots déposés par `--add` (L421), pris par la vague entre deux étapes comme les réponses du lead. Un lot dont le dépôt est occupé par un lot qui joue attend dans `waiting`
 * (son contexte n'est pas reconstruit à chaque tour, mais ce qui l'écarterait est relu au moment de le prendre) ; un lot qui ne tient plus à cet instant est écarté et dit au journal.
 */
export class AddFeed {
  private waiting = new Map<number, LotCtx>();
  /** Les lots tirés du plan (L527) dont le dépôt était pris quand ils ont été contrôlés : gardés pour ne pas refaire le contrôle à chaque lecture. */
  private drawn = new Map<string, LotCtx>();
  /** Les lots tirés du plan (L527) que le contrôle a refusés pour eux-mêmes : écartés pour la vague, comme un lot sauté au tirage. */
  private refused = new Set<string>();
  /** Les causes déjà dites au journal (L527) : un refus passager (arbre sale, dépôt tenu) est relu à chaque lecture de la file mais dit une fois. */
  private said = new Set<string>();

  constructor(private e: AddEnv) {}

  private discard(entry: AddEntry, why: string, line = `${addKey(this.e.launch, entry)} : ajout écarté (${why})`): null {
    this.e.wctx.log(line);
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
    // R12 (L563) : un lot rendu en fin de cycle n'est pas « déjà dans la vague » pour sa propre reprise ; son arbre est recontrôlé à la prise.
    const old = this.oldOf(key);
    const resumable = old && addableHandBack(old.lot) ? old : undefined;
    const cut = resumable ? this.treeRefusal(resumable.lot) : null;
    if (cut) return this.discard(entry, cut, `orchestrate : ${key} : ajout écarté à la prise : ${cut}`);
    const known = [...e.ctxs.filter((c) => c !== resumable), ...this.waiting.values()].map((c) => ({ project: c.lot.project, lot: c.lot.lot }));
    const built = refusals.length ? { refusals } : await e.build(targets[0]!, known);
    if ('refusals' in built) return this.discard(entry, built.refusals.map((r) => (r.startsWith(`${key} : `) ? r.slice(key.length + 3) : r)).join(' ; '));
    if (built.ctx.lot.budget! > e.budgetLeft()) return this.discard(entry, `le budget restant de la vague ne tient pas le budget du lot (${built.ctx.lot.budget})`);
    return built.ctx;
  }

  /** Un ajout resté en attente est recontrôlé quand la vague le prend : arrêt demandé, budget épuisé ou lot fini entre-temps l'écartent comme à la lecture de la file. */
  private recheck(entry: AddEntry, c: LotCtx): LotCtx | null {
    const e = this.e;
    const old = this.oldOf(lotKey(c.lot.project, c.lot.lot));
    const cut = old ? (addableHandBack(old.lot) ? this.treeRefusal(old.lot) : "le lot n'est plus rendu en fin de cycle") : null;
    if (cut) return this.discard(entry, cut, `orchestrate : ${addKey(e.launch, entry)} : ajout écarté à la prise : ${cut}`);
    const why = e.stopCause() ?? (c.lot.budget! > e.budgetLeft() ? `le budget restant de la vague ne tient pas le budget du lot (${c.lot.budget})` : e.planState(c));
    return why ? this.discard(entry, why) : c;
  }

  /** L'ancien contexte du lot dans la vague (le lot rendu qu'une prise remplace), s'il y est. */
  private oldOf(key: string): LotCtx | undefined {
    return this.e.ctxs.find((c) => lotKey(c.lot.project, c.lot.lot) === key);
  }

  /** R4 rejoué à la prise (R12) : la cause, écrite comme le refus de `--add`, ou null. */
  private treeRefusal(l: LotState): string | null {
    const why = resumeRefusal(this.e.store, l, this.e.launch);
    return why ? `worktree du lot introuvable ou arbre sale : ${why}` : null;
  }

  /** Prend le verrou et la garde de push d'un dépôt que la vague ne tient pas (ou plus) ; rend la cause du refus. */
  private hold(repo: string, fresh: string[]): string | null {
    const e = this.e;
    const file = join(sharedStateDir(repo), REPO_LOCK);
    if (e.held.includes(file)) return null;
    const l = takeLock(file, { pid: process.pid, wave: e.wave.id, started: new Date().toISOString() });
    if (!l.ok && l.held.pid !== process.pid) return heldRefusal(repo, l.held);
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

  /**
   * Admet le lot dans la vague. Un lot rendu repris (`old`, R5) REMPLACE son ancien ctx à sa place dans `ctxs`, `all` et `lots` (une seule occurrence), et reçoit son état de `resumeNext` ;
   * `wave.lots` porte déjà sa clé.
   */
  private admit(entry: AddEntry | null, c: LotCtx, old?: LotCtx): void {
    const e = this.e;
    const key = lotKey(c.lot.project, c.lot.lot);
    const resumed = old ? resumeNext(c, old) : null;
    const put = <T>(list: T[], same: (x: T) => boolean, item: T): void => {
      const i = list.findIndex(same);
      if (i < 0) list.push(item);
      else list[i] = item;
    };
    put(e.ctxs, (x) => x === old, c);
    put(e.all, (x) => x === old?.lot, c.lot);
    if (e.lots !== e.all) put(e.lots, (x) => x === old?.lot, c.lot);
    if (!e.wave.lots.includes(key)) e.wave.lots.push(key);
    e.store.writeLot(c.lot);
    e.saveWave();
    if (entry) {
      e.store.markAddTaken(entry.id);
      this.waiting.delete(entry.id);
    }
    e.wctx.log(`${key} : ajouté à la vague ${e.wave.id}`);
    if (resumed) e.wctx.log(`${key} : reprise du lot rendu à ${resumed === 'correction' ? 'la correction' : resumed === 'revue' ? 'la revue' : "l'écriture"}, worktree ${c.tree?.dir ?? c.lot.repo}`);
  }

  /** Les lots ajoutés à ce tour, prêts à être joués ; `canRun` dit si le dépôt du lot est libre (jamais deux sessions dans un même dépôt hors worktree). */
  async take(canRun: (c: LotCtx) => boolean): Promise<LotCtx[]> {
    const added: LotCtx[] = [];
    for (const entry of this.e.store.addQueue()) {
      const kept = this.waiting.get(entry.id);
      const c = kept ? this.recheck(entry, kept) : await this.prepare(entry);
      if (!c) continue;
      if (!canRun(c)) {
        this.waiting.set(entry.id, c);
        continue;
      }
      const refused = this.holdAll(c);
      if (refused) this.discard(entry, refused);
      else {
        this.admit(entry, c, this.oldOf(lotKey(c.lot.project, c.lot.lot)));
        added.push(c);
      }
    }
    if (added.length) this.e.announce();
    return added;
  }

  private say(line: string): void {
    if (this.said.has(line)) return;
    this.said.add(line);
    this.e.wctx.log(line);
  }

  /** Le contexte d'un lot tiré du plan : celui gardé (recontrôlé : arrêt, budget, lot fini) ou celui que le contrôle préalable construit ; null quand il est refusé ou ne tient pas (L527). */
  private async control(t: Target, key: string, badRepos: Set<string>, room: number): Promise<LotCtx | null> {
    const e = this.e;
    const kept = this.drawn.get(key);
    if (kept) {
      if (kept.lot.budget! <= Math.min(e.budgetLeft(), room) && !e.planState(kept)) return kept;
      this.drawn.delete(key);
      return null;
    }
    const known = [...e.ctxs, ...this.waiting.values()].map((x) => ({ project: x.lot.project, lot: x.lot.lot }));
    const built = await e.build(t, known);
    if ('refusals' in built) {
      // Un refus propre au lot l'écarte pour la vague ; celui du dépôt (arbre sale, orchestration en cours) est passager : le lot est relu à la lecture suivante.
      if (built.refusals.some((r) => r.startsWith(`${key} : `))) this.refused.add(key);
      else badRepos.add(t.repo); // les autres lots de ce dépôt buteraient sur la même cause, ce tour-ci
      for (const r of built.refusals) this.say(`continue : lot sauté — ${r}`);
      return null;
    }
    return built.ctx.lot.budget! <= Math.min(e.budgetLeft(), room) ? built.ctx : null;
  }

  /**
   * L527 : remplit au plus `free` créneaux libres avec les lots prêts du plan (`plan.targets`, déjà dans l'ordre de priorité et filtrés sur les ressources libres), chacun contrôlé comme un lot ajouté.
   * Ce qu'un lot pris engage est décompté avant le suivant : son budget du `plan.room`, ses ressources `uses` (un lot qui veut une ressource que ce remplissage vient de prendre attend la lecture suivante).
   * Un lot dont le dépôt est pris par un lot qui joue (`canRun`) est gardé pour la lecture suivante, le lot d'un autre dépôt passe devant ; un lot refusé est sauté pour la vague, dit au journal ;
   * un lot que le budget restant ne tient pas n'est ni pris ni écarté (un moins cher peut passer, ou le tour suivant).
   */
  async fill(plan: FillPlan, free: number, canRun: (c: LotCtx) => boolean): Promise<LotCtx[]> {
    const e = this.e;
    const added: LotCtx[] = [];
    const badRepos = new Set<string>();
    const taken = new Set<string>();
    let room = plan.room;
    for (const t of plan.targets) {
      if (added.length >= free || e.stopCause()) break;
      const key = lotKey(t.project, t.lot);
      if (this.refused.has(key) || badRepos.has(t.repo) || t.uses.some((r) => taken.has(r))) continue;
      const c = await this.control(t, key, badRepos, room);
      if (!c || !this.start(key, c, canRun)) continue;
      added.push(c);
      room -= c.lot.budget!;
      for (const r of t.uses) taken.add(r);
    }
    if (added.length) e.announce();
    return added;
  }

  /** Prend le lot contrôlé `c` : faux quand le dépôt est pris (gardé pour la lecture suivante) ou que la prise est refusée (sauté, dit au journal). */
  private start(key: string, c: LotCtx, canRun: (c: LotCtx) => boolean): boolean {
    if (!canRun(c)) {
      this.drawn.set(key, c);
      return false;
    }
    this.drawn.delete(key);
    const refused = this.holdAll(c);
    if (refused) {
      this.say(`continue : lot sauté — ${key} : ${refused}`);
      return false;
    }
    this.e.wctx.log(`créneau libre rempli par ${key}`);
    this.admit(null, c);
    return true;
  }

  /** Les demandes encore en file quand plus rien ne joue ne seront plus lues : écartées et dites. */
  drain(why: string): void {
    this.waiting.clear();
    this.drawn.clear();
    for (const entry of this.e.store.addQueue()) this.discard(entry, why);
  }
}

/** Un lot est-il encore à jouer dans ce dépôt (utilisé pour décider d'un worktree) ? */
export const openInRepo = (ctxs: LotCtx[], c: LotCtx): LotCtx[] => ctxs.filter((o) => !lotFinished(o.lot) && lotRepoPaths(o.lot).some((r) => lotRepoPaths(c.lot).includes(r)));
