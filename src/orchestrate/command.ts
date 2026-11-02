import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { isDay, toDay, type Day } from '../dates.js';
import { RafError } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { readWaits, renderWaits } from './waits.js';
import { parseUntil } from './continue.js';
import { snapshot } from './guard.js';
import { claudeConfigDir, realClaude, type ClaudeFn } from './launch.js';
import { addNotAlone } from './ajout.js';
import { removeWorktree } from './retrait.js';
import { lotKey, RunStore, type WaveState } from './state.js';
import { linkNodeBin } from './node-env.js';
import { estimateLines, resumeCommand } from './table.js';
import { PACKAGE_ROOT, RESERVED_ENV, SnapshotRefusal, isSnapshotChild, resolveModulesDir, withoutLaunchVars, spawnReexec, takeSnapshot, type SnapshotDeps } from './snapshot.js';

import { preflight, projectEnv, resolveTargets, type Target } from './preflight.js';
export { preflight, projectEnv, resolveTargets, type Target } from './preflight.js';

import { continueDryRun, dryRun } from './dry-run.js';
import { draw, priorityOf } from './draw.js';

import { answerOnly, control, freeLines, maxSessions, onceAuth, statusCommand, waveExists } from './status.js';
export { configuredCap, expiredHoldLines, liveLines, slotsLine } from './status.js';

import { addOnlyLive, continueRounds, execute } from './execute.js';

import { resume } from './resume.js';
export { resumeArgv } from './resume.js';

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

export const DEFAULT_BUDGET = 2_000_000;

export { lotBudget, lotBudgetBasis, SPEC_STAGE_ALLOCATION, type SpecStage } from './lot-budget.js';
import { lotBudget, lotBudgetBasis, type SpecStage } from './lot-budget.js';

export { DEFAULT_MAX_SESSIONS, parseBudget, parseMaxSessions, parseOrchestrateArgs, type Args } from './command-args.js';
import { DEFAULT_MAX_SESSIONS, parseBudget, parseMaxSessions, parseOrchestrateArgs, type Args } from './command-args.js';

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
