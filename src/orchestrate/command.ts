import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { testWorkersFrom } from './workers.js';
import { basename, join } from 'node:path';
import { planLoader } from '../config.js';
import { isDay, toDay, type Day } from '../dates.js';
import { heldRefusal } from '../local-task.js';
import { onTermination } from '../proc.js';
import { stopApps } from './app.js';
import { RafError, isOpen } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { pidAlive, sharedStateDir } from '../state.js';
import { acquireSlot, cadenceHome, liveWaves, registerWave, unregisterWave, updateWaveRepos } from './registry.js';
import { loadTemplates } from './briefs.js';
import { readWaits, renderWaits } from './waits.js';
import { fillTargets, handedBackStreak, parseUntil, stopReason } from './continue.js';
import { Budget, DROPPED, STOP_REQUESTED, REVIEW_RESERVE, budgetStep, heldForEscalation, lotSpent, countInterrupted, planNoteHandBack, leadReviewedHandBack, HYPOTHESES_HANDBACK, handBackDroppedQuestions, workDir, type LotCtx, type WaveCtx } from './cycle.js';
import { installPrePush, keepGateGuard, removePrePush, snapshot } from './guard.js';
import { claudeConfigDir, killSessions, realClaude, type ClaudeFn, type SessionKind } from './launch.js';
import { activeLock, REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { groupLots, runPool } from './pool.js';
import { slotPlace } from './attente.js';
import { AddFeed, addNotAlone, addToLive, openInRepo, type KnownLot, type LaunchChecks } from './ajout.js';
import { trackedDirty } from './depot.js';
import { adoptLeadReview, depositIntegrations, depositsOnly, integrationText, runsElsewhere, takeIntegrations } from './integration-vivante.js';
import { removeWorktree } from './retrait.js';
import { repoBranch } from './integrate.js';
import { baseBranchOf, keptLines, lotBranch, lotTreeDir, planFileSet, recoverTree } from './worktree.js';
import { excludeState, lotFinished, lotKey, lotRepoPaths, RunStore, type LotState, type WaveState } from './state.js';
import { linkNodeBin, nvmVersionsDir, resolveNode, type NodeChoice } from './node-env.js';
import { estimateLines, launchPrices, quotaText, renderTable, resumeCommand } from './table.js';
import { PACKAGE_ROOT, RESERVED_ENV, SnapshotRefusal, isSnapshotChild, resolveModulesDir, repairSnapshotModules, snapshotExists, waveReadsIntegrate, waveReadsLotBudget, waveReadsReplay, withoutLaunchVars, spawnReexec, takeSnapshot, toolDirOf, type SnapshotDeps } from './snapshot.js';

import { agentsOf, preflight, projectEnv, resolveTargets, type Target } from './preflight.js';
export { preflight, projectEnv, resolveTargets, type Target } from './preflight.js';

import { continueDryRun, dryRun } from './dry-run.js';
import { draw, priorityOf } from './draw.js';

import { answerLive, answerOnly, control, duration, freeLines, liveStore, maxSessions, onceAuth, singleUnfinished, statusCommand, waveExists } from './status.js';
export { configuredCap, expiredHoldLines, liveLines, slotsLine } from './status.js';

export interface OrchestrateIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

export interface OrchestrateDeps {
  claude: ClaudeFn;
  /** Attente (ms) entre deux rendus de `--status --watch` ; défaut : une vraie attente. */
  watchSleep?: (ms: number) => Promise<void>;
  /** Intervalle (ms) d'attente d'un créneau de session libre ; défaut 2 s. */
  slotPollMs?: number;
  /** Version de claude et présence de --json-schema ; null si claude est absent. */
  claudeInfo: () => { version: string; jsonSchema: boolean } | null;
  /** Connexion de claude (`claude auth status`, sans modèle) ; null si l'état est illisible, absent : non vérifié (L378). */
  claudeAuth?: () => { loggedIn: boolean } | null;
  /** Un processus git tourne-t-il (L385) ? null s'il est illisible ; défaut : `ps` ; injectable pour les tests. */
  gitRunning?: () => boolean | null;
  agentsDir: string;
  templatesDir?: string;
  claudeHome?: string;
  /** Création du dossier de liens Node d'une vague ; défaut `linkNodeBin` (injectable pour simuler un échec). */
  linkNode?: typeof linkNodeBin;
  /** Version du `node` que trouve le PATH du programme (L351), null s'il n'y en a pas ; défaut : `node --version` ; injectable pour les tests. */
  pathNode?: () => string | null;
  /**
   * Instantané d'une vague (L61) : au vrai lancement, le paquet est copié dans `<vague>/tool/` et le processus se relance
   * depuis cette copie. Absent (tests, processus déjà relancé) : la vague tourne sur le paquet courant, sans copie.
   */
  snapshot?: SnapshotDeps;
  /** Cœurs de la machine (L350) : de quoi calculer la part de chaque session ; défaut `availableParallelism()`, injectable pour les tests. */
  cores?: () => number;
  /** Attente du verrou d'intégration du dépôt (L279, R25) : défauts 10 minutes et 1 s ; réglable pour les tests. */
  integrate?: { waitMs?: number; pollMs?: number };
  /** Attente, par `--resume --integrate`/`--replay`, du verrou de dépôt tenu par une autre vague vivante (L443) : défauts 3 heures et 5 s ; réglable pour les tests. */
  repoWait?: { waitMs?: number; pollMs?: number };
}

/** Attente (ms) entre deux lectures de la file de réponses d'une vague vivante (L407) quand aucune file de lots ne finit. */
export const ANSWER_POLL_MS = 2000;
const REPO_WAIT_MS = 3 * 60 * 60_000;
const REPO_WAIT_POLL_MS = 5_000;

export const DEFAULT_BUDGET = 2_000_000;

export { lotBudget, lotBudgetBasis, SPEC_STAGE_ALLOCATION, type SpecStage } from './lot-budget.js';
import { lotBudget, lotBudgetBasis, type SpecStage } from './lot-budget.js';

export { DEFAULT_MAX_SESSIONS, parseBudget, parseMaxSessions, parseOrchestrateArgs, type Args } from './command-args.js';
import { DEFAULT_MAX_SESSIONS, LOT_LIKE, parseBudget, parseMaxSessions, parseOrchestrateArgs, type Args } from './command-args.js';


const WAVE_ID_RE = /^[\w.-]+$/;

/** Identifiant par défaut : jour et minute de lancement ; le suffixe qui départage deux vagues vient de `RunStore.reserve`. */
function defaultWaveBase(io: OrchestrateIo): string {
  const n = io.now();
  return `${toDay(n)}-${String(n.getHours()).padStart(2, '0')}${String(n.getMinutes()).padStart(2, '0')}`;
}

/** Identifiant d'une simulation : le premier libre, sans rien réserver ni écrire. */
function waveId(io: OrchestrateIo, requested: string | undefined, launch: string): string {
  if (requested) return requested;
  const base = defaultWaveBase(io);
  let id = base;
  for (let i = 2; existsSync(join(RunStore.runsDir(launch), id)); i++) id = `${base}-${i}`;
  return id;
}




/** Point d'entrée de `cadence orchestrate`. 0 prêts · 1 rendus au lead · 2 refus avant d'agir · 3 suspendue (budget, quota). */
export async function orchestrate(argv: string[], io: OrchestrateIo, deps: OrchestrateDeps): Promise<number> {
  deps = onceAuth(deps);
  const args = parseOrchestrateArgs(argv);
  const launch = io.cwd;
  if (args.add.length && addNotAlone(args)) throw new RafError('--add ne se combine avec aucune autre action (seul --wave désigne la vague qui reçoit les lots)');
  const today: Day = io.env.RAF_TODAY && isDay(io.env.RAF_TODAY) ? io.env.RAF_TODAY : toDay(io.now());

  if ((args.until !== undefined || args.priority !== undefined) && !args.continue) throw new RafError('--until et --priority s\'utilisent avec --continue');
  if (args.until !== undefined) args.untilAt = parseUntil(args.until, io.now()); // heure invalide ou passée : refus avant d'agir
  if (args.continue) priorityOf(args, launch); // une clé priority: illisible du cadence.yaml : refus avant d'agir, lots donnés ou non
  if (args.watch && args.status === undefined) throw new RafError('--watch s\'utilise avec --status');
  if (args.detail !== undefined && args.status === undefined) throw new RafError('--detail s\'utilise avec --status');
  if (args.detail !== undefined && args.watch) throw new RafError('--detail ne se combine pas avec --watch (il donne le détail d\'un lot, pas le tableau)');
  if (args.interval !== undefined && !args.watch) throw new RafError('--interval s\'utilise avec --status --watch');
  // --drop / --stop-after-current (L79) pilotent une vague VIVANTE : ni avec --status (rien à piloter), ni --stop-after-current avec --resume (il le contredit). --resume --drop retire le lot avant de rejouer la vague arrêtée.
  if (args.status !== undefined && (args.drop.length || args.stopAfterCurrent)) throw new RafError('--status ne se combine pas avec --drop / --stop-after-current');
  if (args.resume !== undefined && args.stopAfterCurrent) throw new RafError('--resume ne se combine pas avec --stop-after-current (il reprend la vague, il ne l\'arrête pas)');
  // L228 : la reprise n'a pas de simulation — elle relève le budget, réécrit wave.json et relance les sessions. Refusée ici, avant le réexec de l'instantané (une vague ancienne ne connaît pas ce refus).
  // L309 : la reprise rejoue les lots de la vague ; des lots à lancer seraient ignorés en silence (--continue, lui, tire la suite du plan après la reprise : L147).
  if (args.resume !== undefined && args.lots.length) {
    // Un id de vague qui ressemble à un lot (`--resume suite2`) est lu comme un lot à lancer : le refus donne la forme qui le désigne comme vague.
    const asWave = args.lots.find((l) => l.project === undefined && l.model === undefined && RunStore.find(launch, l.lot));
    const hint = asWave ? `« ${asWave.lot} » est une vague de ce dossier : ${resumeCommand(asWave.lot)}` : `pour désigner la vague : ${resumeCommand('<vague>')}`;
    throw new RafError(`--resume ne se combine pas avec des lots à lancer (il reprend les lots de la vague ; --answer, --drop, --integrate, --replay et --budget projet:lot=+N nomment ceux qu'ils visent) ; ${hint}`);
  }
  if (args.resume !== undefined && args.dryRun) throw new RafError('--resume ne se combine pas avec --dry-run (la reprise écrit l\'état de la vague et relance les sessions, elle ne se simule pas)');
  if (args.lotBudgets.length && args.resume === undefined) throw new RafError("--budget projet:lot=+N ne vaut qu'avec --resume");
  // L279 : --integrate rejoue une intégration rendue, donc une vague arrêtée ; --abandon-commits ne vaut qu'avec --remove-worktree.
  if (args.integrate.length && args.resume === undefined) throw new RafError(`${args.integrate.some((t) => !t.replay) ? '--integrate' : '--replay'} ne vaut qu'avec --resume`);
  if (args.abandonCommits && !args.removeWorktree) throw new RafError("--abandon-commits ne vaut qu'avec --remove-worktree");
  if (args.removeWorktree && (args.lots.length || args.resume !== undefined || args.status !== undefined || args.continue || args.dryRun || args.drop.length || args.stopAfterCurrent || args.waits)) throw new RafError("--remove-worktree ne se combine avec aucune autre action");
  // L258 : l'objectif donné ne vaut que pour UN lot lancé (la clé goal: du lot sert quand plusieurs partent ; --continue tire ses lots lui-même).
  if (args.goal !== undefined && (args.lots.length !== 1 || args.continue || args.resume !== undefined || args.status !== undefined || args.waits || args.drop.length || args.stopAfterCurrent)) throw new RafError("--goal s'applique à un seul lot lancé : <projet>:<lot> --goal \"…\" (plusieurs lots : la clé goal: de chacun)");
  if (args.since !== undefined && !args.waits) throw new RafError('--since s\'utilise avec --waits');
  if (args.waits) {
    if (args.lots.length || args.status !== undefined || args.resume !== undefined || args.watch || args.drop.length || args.stopAfterCurrent || args.continue || args.dryRun) throw new RafError('--waits ne se combine avec aucune autre action');
    for (const line of renderWaits(readWaits(launch, args.since))) io.out(line);
    return 0;
  }
  if (args.status !== undefined) return statusCommand(args, io, deps, launch);
  if (args.removeWorktree) return removeWorktree(args, io);
  if (args.resume !== undefined) return resume(args, argv, io, deps, launch, today);
  if (args.add.length) return addOnlyLive(args, io, deps, launch);
  if (args.drop.length || args.stopAfterCurrent) return control(args, io);
  if (args.answers.length) return answerOnly(args, io);

  if (args.lots.length === 0 && !args.continue) throw new RafError('usage : cadence orchestrate <projet>:<lot>… [--budget 2M] [--max-sessions 2] [--dry-run] [--continue [--until 18:00] [--priority a,b]] | --waits [--since AAAA-MM-JJ] | --status [vague] [--detail projet:lot | --watch [--interval 10]] | --resume [vague] [--answer projet:lot "réponse"] [--integrate projet:lot] [--replay projet:lot] | --add projet:lot [--wave vague] | --drop projet:lot | --stop-after-current | --remove-worktree projet:lot [--abandon-commits]');
  const refusals: string[] = [];
  const targets = resolveTargets(args, io, refusals);
  const pre = await preflight(args, targets, io, deps, launch);
  refusals.push(...pre.refusals);
  const budget = args.budget ?? DEFAULT_BUDGET;
  const firstSkipped: string[] = [];
  // --continue sans lot donné : le premier tour est tiré du plan ; rien de prêt, ou tout refusé, vaut un refus avant d'agir.
  if (args.continue && args.lots.length === 0 && refusals.length === 0) {
    const first = await draw(args, io, deps, launch, new Set(), budget, maxSessions(args, io));
    pre.lots.push(...first.lots);
    firstSkipped.push(...first.skipped);
    refusals.push(...(first.lots.length ? [] : first.skipped.length ? first.skipped : ['--continue : aucun lot prêt dont l\'estimation tient dans le budget']));
  }
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  if (args.wave !== undefined && !WAVE_ID_RE.test(args.wave)) throw new RafError(`--wave invalide : ${args.wave}`);
  if (args.dryRun) {
    const id = waveId(io, args.wave, launch);
    if (args.wave && existsSync(join(RunStore.runsDir(launch), id))) return waveExists(args.wave, io);
    dryRun(pre.lots, io, deps, { budget, id, multiSlot: maxSessions(args, io) > 1 });
    for (const l of [...estimateLines(pre.lots, launch, (w) => io.err(`orchestrate : ${w}`)), ...(args.continue ? freeLines(launch, pre.lots) : [])]) io.out(l);
    if (args.continue) await continueDryRun(args, io, deps, launch, pre.lots, budget, firstSkipped);
    return 0;
  }
  if (deps.snapshot) {
    // Refus avant de réserver la vague : rien n'est créé si les dépendances ne se résolvent pas.
    try {
      resolveModulesDir(deps.snapshot.packageRoot);
    } catch (e) {
      if (!(e instanceof SnapshotRefusal)) throw e;
      io.err(`orchestrate : ${e.message}`);
      return 2;
    }
  }
  // Processus relancé depuis l'instantané : la vague a déjà été réservée par le processus d'origine.
  const reserved = deps.snapshot ? undefined : io.env[RESERVED_ENV];
  const store = reserved ? new RunStore(launch, reserved) : RunStore.reserve(launch, args.wave ?? defaultWaveBase(io), { exact: args.wave !== undefined });
  if (!store) return waveExists(args.wave!, io);
  if (deps.snapshot) {
    try {
      const tool = takeSnapshot(store.dir, deps.snapshot.packageRoot);
      const code = await deps.snapshot.reexec(tool, argv, { ...io.env, [RESERVED_ENV]: store.id }, io);
      if (!existsSync(join(store.dir, 'wave.json'))) rmSync(store.dir, { recursive: true, force: true });
      return code;
    } catch (e) {
      rmSync(store.dir, { recursive: true, force: true });
      if (e instanceof SnapshotRefusal) {
        io.err(`orchestrate : ${e.message}`);
        return 2;
      }
      throw e;
    }
  }
  const id = store.id;
  if (args.continue) for (const l of freeLines(launch, pre.lots)) io.out(l);
  // Les candidats refusés au premier tirage : leur cause dit pourquoi ils ne jouent pas (même ligne que celles des tirages suivants).
  for (const s of firstSkipped) {
    io.err(`orchestrate : lot sauté — ${s}`);
    store.journal(`continue : lot sauté — ${s}`);
  }
  const wave: WaveState = { id, created: io.now().toISOString(), cwd: launch, budget, consumed: 0, cacheRead: 0, status: 'running', pid: process.pid, lots: pre.lots.map((l) => lotKey(l.project, l.lot)) };
  // Une vague qui n'a pas atteint `wave.json` (refus au verrou, démarrage en échec) ne laisse pas son dossier réservé :
  // le même `--wave` se relance, et `reserve` ne le prend pas pour une vague existante.
  const abandon = () => {
    if (!existsSync(join(store.dir, 'wave.json'))) rmSync(store.dir, { recursive: true, force: true });
  };
  try {
    // Dans la section gardée : un lien ou une écriture qui échoue ne laisse pas la vague réservée sans wave.json.
    for (const l of pre.lots) {
      if (l.node) l.node.link = (deps.linkNode ?? linkNodeBin)(store.dir, l.node.version, l.node.bin);
      store.writeLot(l);
    }
    const code = await continueRounds(await execute(wave, pre.lots, store, io, deps, today, args), wave, pre.lots, store, io, deps, today, args, launch);
    abandon();
    return code;
  } catch (e) {
    abandon();
    throw e;
  }
}



/** Nombre de tours que la simulation de `--dry-run --continue` déroule au plus. */

/**
 * `--continue` (L147) : tant qu'aucune borne ne joue, tire jusqu'à `cap` lots prêts du plan et les joue dans la même vague
 * (même budget, même dossier d'état). Sans `--continue`, rend le code tel quel. Bornes : budget, `--until`, limite d'usage,
 * question posée, deux lots rendus de suite, vague interrompue, plus de lot prêt dont l'estimation tient dans le budget restant.
 */
async function continueRounds(first: number, wave: WaveState, all: LotState[], store: RunStore, io: OrchestrateIo, deps: OrchestrateDeps, today: Day, args: Args, launch: string): Promise<number> {
  if (!args.continue || first === 2) return first; // 2 : refus au verrou, rien n'a tourné
  const say = (line: string) => {
    io.out(line);
    store.journal(line);
  };
  const exclude = new Set(all.map((l) => lotKey(l.project, l.lot)));
  const cap = maxSessions(args, io);
  let code = first;
  for (;;) {
    for (const l of all) exclude.add(lotKey(l.project, l.lot)); // L421 : les lots ajoutés à la main pendant la vague ne sont pas tirés une seconde fois
    const questions = all.filter((l) => l.status === 'question').length;
    const remaining = wave.status === 'suspended-budget' ? 0 : wave.budget - wave.consumed;
    const why = stopReason({ now: io.now(), until: args.untilAt, quotaHit: wave.status === 'suspended-quota', questions, streak: handedBackStreak(all), interrupted: wave.status === 'interrupted' && questions === 0, stopRequested: store.control().stopAfterCurrent, remaining });
    if (why) {
      say(`continue : arrêt — ${why}`);
      return code;
    }
    const drawn = await draw(args, io, deps, launch, exclude, remaining, cap);
    for (const s of drawn.skipped) say(`continue : lot sauté — ${s}`);
    if (drawn.lots.length === 0) {
      say("continue : arrêt — plus aucun lot prêt dont l'estimation tient dans le budget restant");
      return code;
    }
    for (const l of drawn.lots) {
      if (l.node) l.node.link = (deps.linkNode ?? linkNodeBin)(store.dir, l.node.version, l.node.bin);
      store.writeLot(l);
      wave.lots.push(lotKey(l.project, l.lot));
    }
    store.writeWave(wave);
    all.push(...drawn.lots);
    say(`continue : tire ${drawn.lots.map((l) => lotKey(l.project, l.lot)).join(', ')}`);
    code = await execute(wave, drawn.lots, store, io, deps, today, args, all);
    if (code === 2) return code;
  }
}

function contexts(lots: LotState[], envs: ReturnType<typeof projectEnv>[], wctx: WaveCtx): LotCtx[] {
  return lots.map((lot, i) => ({ wave: wctx, lot, config: envs[i].config, loadPlan: envs[i].loadPlan }));
}

/**
 * Quels lots jouent dans un worktree (L279). Un groupe de lots du même dépôt (`groupLots`) y joue si `orchestrate.worktrees` est vrai, s'il a au moins deux lots
 * ou si la vague a plus d'un créneau (`multiSlot`, L527 : tout lot d'un tel dépôt reçoit son worktree — donné seul, tiré par le remplissage ou apporté par `--add`, avec ou sans `--continue` — pour qu'un créneau libre reçoive le lot suivant du même dépôt), si le dépôt est sur une branche et si aucun de ses lots n'a de dépôt voisin (`repos:`, R2) ; sinon les lots restent à la suite, avec un avertissement qui dit pourquoi.
 * Un lot dont la branche existe déjà (reprise, R11) retrouve son worktree quel que soit le groupe ; un lot rendu à l'intégration dont la branche a disparu n'en reçoit pas. La branche de départ est celle du dépôt du lead à cet instant,
 * ou celle que la branche du lot a notée à sa création.
 */
function planTrees(ctxs: LotCtx[], store: RunStore, wave: string, log: (line: string) => void, multiSlot: boolean): void {
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
      const recovered = !baseBranchOf(repo, lotBr) && c.lot.next !== 'integrate' && branch && c.config.worktrees ? recoverTree(repo, lotBr, dir, branch, planFileSet(c.loadPlan(), repo)) : null;
      if (recovered && 'refused' in recovered) log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : branche ${recovered.from} d'une vague précédente non reprise : ${recovered.refused} ; le lot repart de zéro (à nettoyer à la main, ou intégration à la main documentée)`);
      else if (recovered) {
        log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : branche ${recovered.from} d'une vague précédente reprise (${recovered.unintegrated} commit(s) non intégré(s)) : le lot repart de son travail`);
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

/** Pose les verrous et les hooks, joue la vague, range l'état, rend le tableau et le code de sortie. */
async function execute(wave: WaveState, lots: LotState[], store: RunStore, io: OrchestrateIo, deps: OrchestrateDeps, today: Day, args: Args, all: LotState[] = lots): Promise<number> {
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
  const repos = [...new Set(lots.flatMap(lotRepoPaths))];
  /** Libère un dépôt : son verrou et sa garde de push (L132 : dès que ses lots sont finis, pas à la fin de la vague). */
  const freed = new Set<string>();
  /** Lots dont la vague a fini de jouer (prêts, rendus, en échec ou suspendus) : ils ne tiennent plus de créneau. */
  const settled = new Set<LotCtx>();
  /** Lots que la vague a encore à jouer, en cours ou en attente, sur les dépôts qu'elle tient encore (un par dépôt, un par lot en worktree) : ce que le registre compte pour les créneaux libres (L433 : un lot fini ne garde plus de créneau, 0 quand plus rien n'est à jouer). Absent (undefined) tant qu'aucun lot ne joue dans un worktree : le calcul reste celui des dépôts tenus. */
  const lanes = (): number | undefined => ctxs.some((c) => c.tree) ? groupLots(ctxs).filter((g) => g.every((c) => lotRepoPaths(c.lot).every((r) => !freed.has(r)))).reduce((n, g) => { const todo = g.filter((c) => !settled.has(c)).length; return n + (g.every((c) => c.tree) ? todo : Math.min(1, todo)); }, 0) : undefined; // hors mode worktree, rien n'est écrit : le registre compte les dépôts tenus, comme avant L279
  const freeRepo = (r: string) => {
    freed.add(r);
    const file = join(sharedStateDir(r), REPO_LOCK);
    releaseLock(file, process.pid);
    held.splice(0, held.length, ...held.filter((f) => f !== file));
    removePrePush(r, wave.id);
    keepGateGuard(r);
    try {
      updateWaveRepos(home, process.pid, repos.filter((x) => !freed.has(x)), lanes());
    } catch {
      // registre illisible : `--status` garde la liste de départ, le verrou est bien tombé
    }
  };
  const release = () => {
    for (const f of held) releaseLock(f, process.pid);
    held.length = 0;
    for (const r of repos) {
      if (freed.has(r)) continue;
      removePrePush(r, wave.id);
      keepGateGuard(r);
    }
    try {
      unregisterWave(home, process.pid);
    } catch {
      // registre illisible : l'entrée d'un processus mort est écartée à la prochaine inscription
    }
  };

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

  // Plafond de sessions simultanées, toutes vagues confondues : chaque session attend un créneau libre avant de partir.
  const claude: ClaudeFn = async (argv, o) => {
    const free = await acquireSlot(home, cap, { wave: wave.id, ...slotPlace(all, launch, args.priority, o.lot), // L531 : place dans la file des créneaux, commune aux vagues
      pollMs: deps.slotPollMs,
      // L332 : une demande écrite pendant l'attente (`--drop` de ce lot, `--stop-after-current`) l'interrompt ; la session ne part pas.
      abandon: () => {
        const ctl = store.control();
        if (o.lot && ctl.drops.includes(o.lot)) return DROPPED;
        return ctl.stopAfterCurrent ? STOP_REQUESTED : null;
      },
      onWait: (h, ms, limit, lead) => {
        const who = [...new Set(h.map((x) => x.wave)), ...lead.map((x) => `session du lead ${x.label}`)];
        wctx.log(`${o.lot ? `${o.lot} · ` : ''}en attente d'un créneau de session depuis ${duration(ms)} (${h.length + lead.length}/${limit} en cours : ${who.join(', ')})`);
      },
      onGot: (ms) => wctx.log(`${o.lot ? `${o.lot} · ` : ''}créneau de session obtenu après ${duration(ms)} d'attente`),
    });
    try {
      return await deps.claude(argv, o);
    } finally {
      free();
    }
  };
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
    integrate: deps.integrate,
  };
  wave.status = 'running';
  wave.pid = process.pid;
  saveWave();
  const ctxs = contexts(lots, envs, wctx);
  planTrees(ctxs, store, wave.id, wctx.log, cap > 1);
  try {
    updateWaveRepos(home, process.pid, repos, lanes());
  } catch {
    // registre illisible : le décompte des créneaux libres reste celui des dépôts
  }

  const adds = new AddFeed({
    store, wave, wctx, io, deps, launch, ctxs, all, lots, held, freed, repos, freeRepo, saveWave, checks: LAUNCH_CHECKS,
    stopCause: () => (wctx.incident ? 'incident' : wctx.quota.hit ? "limite d'usage atteinte" : budget.exhausted ? 'budget de la vague épuisé' : store.control().stopAfterCurrent ? "la vague s'arrête" : null),
    budgetLeft: () => budget.limit - budget.consumed,
    planState: (c) => {
      try {
        const lot = projectEnv(c.lot.repo).loadPlan().lots().find((l) => l.id === c.lot.lot);
        return !lot ? 'lot inconnu' : !isOpen(lot.status) ? `le lot est ${lot.status}` : null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    announce: () => updateWaveReposSafe(home, repos.filter((x) => !freed.has(x)), lanes()),
    build: (t, known) => buildAdd(t, known, { wave: wave.id, ctxs, wctx, store, io, deps, launch, multiSlot: cap > 1 }),
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
  /** L527 : les lots prêts du plan que le créneau libre peut recevoir (rien sans `--continue`) ; `adds.fill` les contrôle et les prend. */
  const refill = async (canRun: (c: LotCtx) => boolean, free: number): Promise<LotCtx[]> =>
    args.continue && free > 0 ? adds.fill(fillTargets({ args, io, launch, home, store, all, budget, quotaHit: wctx.quota.hit, incident: !!wctx.incident }), free, canRun) : [];
  try {
    await runPool(ctxs, cap, all, (c) => {
      // Un lot rendu ou en échec garde son worktree et sa branche (R12) : le journal en donne le chemin.
      if (c.tree?.active && c.lot.status !== 'ready') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : worktree conservé : ${c.tree.dir} (branche ${c.tree.branch})`);
      // Un lot rendu à l'étape d'intégration (`next: integrate`) : la ligne donne la commande qui le reprend (L279, R27).
      if (c.tree?.active && c.lot.status === 'handed-back' && c.lot.next === 'integrate') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : rendu à l'intégration : reprise par ${resumeCommand(wctx.id, '--integrate', lotKey(c.lot.project, c.lot.lot))}`);
      // Un dépôt dont tous les lots de la vague (reprise comprise) sont prêts ou rendus peut être livré pendant que la vague continue ailleurs.
      settled.add(c);
      try {
        updateWaveRepos(home, process.pid, repos.filter((x) => !freed.has(x)), lanes());
      } catch {
        // registre illisible : le décompte reste celui du dernier écrit
      }
      if (wctx.incident) return;
      for (const r of lotRepoPaths(c.lot)) {
        if (held.includes(join(sharedStateDir(r), REPO_LOCK)) && all.filter((l) => lotRepoPaths(l).includes(r)).every(finished)) freeRepo(r);
      }
    }, (lots) => lots.every((c) => c.tree), {
      pollMs: deps.slotPollMs ?? ANSWER_POLL_MS,
      // L407 : les réponses déposées par `--answer` pendant la vague sont prises entre deux étapes ; un lot qui n'est plus en question ne rejoue rien.
      take: async (canRun, free) => {
        const taken: LotCtx[] = [];
        for (const e of store.answerQueue()) {
          const c = ctxs.find((x) => lotKey(x.lot.project, x.lot.lot) === e.lot);
          const why = !c ? 'lot inconnu' : c.lot.status !== 'question' ? `le lot n'attend plus de réponse (${c.lot.status})` : c.lot.pendingAnswer ? 'une réponse est déjà en cours de jeu' : null;
          if (why) {
            wctx.log(`${e.lot} : réponse écartée (${why})`);
            store.markAnswerTaken(e.id);
          } else if (c && canRun(c)) {
            c.lot.pendingAnswer = e.text;
            c.lot.answers.push(e.text);
            c.lot.questions = [];
            store.writeLot(c.lot);
            store.markAnswerTaken(e.id);
            wctx.log(`${e.lot} : réponse du lead prise, le lot repart`);
            // Le lot avait fini de jouer à sa question (`settled`) : il rejoue, il tient de nouveau un créneau — sans cela `lanes()` le sous-compte et le registre annonce un créneau libre de trop (L433).
            settled.delete(c);
            taken.push(c);
          }
        }
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
        return [...taken, ...added, ...(await refill(canRun, free - taken.length - added.length))];
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
  for (const line of renderTable(wave, all, { prices: launchPrices(launch, (w) => io.err(`orchestrate : ${w}`)) })) io.out(line);
  for (const line of keptLines(all.map((l) => l.repo))) io.out(line); // les worktrees conservés, avec leur chemin (R19)
  if (wave.status === 'suspended-budget' || wave.status === 'suspended-quota') return 3;
  return all.every((l) => l.status === 'ready') ? 0 : 1;
}


const LAUNCH_CHECKS: LaunchChecks = { resolveTargets, preflight: (targets, run, addTo) => preflight({ dryRun: false }, targets, run.io, run.deps, run.launch, { addTo }) };

/** `--add` (L421) : la vague vivante de ce dossier reçoit les lots (le travail est dans `ajout.ts`). */
async function addOnlyLive(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string): Promise<number> {
  const store = liveStore('--add', args, io);
  return typeof store === 'number' ? store : addToLive(args, { io, deps, launch }, store, LAUNCH_CHECKS);
}

/**
 * Le contexte d'un lot ajouté en cours de vague (L421) ou tiré par le remplissage d'un créneau libre (L527) : le contrôle préalable d'un lot de lancement (les lots de la vague comptent pour les dépendances), le lien du Node,
 * puis un worktree si son dépôt est en `worktrees: true` et la vague a plus d'un créneau (`multiSlot`), ou si tous les lots encore à jouer de son dépôt y sont ; sinon il attend la fin de ceux qui jouent dans l'arbre du dépôt.
 */
async function buildAdd(t: Target, known: KnownLot[], w: { wave: string; ctxs: LotCtx[]; wctx: WaveCtx; store: RunStore; io: OrchestrateIo; deps: OrchestrateDeps; launch: string; multiSlot: boolean }): Promise<{ ctx: LotCtx } | { refusals: string[] }> {
  const pre = await LAUNCH_CHECKS.preflight([t], w, { wave: w.wave, lots: known });
  const lot = pre.lots[0];
  if (pre.refusals.length || !lot) return { refusals: pre.refusals };
  if (lot.node) lot.node.link = (w.deps.linkNode ?? linkNodeBin)(w.store.dir, lot.node.version, lot.node.bin);
  const ctx = contexts([lot], [projectEnv(lot.repo)], w.wctx)[0]!;
  const open = openInRepo(w.ctxs, ctx);
  planTrees(open.every((o) => o.tree) ? [...open, ctx] : [ctx], w.store, w.wave, w.wctx.log, w.multiSlot);
  return { ctx };
}

/** Le registre des vagues vivantes : dépôts tenus et créneaux occupés ; illisible, le décompte reste celui du dernier écrit. */
function updateWaveReposSafe(home: string, repos: string[], lanes: number | undefined): void {
  try {
    updateWaveRepos(home, process.pid, repos, lanes);
  } catch {
    // registre illisible : le décompte reste celui du dernier écrit
  }
}


/**
 * L309 : l'instantané d'une vague antérieure relit `--wave <id>` comme un simple nom et `--resume` seul comme « la dernière vague non terminée » :
 * on lui transmet la vague choisie en clair (`--resume <id>`, sans `--wave`), quel que soit le parseur qui la lira.
 */
export function resumeArgv(argv: string[], id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--wave') i++;
    else if (t === '--resume') {
      out.push(t, id);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !LOT_LIKE.test(next)) i++;
    } else if (t === '--answer') out.push(t, argv[++i] ?? '', argv[++i] ?? '');
    else out.push(t);
  }
  return out;
}

async function resume(args: Args, argv: string[], io: OrchestrateIo, deps: OrchestrateDeps, launch: string, today: Day): Promise<number> {
  const store = typeof args.resume === 'string' ? RunStore.find(launch, args.resume) : singleUnfinished(launch);
  if (!store) throw new RafError(`vague inconnue : ${args.resume}`);
  // L532 : `--integrate` seul sur une vague qui tourne encore dépose l'intégration dans sa file au lieu de refuser ; dit avant l'instantané (le dépôt ne demande rien à son code) ; une reprise qui attend le dépôt (L443) est inscrite vivante mais ne joue pas encore : la vague doit être « running ». Avec une autre option de reprise ou --replay, le refus ci-dessous reste.
  if (depositsOnly(args, runsElsewhere(store, launch))) return depositIntegrations(args.integrate, io, store);
  if (deps.snapshot) {
    // La reprise tourne sur l'instantané de la vague, jamais sur le dist/ courant ; une vague d'avant L61 n'en a pas.
    if (LOT_LIKE.test(store.id) && snapshotExists(store.dir)) {
      // L309 : `--resume suite2` serait relu par n'importe quel parseur comme un lot à lancer ; `--wave suite2`, un instantané d'avant L309 le prendrait pour un simple nom et reprendrait une autre vague.
      io.err(`orchestrate : vague ${store.id} : son nom ressemble à un lot, l'instantané ne saurait pas le relire comme une vague : reprise avec le dist/ et les gabarits courants`);
    } else if (snapshotExists(store.dir)) {
      // Une vague d'avant L223 refuserait « projet:lot=+N » comme budget invalide : seul le lot visé justifie de la rejouer avec le dist/ courant.
      if ((!args.lotBudgets.length || waveReadsLotBudget(store.dir)) && (!args.integrate.length || waveReadsIntegrate(store.dir)) && (!args.integrate.some((t) => t.replay) || waveReadsReplay(store.dir))) {
        // L330 : la copie dont l'instantané lie le node_modules a pu être purgée par une mise en service ; on relie, on le journalise, ou on refuse proprement.
        try {
          const healed = repairSnapshotModules(store.dir, deps.snapshot.packageRoot);
          if (healed) {
            store.journal(healed);
            io.err(`orchestrate : vague ${store.id} : ${healed}`);
          }
        } catch (e) {
          if (!(e instanceof SnapshotRefusal)) throw e;
          io.err(`orchestrate : vague ${store.id} : ${e.message}`);
          return 2;
        }
        return deps.snapshot.reexec(toolDirOf(store.dir), resumeArgv(argv, store.id), io.env, io);
      }
      io.err(`orchestrate : vague ${store.id} : son instantané ne connaît pas ${args.lotBudgets.length && !waveReadsLotBudget(store.dir) ? '--budget projet:lot=+N (antérieur à L223)' : `${args.integrate.some((t) => t.replay) && waveReadsIntegrate(store.dir) ? '--replay' : '--integrate'} (antérieur à L279)`} : reprise avec le dist/ et les gabarits courants`);
    } else {
      io.err(`orchestrate : vague ${store.id} sans instantané (antérieure à L61) : reprise avec le dist/ et les gabarits courants`);
    }
  }
  // L407 : la forme documentée sur une vague qui tourne encore dépose la réponse dans sa file au lieu de refuser ; avec une autre option de reprise, le refus ci-dessous reste.
  if (args.answers.length && !args.lotBudgets.length && !args.drop.length && !args.integrate.length && args.budget === undefined && !args.continue && liveWaves(cadenceHome()).some((w) => w.wave === store.id && w.cwd === launch && w.pid !== process.pid)) return answerLive(args, io, store);
  const wave = store.readWave()!;
  const refusals: string[] = [];
  const info = deps.claudeInfo();
  if (!info) refusals.push('claude introuvable (CADENCE_CLAUDE_BIN, ou claude dans le PATH)');
  const alive = liveWaves(cadenceHome()).find((w) => w.wave === wave.id && w.cwd === launch && w.pid !== process.pid);
  if (alive) refusals.push(`la vague ${alive.wave} tourne encore (pid ${alive.pid})`);
  // Une vague terminée ne se reprend que pour rejouer un lot visé par --budget projet:lot=+N (L223) ; ce lot est vérifié plus bas.
  if (wave.status === 'done' && !args.lotBudgets.length && !args.integrate.length) refusals.push(`la vague ${wave.id} est terminée`);

  const lots = store.lots();
  for (const a of args.answers) {
    const l = lots.find((x) => x.lot === a.lot && (a.project ? x.project === a.project : true));
    if (!l) refusals.push(`--answer ${a.project ? `${a.project}:` : ''}${a.lot} : lot inconnu dans la vague ${wave.id}`);
    else if (l.status !== 'question') refusals.push(`--answer ${lotKey(l.project, l.lot)} : le lot n'attend pas de réponse (${l.status})`);
    else {
      l.pendingAnswer = a.text;
      l.answers.push(a.text);
      l.questions = [];
    }
  }
  // --resume --drop projet:lot (L79) : le lot est retiré avant d'être rejoué — le seul moyen de retirer un lot d'une vague arrêtée, --drop seul refusant une vague qui ne tourne plus.
  const drops: string[] = [];
  for (const d of args.drop) {
    const matches = lots.filter((x) => x.lot === d.lot && (d.project ? x.project === d.project : true));
    const where = `${d.project ? `${d.project}:` : ''}${d.lot}`;
    if (matches.length !== 1) refusals.push(matches.length ? `--drop ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--drop ${where} : lot inconnu dans la vague ${wave.id}`);
    else if (lotFinished(matches[0])) refusals.push(`--drop ${lotKey(matches[0].project, matches[0].lot)} : le lot est déjà fini (${matches[0].status})`);
    else drops.push(lotKey(matches[0].project, matches[0].lot));
  }
  // --resume --budget projet:lot=+N (L223) : un lot rendu sur budget est remis en jeu avec son budget relevé (N reste la marge des passes ordinaires : la part de l'escalade encore retenue, L349, s'y ajoute). Il subit ensuite les gardes d'un lot vivant.
  const raised = new Map<LotState, { from: number; to: number; step: SessionKind }>();
  const answered = args.answers.map((a) => lots.filter((x) => x.lot === a.lot && (a.project ? x.project === a.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  const dropped = args.drop.map((d) => lots.filter((x) => x.lot === d.lot && (d.project ? x.project === d.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  for (const b of args.lotBudgets) {
    const matches = lots.filter((x) => x.lot === b.lot && (b.project ? x.project === b.project : true));
    const where = `${b.project ? `${b.project}:` : ''}${b.lot}`;
    if (matches.length !== 1) {
      refusals.push(matches.length ? `--budget ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--budget ${where} : lot inconnu dans la vague ${wave.id}`);
      continue;
    }
    const l = matches[0];
    const key = lotKey(l.project, l.lot);
    if (raised.has(l)) refusals.push(`--budget ${key} : lot visé deux fois`);
    else if (dropped.includes(l)) refusals.push(`--budget ${key} : lot aussi retiré par --drop`);
    else if (answered.includes(l)) refusals.push(`--budget ${key} : lot aussi visé par --answer`);
    else if (!budgetStep(l)) refusals.push(`--budget ${key} : le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer (${l.status}${l.status === 'handed-back' ? `, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'}` : ''})`);
    else if (budgetStep(l) === 'fix' && b.raise <= REVIEW_RESERVE) refusals.push(`--budget ${key}=+${b.text} : un fix ne part qu'au-dessus de ${REVIEW_RESERVE} tokens de réserve`);
    else raised.set(l, { from: l.budget ?? lotSpent(l), to: lotSpent(l) + b.raise + heldForEscalation(l), step: budgetStep(l)! });
  }
  // --resume --integrate projet:lot (L279, R27) : un lot rendu à l'étape d'intégration (next: integrate) n'est rejoué que si le lead le nomme. Ni --resume seul, ni --drop, --answer ou --budget ne le rejouent.
  const integ: LotState[] = [];
  // L370 : un lot rendu hors de l'intégration que le lead a fait corriger puis revoir hors vague (revue conforme au dernier commit du worktree) est repris à l'intégration avec ce verdict.
  const leadReviewed = new Map<LotState, { head: string; verdict: string }>();
  const budgeted = args.lotBudgets.map((b) => lots.filter((x) => x.lot === b.lot && (b.project ? x.project === b.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  for (const t of args.integrate) {
    const matches = lots.filter((x) => x.lot === t.lot && (t.project ? x.project === t.project : true));
    const opt = t.replay ? '--replay' : '--integrate';
    const where = `${t.project ? `${t.project}:` : ''}${t.lot}`;
    if (matches.length !== 1) {
      refusals.push(matches.length ? `${opt} ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `${opt} ${where} : lot inconnu dans la vague ${wave.id}`);
      continue;
    }
    const l = matches[0];
    const key = lotKey(l.project, l.lot);
    if (integ.includes(l)) refusals.push(`${opt} ${key} : lot visé deux fois`);
    else if (dropped.includes(l)) refusals.push(`${opt} ${key} : lot aussi retiré par --drop`);
    else if (answered.includes(l)) refusals.push(`${opt} ${key} : lot aussi visé par --answer`);
    else if (budgeted.includes(l)) refusals.push(`${opt} ${key} : lot aussi visé par --budget`);
    else if (!t.replay && l.next !== 'integrate' && (() => {
      // La revue du lead est écrite par `raf review` lancé dans le worktree : c'est le plan du worktree qui la porte, pas celui du dépôt principal.
      const tree = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      const r = existsSync(join(tree, '.git')) ? leadReviewedHandBack(l, planLoader(tree)(), tree) : null;
      if (r) leadReviewed.set(l, r);
      return r;
    })()) integ.push(l);
    else if (l.status !== 'handed-back' || (l.next !== 'integrate' && !(t.replay && planNoteHandBack(l)))) refusals.push(`${opt} ${key} : le lot n'est pas rendu ${t.replay ? "à l'étape d'intégration ni sur une écriture de plan refusée" : "à l'étape d'intégration"} (${l.status}, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'})`);
    else integ.push(l);
  }
  // Un lot retiré ne jouera rien : il ne subit ni le verrou du dépôt, ni le .nvmrc, ni l'arbre sale — un refus pour LUI ne doit pas faire échouer la reprise des autres.
  const live: LotState[] = [];
  const removed: LotState[] = [];
  for (const l of lots) {
    if (lotFinished(l) && !raised.has(l) && !integ.includes(l)) continue;
    for (const s of l.steps) {
      if (s.status !== 'running') continue;
      if (s.pid && pidAlive(s.pid)) refusals.push(`${lotKey(l.project, l.lot)} : session encore en vie, pid ${s.pid}`);
      else s.status = 'interrupted';
    }
    (drops.includes(lotKey(l.project, l.lot)) ? removed : live).push(l);
  }
  // Comme au départ : un dépôt tenu par une autre orchestration vivante est refusé avant toute écriture.
  // L443 : une reprise d'intégration (--integrate, --replay) attend la fin de l'autre vague au lieu de sortir en 2 ; toute autre reprise refuse comme avant.
  // Un refus déjà connu (vague qui tourne encore, claude introuvable, session en vie…) sort en 2 tout de suite : attendre 3 h ne le lèverait pas.
  const waitFor = integ.length && !refusals.length ? { waitMs: deps.repoWait?.waitMs ?? REPO_WAIT_MS, pollMs: deps.repoWait?.pollMs ?? REPO_WAIT_POLL_MS } : null;
  const deadline = Date.now() + (waitFor?.waitMs ?? 0);
  // Pendant l'attente (jusqu'à 3 h) la reprise est inscrite parmi les vagues vivantes : le garde « la vague tourne encore » d'une seconde reprise la voit, et ne vient pas attendre à son tour.
  let waiting = false;
  // Verrous pris à la fin de l'attente : tenus jusqu'à `execute` (qui les retrouve à son pid), pour qu'une autre reprise qui attendait le même dépôt ne le voie pas libre pendant le .nvmrc, l'arbre et l'écriture des lots.
  const taken: string[] = [];
  const stopBefore = store.control().stopAfterCurrent;
  try {
    for (const repo of new Set(live.flatMap(lotRepoPaths))) {
      const file = join(sharedStateDir(repo), REPO_LOCK);
      let announced: string | null = null;
      for (;;) {
        let busy = activeLock(file);
        if (waitFor && (!busy || busy.pid === process.pid)) {
          const t = takeLock(file, { pid: process.pid, wave: wave.id, started: new Date().toISOString() });
          if (t.ok) {
            taken.push(file);
            if (t.stale) io.err(`orchestrate : verrou de dépôt périmé retiré (${basename(repo)}, pid ${t.stale.pid} mort)`);
            break;
          }
          busy = t.held;
        }
        if (!busy || busy.pid === process.pid) break;
        // Le verrou porte l'id de la vague : tenu par un processus vivant de CETTE vague, c'est une autre reprise de la même vague,
        // entre son verrou et son inscription par `execute` (le garde « tourne encore » ci-dessus ne la voit pas encore) : refus, pas d'attente.
        if (busy.wave === wave.id) {
          refusals.push(`la vague ${wave.id} tourne encore (pid ${busy.pid}, verrou de ${basename(repo)})`);
          break;
        }
        // Un refus déjà posé sur un dépôt précédent (même vague, attente échue) : les suivants ne font plus attendre, la reprise sort en 2.
        if (!waitFor || refusals.length || Date.now() >= deadline) {
          refusals.push(heldRefusal(repo, busy));
          break;
        }
        if (!waiting) {
          registerWave(cadenceHome(), { pid: process.pid, wave: wave.id, started: new Date().toISOString(), cwd: launch, repos: [] });
          waiting = true;
        }
        if (announced !== busy.wave) io.out(`orchestrate : ${basename(repo)} : tenu par la vague ${busy.wave} (pid ${busy.pid}) : attente de sa fin avant de reprendre l'intégration`);
        announced = busy.wave;
        await new Promise<void>((res) => setTimeout(res, Math.min(waitFor.pollMs, Math.max(1, deadline - Date.now()))));
      }
    }
  } finally {
    if (waiting) unregisterWave(cadenceHome(), process.pid);
  }
  // Avant `execute`, tout refus ou échec rend les verrous pris ; `execute` les garde ensuite et les rend à sa fin.
  let played = false;
  try {
    // Comme au départ : le .nvmrc est relu à chaque reprise (version désinstallée, .nvmrc changé, vague d'avant L80),
    // et un Node introuvable refuse le lot — jamais de repli silencieux sur le Node par défaut.
    const nodes = new Map<LotState, NodeChoice>();
    for (const l of live) {
      const node = resolveNode(l.repo, nvmVersionsDir(io.env));
      if (node.kind === 'missing') refusals.push(`${lotKey(l.project, l.lot)} : ${node.message}`);
      else nodes.set(l, node);
    }
    // Tous les refus avant la moindre écriture (l'arbre sale compris) : une reprise refusée ne change pas l'état de la vague.
    const dirty = new Set<string>();
    for (const repo of live.flatMap(lotRepoPaths)) if (!dirty.has(repo)) {
      dirty.add(repo);
      const d = await trackedDirty(repo);
      if (d.length) refusals.push(`${basename(repo)} : arbre sale, ${d.length} fichier(s) suivi(s) modifié(s) : ${d.join(', ')}`);
    }
    // Les worktrees des lots repris suivent les mêmes gardes qu'un dépôt (R11) : un fichier suivi modifié refuse la reprise.
    for (const l of live) {
      const dir = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      if (!existsSync(join(dir, '.git'))) continue;
      const d = await trackedDirty(dir);
      if (d.length) refusals.push(`${basename(dir)} : arbre sale, ${d.length} fichier(s) suivi(s) modifié(s) : ${d.join(', ')}`);
    }
    if (refusals.length) {
      for (const r of refusals) io.err(`orchestrate : ${r}`);
      return 2;
    }
    for (const [l, node] of nodes) {
      if (node.kind === 'ok') l.node = { version: node.version, wanted: node.wanted, bin: node.bin, link: (deps.linkNode ?? linkNodeBin)(store.dir, node.version, node.bin) };
      else delete l.node;
    }
    // Une étape interrompue (signal, crash) dont les tokens n'ont pas été comptés : relue dans le journal de sa session.
    const recovered = new Budget(0);
    // La session d'un lot en worktree a travaillé dans son worktree : c'est là que son journal se range.
    const workdirOf = (l: LotState): string => {
      const dir = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      return existsSync(join(dir, '.git')) ? dir : l.repo;
    };
    for (const l of [...live, ...removed]) for (const s of l.steps) if (s.status === 'interrupted') countInterrupted(deps.claudeHome, workdirOf(l), s, recovered);
    wave.consumed += recovered.consumed;
    wave.cacheRead += recovered.cacheRead;
    if (recovered.consumed || recovered.cacheRead) store.writeWave(wave);
    for (const [l, r] of raised) {
      const k = lotKey(l.project, l.lot);
      const text = `budget relevé de ${r.from} à ${r.to} (--resume --budget)`;
      l.budget = r.to;
      l.status = 'suspended';
      l.next = r.step;
      l.outcome = null;
      l.warnings.push(text);
      store.journal(`${k} → suspended — ${text}`);
      io.out(`${k} → suspended — ${text}`);
    }
    for (const l of integ) {
      const k = lotKey(l.project, l.lot);
      const lead = leadReviewed.get(l);
      if (lead) adoptLeadReview(l, lead);
      const planNote = l.next !== 'integrate'; // rendu sur une écriture de plan refusée (--replay) : le lot repart de l'étape gardée
      if (planNote && l.outcome?.startsWith(HYPOTHESES_HANDBACK)) l.hypotheses = undefined; // les notes d'hypothèses se posent de nouveau (sans doublon) à l'entrée de l'étape
      l.status = 'suspended';
      l.outcome = null;
      const text = planNote ? `écriture du plan reprise à l'étape ${l.next} (--resume --replay)` : integrationText(lead ?? null);
      store.journal(`${k} → suspended — ${text}`);
      io.out(`${k} → suspended — ${text}`);
    }
    for (const l of live) {
      if (l.status === 'implementing' || l.status === 'reviewing' || l.status === 'fixing') l.status = 'suspended';
      store.writeLot(l);
    }
    if (args.budget !== undefined) wave.budget = wave.consumed + args.budget;
    // Un arrêt demandé à la vague d'avant ne doit pas arrêter celle-ci ; celui demandé pendant l'attente (la reprise est alors visible de --stop-after-current) est gardé.
    if (!(waiting && !stopBefore && store.control().stopAfterCurrent)) store.clearStopRequest();
    for (const l of removed) {
      const k = lotKey(l.project, l.lot);
      store.requestDrop(k);
      store.journal(`demande : retirer ${k} de la vague (--resume --drop)`);
      io.out(`${k} : retrait demandé — le lot est rendu au lead sans être rejoué`);
      l.next = null;
      l.status = 'handed-back';
      l.outcome = DROPPED;
      store.writeLot(l);
      store.journal(`${k} → handed-back — ${DROPPED}`);
      // Un lot retiré garde son worktree et sa branche (R12) : le journal en donne le chemin.
      const branch = lotBranch(wave.id, l.project, l.lot);
      if (baseBranchOf(l.repo, branch)) {
        const line = `orchestrate : ${k} : worktree conservé : ${lotTreeDir(store.dir, l.project, l.lot, l.repo)} (branche ${branch})`;
        io.out(line);
        store.journal(line);
      }
    }
    if (live.length === 0) {
      if (lots.every(lotFinished)) {
        wave.status = 'done';
        store.writeWave(wave);
      }
      for (const line of renderTable(wave, lots, { prices: launchPrices(launch, (w) => io.err(`orchestrate : ${w}`)) })) io.out(line);
      for (const line of keptLines(lots.map((l) => l.repo))) io.out(line);
      return removed.length && !lots.every((l) => l.status === 'ready') ? 1 : 0;
    }
    played = true;
    return continueRounds(await execute(wave, live, store, io, deps, today, args, lots), wave, lots, store, io, deps, today, args, launch);
  } finally {
    if (!played) for (const f of taken) releaseLock(f, process.pid);
  }
}

/** `loggedIn` de la sortie JSON de `claude auth status` ; null si elle n'est pas lisible (versions sans cette commande : pas de refus). */
export function parseAuthStatus(text: string): { loggedIn: boolean } | null {
  try {
    const v = JSON.parse(text) as { loggedIn?: unknown };
    return typeof v.loggedIn === 'boolean' ? { loggedIn: v.loggedIn } : null;
  } catch {
    return null;
  }
}

/** Dépendances réelles : `claude` (ou CADENCE_CLAUDE_BIN), agents et gabarits du paquet, journaux de ~/.claude. */
export function realOrchestrateDeps(env: NodeJS.ProcessEnv): OrchestrateDeps {
  const bin = env.CADENCE_CLAUDE_BIN || 'claude';
  const child = isSnapshotChild(env);
  // Lues ici, une fois : ni les sessions ni les commandes du projet ne reçoivent les variables de relance.
  env = withoutLaunchVars({ ...env });
  return {
    claude: realClaude(bin, env, env.CADENCE_CLAUDE_LOCAL_BIN || 'claude-local'),
    claudeInfo: () => {
      try {
        const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim();
        const help = execFileSync(bin, ['--help'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
        return { version, jsonSchema: help.includes('--json-schema') };
      } catch {
        return null;
      }
    },
    claudeAuth: () => {
      try {
        // `auth status` sort en 1 quand claude n'est pas connecté, et imprime quand même le JSON.
        const text = execFileSync(bin, ['auth', 'status'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
        return parseAuthStatus(text);
      } catch (e) {
        return parseAuthStatus(String((e as { stdout?: unknown }).stdout ?? ''));
      }
    },
    agentsDir: AGENTS_DIR,
    snapshot: child ? undefined : { packageRoot: PACKAGE_ROOT, reexec: spawnReexec },
    claudeHome: claudeConfigDir(env),
  };
}
