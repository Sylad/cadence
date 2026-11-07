import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { testWorkersFrom } from './workers.js';
import { basename, join } from 'node:path';
import { type Day } from '../dates.js';
import { heldRefusal } from '../local-task.js';
import { onTermination } from '../proc.js';
import { stopApps } from './app.js';
import { isOpen } from '../plan.js';
import { sharedStateDir } from '../state.js';
import { acquireSlot, cadenceHome, registerWave, updateWaveRepos } from './registry.js';
import { loadTemplates } from './briefs.js';
import { fillsFreeSlots, fillTargetsSafe, handedBackStreak, stopReason, type FillFacts } from './continue.js';
import { launchWithQueue, queueFill, QueueRun, sayTo, type PushToWave, type Say } from './queue-draw.js';
import { parseOrchestrateArgs } from './command-args.js';
import { Budget, DROPPED, STOP_REQUESTED, countInterrupted, handBackDroppedQuestions, workDir, type LotCtx, type WaveCtx } from './cycle.js';
import { installPrePush } from './guard.js';
import { killSessions, type ClaudeFn } from './launch.js';
import { REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { awaitsDependency, groupLots, runPool } from './pool.js';
import { slotPlace } from './attente.js';
import { AddFeed, addToLive, openInRepo, type AddAsk, type KnownLot, type LaunchChecks } from './ajout.js';
import { takeIntegrations } from './integration-vivante.js';
import { repoBranch } from './integrate.js';
import { baseBranchOf, keptLines, legacyLotSlug, lotBranch, lotTreeDir, planFileSet, recoverTree, stalenessText } from './worktree.js';
import { applyAnswer, excludeState, lotFinished, lotKey, lotRepoPaths, RunStore, type LotState, type WaveState } from './state.js';
import { linkNodeBin } from './node-env.js';
import { endOfWaveLines } from '../inspect-read.js';
import { launchCost, quotaText, renderTable, resumeCommand } from './table.js';
import { agentsOf, preflight, projectEnv, resolveTargets, type Target } from './preflight.js';
import { dryRun } from './dry-run.js';
import { repoHolds, updateWaveReposSafe } from './cycle/depot-partage.js';
import { noteTakenAnswers } from './cycle/plan-writes.js';
import { draw, type Drawn } from './draw.js';
import { control, duration, liveStore, maxSessions } from './status.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';

/** Attente (ms) entre deux lectures de la file de réponses d'une vague vivante (L407) quand aucune file de lots ne finit. */
const ANSWER_POLL_MS = 2000;

/** La vague a-t-elle encore des tours à tirer : le plan avec `--continue`, ou des lots en attente dans la file approuvée (L498, toute vague vivante). */
const roundsAhead = (args: Args, queue: QueueRun): boolean => args.continue || queue.mayDraw();

/** Les lots d'un tour tiré entrent dans l'état de la vague (leur lien Node posé) ; le journal nomme ceux du plan (« continue : tire … »), ceux de la file le sont par `launchWithQueue`. */
function registerRound(drawn: Drawn, r: { wave: WaveState; all: LotState[]; store: RunStore; deps: OrchestrateDeps }, say: (line: string) => void): void {
  for (const l of drawn.lots) {
    if (l.node) l.node.link = (r.deps.linkNode ?? linkNodeBin)(r.store.dir, l.node.version, l.node.bin);
    r.store.writeLot(l);
    r.wave.lots.push(lotKey(l.project, l.lot));
  }
  r.store.writeWave(r.wave);
  r.all.push(...drawn.lots);
  const fromPlan = drawn.lots.filter((l) => !drawn.queued.has(lotKey(l.project, l.lot)));
  if (fromPlan.length) say(`continue : tire ${fromPlan.map((l) => lotKey(l.project, l.lot)).join(', ')}`);
}

/** Pourquoi la vague ne tire plus de lot entre deux tours, ou null (`stopReason` : budget, `--until`, limite d'usage, question posée, deux lots rendus de suite, vague interrompue, arrêt demandé). */
function roundStop(wave: WaveState, all: LotState[], store: RunStore, io: OrchestrateIo, args: Args): { why: string | null; remaining: number } {
  const questions = all.filter((l) => l.status === 'question').length;
  const remaining = wave.status === 'suspended-budget' ? 0 : wave.budget - wave.consumed;
  const why = stopReason({ now: io.now(), until: args.untilAt, quotaHit: wave.status === 'suspended-quota', questions, streak: handedBackStreak(all), interrupted: wave.status === 'interrupted' && questions === 0, stopRequested: store.control().stopAfterCurrent, remaining });
  return { why, remaining };
}

/**
 * `--continue` (L147) : tant qu'aucune borne ne joue, tire jusqu'à `cap` lots prêts du plan et les joue dans la même vague
 * (même budget, même dossier d'état). Bornes : budget, `--until`, limite d'usage,
 * question posée, deux lots rendus de suite, vague interrompue, plus de lot prêt dont l'estimation tient dans le budget restant.
 * L498 : toute vague vivante tire d'abord de la file approuvée (R19), avec ou sans `--continue` ; sans lot en attente dans la file et sans `--continue`, rend le code tel quel.
 * Une vague sans `--continue` ne tire que de la file : elle s'arrête sans le dire.
 */
export async function continueRounds(first: number, wave: WaveState, all: LotState[], store: RunStore, io: OrchestrateIo, deps: OrchestrateDeps, today: Day, args: Args, launch: string): Promise<number> {
  if (first === 2) return first; // 2 : refus au verrou, rien n'a tourné
  const queue = QueueRun.of(wave, launch, deps);
  if (!roundsAhead(args, queue)) return first;
  const say = sayTo(io, store);
  const stopSaying = args.continue ? say : () => undefined;
  const exclude = new Set(all.map((l) => lotKey(l.project, l.lot)));
  const cap = maxSessions(args, io);
  let code = first;
  for (;;) {
    for (const l of all) exclude.add(lotKey(l.project, l.lot)); // L421 : les lots ajoutés à la main pendant la vague ne sont pas tirés une seconde fois
    const { why, remaining } = roundStop(wave, all, store, io, args);
    if (why) {
      stopSaying(`continue : arrêt — ${why}`);
      return code;
    }
    const drawn = await draw({ args, io, deps, launch }, exclude, remaining, cap, { run: queue, reserve: true, cap });
    queue.emit(say);
    for (const s of drawn.skipped) say(`continue : lot sauté — ${s}`);
    if (drawn.lots.length === 0) {
      stopSaying("continue : arrêt — plus aucun lot prêt dont l'estimation tient dans le budget restant");
      return code;
    }
    registerRound(drawn, { wave, all, store, deps }, say);
    // Les lots sont dans l'état de la vague (c'est leur acceptation) : ceux de la file passent à « tiré », un lancement refusé les rend (R7).
    code = await launchWithQueue(queue, drawn.queued, say, () => execute(wave, drawn.lots, store, io, deps, today, args, all));
    if (code === 2) return code;
  }
}

export function contexts(lots: LotState[], envs: ReturnType<typeof projectEnv>[], wctx: WaveCtx, wave?: WaveState): LotCtx[] {
  // L610 : la vague dit quels lots elle joue (une reprise ne joue que ceux qu'elle a repris), `--integrate` le lit pour refuser sur-le-champ un lot absent.
  if (wave) {
    wave.playing = lots.map((l) => lotKey(l.project, l.lot));
    wctx.saveWave();
  }
  return lots.map((lot, i) => ({ wave: wctx, lot, config: envs[i].config, loadPlan: envs[i].loadPlan }));
}

/** La forme ancienne du nom de branche d'un lot, en liste pour `recoverTree` (L581) : vide quand le projet n'en a pas. */
const oldSlugs = (project: string, lot: string): string[] => {
  const old = legacyLotSlug(project, lot);
  return old ? [old] : [];
};

/** L676 : des commits du lot existent sur une branche d'une vague passée que la reprise ne prend pas : jamais de session sur une branche neuve, le lot est rendu au lead (`runLot` ne joue pas un lot rendu) et la branche reste intacte ; il garde son arbre planifié, la vague ne passe en mode multi-créneaux que si tous ses lots en ont un. */
function handBackKept(c: LotCtx, refused: { from: string; refused: string }, log: (line: string) => void): void {
  const key = lotKey(c.lot.project, c.lot.lot);
  c.lot.status = 'handed-back';
  c.lot.outcome = `branche ${refused.from} d'une vague précédente non reprise : ${refused.refused} ; lot rendu sans session, branche intacte`;
  log(`orchestrate : ${key} : ${c.lot.outcome} (rebaser à la main puis relancer le lot, ou retirer la branche : cadence orchestrate --remove-worktree ${key} --abandon-commits)`);
}

/**
 * Quels lots jouent dans un worktree (L279). Un groupe de lots du même dépôt (`groupLots`) y joue si `orchestrate.worktrees` est vrai, s'il a au moins deux lots
 * ou si la vague a plus d'un créneau (`multiSlot`, L527 : tout lot d'un tel dépôt reçoit son worktree — donné seul, tiré par le remplissage ou apporté par `--add`, avec ou sans `--continue` — pour qu'un créneau libre reçoive le lot suivant du même dépôt), si le dépôt est sur une branche et si aucun de ses lots n'a de dépôt voisin (`repos:`, R2) ; sinon les lots restent à la suite, avec un avertissement qui dit pourquoi.
 * Un lot dont la branche existe déjà (reprise, R11) retrouve son worktree quel que soit le groupe ; un lot rendu à l'intégration dont la branche a disparu n'en reçoit pas. La branche de départ est celle du dépôt du lead à cet instant,
 * ou celle que la branche du lot a notée à sa création.
 */
export function planTrees(ctxs: LotCtx[], store: RunStore, wave: string, log: (line: string) => void, multiSlot: boolean): void {
  for (const group of groupLots(ctxs)) {
    const repo = group[0].lot.repo;
    const branch = repoBranch(repo);
    const requested = (group.length > 1 || multiSlot) && group.every((c) => c.config.worktrees);
    const why = !requested ? null : group.some((c) => c.lot.repos?.length) ? 'des lots du groupe ont des dépôts voisins (repos:)' : !branch ? 'le dépôt est en HEAD détaché' : null;
    if (why) log(`orchestrate : ${basename(repo)} : worktrees demandés mais ${why} : lots joués à la suite`);
    for (const c of group) {
      if (c.tree) continue; // L421 : un lot ajouté en cours de vague replanifie son groupe ; les arbres déjà posés (et leur état actif) ne sont pas refaits
      const lotBr = lotBranch(wave, c.lot.project, c.lot.lot);
      // Chemin de reprise d'un lot rendu hors intégration : sa branche d'une vague passée devient celle de cette vague (recoverTree), puis se retrouve comme une reprise (R11).
      const dir = lotTreeDir(store.dir, c.lot.project, c.lot.lot, repo);
      const recovered = !baseBranchOf(repo, lotBr) && c.lot.next !== 'integrate' && branch && c.config.worktrees ? recoverTree(repo, lotBr, dir, branch, { planFiles: planFileSet(c.loadPlan(), repo), alsoSlugs: oldSlugs(c.lot.project, c.lot.lot) }) : null;
      if (recovered && 'refused' in recovered) handBackKept(c, recovered, log);
      else if (recovered) {
        log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : branche ${recovered.from} d'une vague précédente reprise (${recovered.unintegrated} commit(s) non intégré(s), ${stalenessText(recovered)}) : le lot repart de son travail`);
        // L311 : le lot repris ne repasse pas par le contrôle préalable. Il reprend les constats de sa dernière revue (état de la vague qui l'a rendu) et repart à leur correction, ou à la revue quand il en a déjà passé une sans constat ; rendu avant sa première revue (ou état illisible ; les constats `tests` d'un lot rendu pour tests rouges ne font pas une revue, L318), il repart à l'écriture.
        const old = new RunStore(store.launchDir, recovered.from.split('/')[1]).readLot(c.lot.project, c.lot.lot);
        c.lot.resumedFrom = recovered.from.split('/')[1];
        c.lot.constats = old?.constats ?? [];
        c.lot.resumedReviewed = !!old && (old.constats.some((k) => k.source === 'code') || old.steps.some((s) => s.kind.startsWith('review')));
      }
      const known = baseBranchOf(repo, lotBr);
      const base = known ?? branch;
      // Un lot repris à l'intégration dont la branche n'existe plus (retirée par --remove-worktree --abandon-commits) n'a plus de commits à intégrer : pas de worktree recréé au sommet, `integrateLot` le rend.
      if (c.lot.next === 'integrate' && !known) continue;
      if (((requested && !why) || known) && base) c.tree = { dir, branch: lotBr, base, active: false };
    }
  }
}

/**
 * L591 : la session d'un lot repris à son tour d'intégration (`tookTurn`, posé par `integrateLot`) part sans redemander de créneau : il a rendu le sien en attendant, une autre file l'a
 * pris ; le temps de sa revue courte, plus de lots que le plafond peuvent jouer. Le journal le dit.
 */
function resumesTurn(ctxs: LotCtx[], lot: string | undefined, log: (line: string) => void): boolean {
  const resumed = lot !== undefined && ctxs.some((c) => c.tookTurn && lotKey(c.lot.project, c.lot.lot) === lot);
  if (resumed) log(`${lot} · reprend son tour d'intégration sans redemander de créneau`);
  return resumed;
}

/** Pose les verrous et les hooks, joue la vague, range l'état, rend le tableau et le code de sortie. */
export async function execute(wave: WaveState, lots: LotState[], store: RunStore, io: OrchestrateIo, deps: OrchestrateDeps, today: Day, args: Args, all: LotState[] = lots): Promise<number> {
  const cap = maxSessions(args, io);
  const launch = store.launchDir;
  // La configuration des projets est lue avant de poser quoi que ce soit : un cadence.yaml illisible ne laisse ni verrou ni hook.
  const envs = lots.map((lot) => projectEnv(lot.repo));
  // Les gabarits aussi : lus une fois, rendus depuis cet instantané jusqu'à la fin de la vague (ou jusqu'à sa reprise).
  const templates = loadTemplates(deps.templatesDir);
  mkdirSync(join(launch, '.cadence'), { recursive: true });
  excludeState(launch);
  const home = cadenceHome();
  const held: string[] = [];
  // L553 : un dépôt que tient une autre vague vivante et où la reprise n'intègre que (`args.shared`) n'a ici ni verrou, ni garde de push, ni inscription : ils restent à cette vague
  // tant qu'elle le tient ; dès qu'elle le libère, `claimRepo` (depot-partage.ts) les prend, sinon `deliver`, une nouvelle vague ou une tâche locale pourrait écrire le dépôt sous l'intégration.
  const shared = new Map(args.shared ?? []);
  const repos = [...new Set(lots.flatMap(lotRepoPaths))].filter((r) => !shared.has(r));
  /** Dépôts libérés : verrou et garde de push rendus (L132 : dès que leurs lots sont finis, pas à la fin de la vague). */
  const freed = new Set<string>();
  /** Lots dont la vague a fini de jouer (prêts, rendus, en échec ou suspendus) : ils ne tiennent plus de créneau. */
  const settled = new Set<LotCtx>();
  /** Lots que la vague a encore à jouer ET qui tiennent une session claude, sur les dépôts qu'elle tient encore (un par dépôt, un par lot en worktree) : ce que le registre compte pour les créneaux libres (L433 : un lot fini ne garde plus de créneau, 0 quand plus rien n'est à jouer). L591 : un lot qui attend son tour d'intégration non plus. L520 : un lot qui attend une dépendance ou qui est dans la porte de tests (`gate`, aucune session claude) n'en tient pas. Absent (undefined) tant qu'aucun lot ne joue dans un worktree : le calcul reste celui des dépôts tenus. */
  const lanes = (): number | undefined => ctxs.some((c) => c.tree) ? groupLots(ctxs).filter((g) => g.every((c) => lotRepoPaths(c.lot).every((r) => !freed.has(r)))).reduce((n, g) => { const todo = g.filter((c) => !settled.has(c) && !c.lot.gate && !c.waitsTurn && !awaitsDependency(c, ctxs, all)).length; return n + (g.every((c) => c.tree) ? todo : Math.min(1, todo)); }, 0) : undefined; // hors mode worktree, rien n'est écrit : le registre compte les dépôts tenus, comme avant L279
  const { freeRepo, release, claimRepo } = repoHolds({ waveId: wave.id, home, held, freed, repos, shared, lanes, log: (line) => wctx.log(line) });

  for (const r of repos) {
    const file = join(sharedStateDir(r), REPO_LOCK);
    const l = takeLock(file, { pid: process.pid, wave: wave.id, started: new Date().toISOString() });
    // Le verrou déjà à ce pid : pris par la reprise qui a attendu l'autre vague (L443).
    if (!l.ok && l.held.pid !== process.pid) {
      io.err(`orchestrate : ${heldRefusal(r, l.held)}`);
      release();
      return 2;
    }
    held.push(file);
    if (l.ok && l.stale) io.err(`orchestrate : verrou de dépôt périmé retiré (${basename(r)}, pid ${l.stale.pid} mort)`);
    const hook = installPrePush(r, wave.id);
    if (!hook.ok) {
      io.err(`orchestrate : ${basename(r)} : ${hook.reason}`);
      release();
      return 2;
    }
  }

  try {
    registerWave(home, { pid: process.pid, wave: wave.id, started: new Date().toISOString(), cwd: launch, repos, cap });
  } catch (e) {
    release(); // verrous et hooks ne restent pas posés si le démarrage échoue
    throw e;
  }

  // Plafond de sessions simultanées, toutes vagues confondues : chaque session attend un créneau libre avant de partir (L591 : sauf celle d'un lot repris à son tour d'intégration, `resumesTurn`).
  const claude: ClaudeFn = (argv, o) => slotGuarded({ home, cap, wave, all, launch, args, deps, store, ctxs: () => ctxs, log: (line) => wctx.log(line) }, argv, o);
  const budget = new Budget(wave.budget);
  budget.consumed = wave.consumed;
  budget.cacheRead = wave.cacheRead;
  const saveWave = () => {
    wave.consumed = budget.consumed;
    wave.cacheRead = budget.cacheRead;
    wave.budget = budget.limit;
    store.writeWave(wave);
  };
  // Part de la machine de chaque session (L350) : recalculée à chaque (re)prise, le plafond peut avoir changé.
  wave.testWorkers = testWorkersFrom(io.env, (deps.cores ?? availableParallelism)(), cap);
  const wctx: WaveCtx = {
    id: wave.id,
    store,
    budget,
    claude,
    agents: agentsOf(deps),
    today,
    claudeHome: deps.claudeHome,
    templates,
    testWorkers: wave.testWorkers,
    quota: { hit: false },
    incident: null,
    log: (line) => {
      io.out(line);
      store.journal(line);
    },
    saveWave,
    slotsChanged: () => updateWaveReposSafe(home, repos.filter((x) => !freed.has(x)), lanes()),
    integrate: deps.integrate,
    claimRepo,
  };
  wave.status = 'running';
  wave.pid = process.pid;
  saveWave();
  const ctxs = contexts(lots, envs, wctx, wave);
  planTrees(ctxs, store, wave.id, wctx.log, cap > 1);
  updateWaveReposSafe(home, repos, lanes());

  const queue = QueueRun.of(wave, launch, deps);
  const adds = new AddFeed({
    store, wave, wctx, io, deps, launch, ctxs, all, lots, held, freed, repos, freeRepo, saveWave, checks: LAUNCH_CHECKS,
    stopCause: () => stopCauseOf(wctx, budget, store),
    budgetLeft: () => budget.limit - budget.consumed,
    planState: planStateOf,
    announce: () => updateWaveReposSafe(home, repos.filter((x) => !freed.has(x)), lanes()),
    build: (t, known, ask) => buildAdd(t, known, ask, { wave: wave.id, ctxs, wctx, store, io, deps, launch, multiSlot: cap > 1 }),
    queue: queue.hooks(wctx.log),
  });

  // Ctrl-C, SIGTERM : les sessions sont tuées en bloc, les étapes marquées interrompues, les verrous et hooks libérés.
  const forget = onTermination(async () => {
    killSessions();
    await stopApps(); // les applications de la revue UX : SIGTERM, SIGKILL après 10 s
    for (const c of ctxs) {
      for (const s of c.lot.steps) {
        if (s.status === 'running') s.status = 'interrupted';
        // Les tokens d'une session tuée comptent : relus dans son journal.
        if (s.status === 'interrupted') countInterrupted(deps.claudeHome, workDir(c), s, budget);
      }
      if (c.lot.status === 'implementing' || c.lot.status === 'reviewing' || c.lot.status === 'fixing') c.lot.status = 'suspended';
      store.writeLot(c.lot);
      // Le TMPDIR court de la session tuée (L243) est hors de la vague : sans cela il resterait dans /tmp.
      try {
        store.removeTmpDir(c.lot.project, c.lot.lot);
      } catch {
        // nettoyage de confort
      }
    }
    wave.status = 'interrupted';
    saveWave();
    release();
  });
  const finished = lotFinished;
  /** Les lots que le créneau libre peut recevoir : la file approuvée (L498), puis les lots prêts du plan (L527, rien avec `--no-fill`, L587). */
  const refill = (canRun: (c: LotCtx) => boolean, vacantLanes: number): Promise<LotCtx[]> => refillFreeLanes({ facts: { args, io, launch, home, store, all, budget, quotaHit: wctx.quota.hit, incident: !!wctx.incident }, args, io, say: sayTo(io, store), cap, queue, adds, deps, log: wctx.log }, canRun, vacantLanes);
  try {
    await runPool(ctxs, cap, all, (c) => {
      // Un lot rendu ou en échec garde son worktree et sa branche (R12) : le journal en donne le chemin.
      if (c.tree?.active && c.lot.status !== 'ready') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : worktree conservé : ${c.tree.dir} (branche ${c.tree.branch})`);
      // Un lot rendu à l'étape d'intégration (`next: integrate`) : la ligne donne la commande qui le reprend (L279, R27).
      if (c.tree?.active && c.lot.status === 'handed-back' && c.lot.next === 'integrate') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : rendu à l'intégration : reprise par ${resumeCommand(wctx.id, '--integrate', lotKey(c.lot.project, c.lot.lot))}`);
      // Un dépôt dont tous les lots de la vague (reprise comprise) sont prêts ou rendus peut être livré pendant que la vague continue ailleurs.
      settled.add(c);
      updateWaveReposSafe(home, repos.filter((x) => !freed.has(x)), lanes());
      if (wctx.incident) return;
      for (const r of lotRepoPaths(c.lot)) {
        if (held.includes(join(sharedStateDir(r), REPO_LOCK)) && all.filter((l) => lotRepoPaths(l).includes(r)).every(finished)) freeRepo(r);
      }
    }, (lots) => lots.every((c) => c.tree), {
      pollMs: deps.slotPollMs ?? ANSWER_POLL_MS,
      // L407 : les réponses déposées par `--answer` pendant la vague sont prises entre deux étapes ; un lot qui n'est plus en question ne rejoue rien.
      take: async (canRun, vacantLanes) => {
        const taken: LotCtx[] = [];
        for (const e of store.answerQueue()) {
          const c = ctxs.find((x) => lotKey(x.lot.project, x.lot.lot) === e.lot);
          const why = !c ? 'lot inconnu' : c.lot.status !== 'question' ? `le lot n'attend plus de réponse (${c.lot.status})` : c.lot.pendingAnswer ? 'une réponse est déjà en cours de jeu' : null;
          if (why) {
            wctx.log(`${e.lot} : réponse écartée (${why})`);
            store.markAnswerTaken(e.id);
          } else if (c && canRun(c)) {
            applyAnswer(c.lot, e.text);
            store.writeLot(c.lot);
            store.markAnswerTaken(e.id);
            wctx.log(`${e.lot} : réponse du lead prise, le lot repart`);
            // Le lot avait fini de jouer à sa question (`settled`) : il rejoue, il tient de nouveau un créneau — sans cela `lanes()` le sous-compte et le registre annonce un créneau libre de trop (L433).
            settled.delete(c);
            taken.push(c);
          }
        }
        // L670 : la réponse est notée sur le lot à ce tour (prise ici, ou déposée par --resume --answer), pas au départ de sa session suivante, qui peut attendre un créneau longtemps (L477 : 18,6 min).
        await noteTakenAnswers(ctxs);
        // L532 : les intégrations déposées par `--resume --integrate` pendant la vague sont reprises de la même façon, au tour où le lot peut jouer.
        taken.push(...(await takeIntegrations({ store, ctxs, wctx, settled }, canRun)));
        if (taken.length) {
          try {
            updateWaveRepos(home, process.pid, repos.filter((x) => !freed.has(x)), lanes());
          } catch {
            // registre illisible : le décompte reste celui du dernier écrit
          }
        }
        const added = await adds.take(canRun);
        return [...taken, ...added, ...(await refill(canRun, vacantLanes - taken.length - added.length))];
      },
    });
    // L421 : un ajout encore en file quand plus rien ne joue ne sera plus lu : écarté et dit.
    adds.drain('la vague a fini de jouer');
    handBackDroppedQuestions(ctxs); // un lot en question retiré pendant la vague : rendu avant de fixer le statut de la vague
  } finally {
    forget();
    // « done » = plus rien à reprendre : une question en attente ou un lot suspendu garde la vague reprenable. Des lots suspendus parce qu'une revue a sali leur dépôt (L133), budget intact, ne sont pas un manque de budget : « interrupted », le lead nettoie puis reprend.
    wave.status = wctx.incident ? 'interrupted' : wctx.quota.hit ? 'suspended-quota' : lots.some((l) => l.status === 'suspended') && (budget.exhausted || !wctx.dirtyRepos?.size) && (budget.exhausted || !store.control().stopAfterCurrent) ? 'suspended-budget' : all.every(finished) ? 'done' : 'interrupted';
    saveWave();
    release();
  }
  if (wctx.incident) io.err(`orchestrate : incident — ${wctx.incident}`);
  if (wctx.quota.hit) io.err(`orchestrate : quota atteint — ${quotaText(wctx.quota.message ?? '')}`.trim());
  for (const line of renderTable(wave, all, { ...launchCost(launch, (w) => io.err(`orchestrate : ${w}`)) })) io.out(line);
  for (const line of [...keptLines(all.map((l) => l.repo)), ...endOfWaveLines(store.dir, io.err)]) io.out(line); // les worktrees conservés, avec leur chemin (R19), puis l'inspection des travaux de la vague (L627)
  if (wave.status === 'suspended-budget' || wave.status === 'suspended-quota') return 3;
  return all.every((l) => l.status === 'ready') ? 0 : 1;
}

/** Ce dont le remplissage d'un créneau libre a besoin de la vague en cours (`refillFreeLanes`). */
interface RefillScene {
  facts: FillFacts;
  args: Args;
  io: OrchestrateIo;
  /** Les lignes de la file : sortie (d'erreur pour un avertissement) et journal. */
  say: Say;
  cap: number;
  queue: QueueRun;
  adds: AddFeed;
  deps: OrchestrateDeps;
  log: (line: string) => void;
}

/**
 * Un créneau libéré en cours de vague : la file approuvée d'abord (L498, R19, toute vague vivante, sans option ; `queueFill`), puis les lots prêts du plan (L527, L587 : rien avec `--no-fill`) ;
 * `adds.fill` les contrôle et les prend. Un lot qui attend dans la file n'est pas tiré du plan ; une file illisible ne laisse pas le plan passer devant elle à ce créneau (R16).
 */
async function refillFreeLanes(r: RefillScene, canRun: (c: LotCtx) => boolean, vacantLanes: number): Promise<LotCtx[]> {
  if (vacantLanes <= 0) return [];
  const first = await queueFill(r.queue, { ...r.facts, cap: r.cap }, vacantLanes, { fill: (plan, lanes, can) => r.adds.fill(plan, lanes, can), canRun, push: pushToWaveWith(r.deps, r.io) });
  r.queue.emit(r.say);
  const left = vacantLanes - first.added.length - first.pushed; // R20 : un lot poussé tient un créneau tant que la receveuse ne l'a pas pris
  if (left <= 0 || first.down || !fillsFreeSlots(r.args)) return first.added;
  return [...first.added, ...(await r.adds.fill(fillTargetsSafe({ ...r.facts, exclude: first.waiting }, r.log), left, canRun))];
}

/** Pourquoi la vague ne prend plus de lot (incident, limite d'usage, budget épuisé, arrêt demandé), ou null. */
const stopCauseOf = (wctx: WaveCtx, budget: Budget, store: RunStore): string | null => (wctx.incident ? 'incident' : wctx.quota.hit ? "limite d'usage atteinte" : budget.exhausted ? 'budget de la vague épuisé' : store.control().stopAfterCurrent ? "la vague s'arrête" : null);

/** Pourquoi le lot ne se joue plus d'après son plan (fini entre-temps, disparu, plan illisible), ou null. */
function planStateOf(c: LotCtx): string | null {
  try {
    const lot = projectEnv(c.lot.repo).loadPlan().lots().find((l) => l.id === c.lot.lot);
    return !lot ? 'lot inconnu' : !isOpen(lot.status) ? `le lot est ${lot.status}` : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Ce que l'attente d'un créneau de session a besoin de la vague (`slotGuarded`). */
interface SlotScene {
  home: string;
  cap: number;
  wave: WaveState;
  all: LotState[];
  launch: string;
  args: Args;
  deps: OrchestrateDeps;
  store: RunStore;
  ctxs: () => LotCtx[];
  log: (line: string) => void;
}

/** La session attend un créneau libre avant de partir (plafond commun à toutes les vagues), sauf celle d'un lot repris à son tour d'intégration (L591) ; une demande d'arrêt ou de retrait écrite pendant l'attente l'interrompt (L332). */
async function slotGuarded(s: SlotScene, argv: string[], o: Parameters<ClaudeFn>[1]): ReturnType<ClaudeFn> {
  const free = resumesTurn(s.ctxs(), o.lot, s.log) ? () => {} : await acquireSlot(s.home, s.cap, { wave: s.wave.id, ...slotPlace(s.all, s.launch, s.args.priority, o.lot), // L531 : place dans la file des créneaux, commune aux vagues
    pollMs: s.deps.slotPollMs,
    abandon: () => {
      const ctl = s.store.control();
      if (o.lot && ctl.drops.includes(o.lot)) return DROPPED;
      return ctl.stopAfterCurrent ? STOP_REQUESTED : null;
    },
    onWait: (h, ms, limit, lead) => {
      const who = [...new Set(h.map((x) => x.wave)), ...lead.map((x) => `session du lead ${x.label}`)];
      s.log(`${o.lot ? `${o.lot} · ` : ''}en attente d'un créneau de session depuis ${duration(ms)} (${h.length + lead.length}/${limit} en cours : ${who.join(', ')})`);
    },
    onGot: (ms) => s.log(`${o.lot ? `${o.lot} · ` : ''}créneau de session obtenu après ${duration(ms)} d'attente`),
  });
  try {
    return await s.deps.claude(argv, o);
  } finally {
    free();
  }
}

/**
 * L498 (R9) : la poussée d'un lot de la file dans la vague vivante `holder` qui tient son dépôt, par le mécanisme de `--add` (L421, `addToLive`) : même contrôle préalable qu'un `--add` tapé depuis le dossier de lancement
 * de cette vague, même dépôt dans sa file d'ajouts ; rien d'autre n'écrit dans son état (R18). Les refus sont rendus à l'appelant, pas imprimés.
 */
const pushToWaveWith = (deps: OrchestrateDeps, io: OrchestrateIo): PushToWave => async (t, holder, from) => {
  const store = RunStore.find(holder.cwd, holder.wave);
  if (!store) return { ok: false, refusals: [`dossier d'état de la vague ${holder.wave} introuvable`] };
  const refusals: string[] = [];
  const quiet: OrchestrateIo = { ...io, cwd: holder.cwd, out: () => {}, err: (line) => refusals.push(line.replace(/^orchestrate : /, '')) };
  const code = await addToLive({ ...parseOrchestrateArgs([]), add: [{ project: t.project, lot: t.lot }] }, { io: quiet, deps, launch: holder.cwd }, store, LAUNCH_CHECKS, from);
  const id = store.addQueue().find((e) => e.queue?.dir === from.dir && e.queue.key === from.key)?.id;
  return code === 0 && id !== undefined ? { ok: true, store, id } : { ok: false, refusals: refusals.length ? refusals : ['demande introuvable dans la file d’ajouts de la vague'] };
};

const LAUNCH_CHECKS: LaunchChecks = { resolveTargets, preflight: (targets, run, addTo, ask) => preflight({ dryRun: false, goal: ask?.goal }, targets, run.io, run.deps, run.launch, { addTo, raises: ask?.raises }) };

/** `--add` (L421) : la vague vivante de ce dossier reçoit les lots (le travail est dans `ajout.ts`). */
export async function addOnlyLive(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string): Promise<number> {
  const store = liveStore('--add', args, io);
  return typeof store === 'number' ? store : addToLive(args, { io, deps, launch }, store, LAUNCH_CHECKS);
}

/**
 * Le contexte d'un lot ajouté en cours de vague (L421) ou tiré par le remplissage d'un créneau libre (L527) : le contrôle préalable d'un lot de lancement (les lots de la vague comptent pour les dépendances), le lien du Node,
 * puis un worktree si son dépôt est en `worktrees: true` et la vague a plus d'un créneau (`multiSlot`), ou si tous les lots encore à jouer de son dépôt y sont ; sinon il attend la fin de ceux qui jouent dans l'arbre du dépôt.
 */
async function buildAdd(t: Target, known: KnownLot[], ask: AddAsk | undefined, w: { wave: string; ctxs: LotCtx[]; wctx: WaveCtx; store: RunStore; io: OrchestrateIo; deps: OrchestrateDeps; launch: string; multiSlot: boolean }): Promise<{ ctx: LotCtx } | { refusals: string[] }> {
  const pre = await LAUNCH_CHECKS.preflight([t], w, { wave: w.wave, lots: known }, ask);
  const lot = pre.lots[0];
  if (pre.refusals.length || !lot) return { refusals: pre.refusals };
  if (lot.node) lot.node.link = (w.deps.linkNode ?? linkNodeBin)(w.store.dir, lot.node.version, lot.node.bin);
  const ctx = contexts([lot], [projectEnv(lot.repo)], w.wctx)[0]!;
  const open = openInRepo(w.ctxs, ctx);
  planTrees(open.every((o) => o.tree) ? [...open, ctx] : [ctx], w.store, w.wave, w.wctx.log, w.multiSlot);
  return { ctx };
}

