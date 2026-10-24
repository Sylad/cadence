import { gateProgress, gateText } from '../audit.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PLAN_DEFAULT, PLAN_LEGACY, planLoader, readOrchestrateConfig, type OrchestrateConfig } from '../config.js';
import { isDay, toDay, type Day } from '../dates.js';
import { gitRoot, hooksDir } from '../git.js';
import { onTermination } from '../proc.js';
import { stopApps } from './app.js';
import { Plan, RafError, isOpen } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { pidAlive, sharedStateDir } from '../state.js';
import { findProjects, isProject as isLeadProject } from '../lead.js';
import { freeLine, readyFree } from '../ready-free.js';
import { acquireSlot, cadenceHome, expiredHolds, freeSlots, liveHolds, liveSlots, liveWaves, registerWave, unregisterWave, updateWaveRepos } from './registry.js';
import { headline, loadTemplates, newsText, objective, renderBrief, type BriefVars } from './briefs.js';
import { readWaits, renderWaits } from './waits.js';
import { acceptationFile, acceptText } from './accept.js';
import { ficheReviewText } from './fiche.js';
import { maquetteText } from './maquette.js';
import { specScreen, specText } from './spec.js';
import { candidates, parsePriority, parseUntil, readPriority, stopReason, type Candidate } from './continue.js';
import { Budget, DROPPED, MAX_PASSES, REVIEW_RESERVE, budgetStep, lotSpent, MAX_PASSES_CONVERGING, briefName, countInterrupted, planNoteHandBack, HYPOTHESES_HANDBACK, handBackDroppedQuestions, needsPrecheck, workDir, type LotCtx, type WaveCtx } from './cycle.js';
import { canInstallPrePush, installPrePush, removePrePush, snapshot } from './guard.js';
import { buildArgs, buildLocalArgs, killSessions, mcpServersFor, readAgents, realClaude, type AgentDef, type ClaudeFn, type Model, type SessionKind, type StepModel } from './launch.js';
import { activeLock, REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { groupLots, runPool } from './pool.js';
import { repoBranch } from './integrate.js';
import { baseBranchOf, keptLines, keptTrees, lotBranch, lotTreeDir, recoverTree, removeTree } from './worktree.js';
import { schemaFor } from './schemas.js';
import { resolveLotRepos } from '../repos.js';
import { excludeState, lotFinished, lotKey, lotRepoPaths, lotSlug, neighbourDirs, newLot, RunStore, type LotState, type WaveState } from './state.js';
import { linkNodeBin, nvmVersionsDir, resolveNode, type NodeChoice } from './node-env.js';
import { quotaText, renderTable } from './table.js';
import { PACKAGE_ROOT, RESERVED_ENV, SnapshotRefusal, isSnapshotChild, resolveModulesDir, snapshotExists, waveReadsControl, waveReadsIntegrate, waveReadsLotBudget, waveReadsReplay, withoutLaunchVars, spawnReexec, takeSnapshot, toolDirOf, type SnapshotDeps } from './snapshot.js';

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
  agentsDir: string;
  templatesDir?: string;
  claudeHome?: string;
  /** Création du dossier de liens Node d'une vague ; défaut `linkNodeBin` (injectable pour simuler un échec). */
  linkNode?: typeof linkNodeBin;
  /**
   * Instantané d'une vague (L61) : au vrai lancement, le paquet est copié dans `<vague>/tool/` et le processus se relance
   * depuis cette copie. Absent (tests, processus déjà relancé) : la vague tourne sur le paquet courant, sans copie.
   */
  snapshot?: SnapshotDeps;
  /** Attente du verrou d'intégration du dépôt (L279, R25) : défauts 10 minutes et 1 s ; réglable pour les tests. */
  integrate?: { waitMs?: number; pollMs?: number };
}

export const DEFAULT_BUDGET = 2_000_000;

/**
 * Budget d'un lot ordinaire (L78, L128, recalibré L194). Mesuré sur le TOTAL de chaque lot dans `.cadence/runs` (toutes les vagues
 * où il est passé, 250 lots, 11-10), rangé par estimate : jusqu'à 0,5 j p90 374 k (152 lots), de 0,5 à 1 j p90 732 k (88 lots, max
 * 1,09 M), au-delà d'un jour p90 1,14 M pour les 10 lots de 1,25 à 2 j (570 k par jour d'estimate), max 1,7 M (L188). Le plafond
 * de L78 (400 k par jour) rendait au lead, au deuxième tour, un lot de 1 j (L188 : 483 k puis 495 k).
 * Plancher relevé de 450 k à 540 k (L218) avec la réserve de la passe fix (155 k) : 14 k + 282 k + 80 k + 155 k = 531 k arrondis, la marge avant refus du fix reste 385 k.
 * Relevé à 600 k (L247), mesuré sur 16–22-10 : 145 lots à 540 k, p90 451 k, 3 au-dessus (tous maritime-atlas : 12 lots, p90 556 k, max 609 k) ; la marge
 * avant refus du fix passe à 445 k. Les lots à 750 k (60 lots, p90 571 k, 0 dépassement) et à 1,3 M (20 lots, p90 904 k, 1 dépassement) tiennent : inchangés.
 * Remesuré sur 17–23-10 (L280, `docs/perf/recalage-2026-10-24.md`) : 0 lot sur 309 au-dessus de son budget, p90 452 k à 600 k, 563 k à 750 k, 875 k à 1,3 M : tous inchangés, avec au moins 10 % de marge.
 */
const LOT_BUDGET_FLOOR = 600_000;
/** Lot de plus de 0,5 j et d'au plus 1 j : p90 mesuré du total, 732 k arrondis à 750 k. */
const LOT_BUDGET_ONE_DAY = 750_000;
/** Tokens par jour d'estimate au-delà d'un jour : p90 1,14 M pour 2 j. */
const LOT_BUDGET_PER_DAY = 570_000;
/**
 * Total d'un lot à `screen:` (L194), étapes spec, maquette et accept comprises : p90 1,28 M sur 5 lots (L113 1,12 M, L25 1,28 M, L50 877 k,
 * L85 758 k, L43 238 k), arrondi à 1,3 M. Remplace l'allocation de L191 (+350 k au budget d'estimate), qui ne payait ni l'UX de
 * conformité ni les passes de correction.
 */
const SCREEN_LOT_BUDGET = 1_300_000;
/**
 * Allocation d'un lot à fiche `spec: true` (L188/L191), en plus du budget dérivé de l'estimate : sessions spec, fiche et accept hors de
 * l'estimate d'écriture. Relevée de 350 k à 450 k (L218) : la chaîne avant implement du lot spec warhammer L120 a coûté 388 k (350 k : pire cas
 * mesuré des étapes d'un lot à écran, ol L113 : 349 k) ; cadence L217 n'en a pris que 176 k.
 */
export const SPEC_STAGE_ALLOCATION = 450_000;

export type SpecStage = 'screen' | 'spec';

/** Base mesurée d'un budget, pour `--dry-run` : l'estimate (et l'étape spec) d'où il sort. */
export function lotBudgetBasis(estimate: number, stage?: SpecStage): string {
  if (stage === 'screen' && lotBudget(estimate, stage) === SCREEN_LOT_BUDGET) return "p90 mesuré du total d'un lot à écran, étapes spec, maquette et accept comprises";
  const ordinary = lotBudget(estimate);
  const basis = estimate <= 0.5 ? "plancher d'un lot jusqu'à 0,5 j" : estimate <= 1 ? "p90 mesuré du total d'un lot de 0,5 à 1 j" : Math.round(estimate * LOT_BUDGET_PER_DAY) <= LOT_BUDGET_ONE_DAY ? `plancher de ${LOT_BUDGET_ONE_DAY} au-delà d'un jour, l'estimate × ${LOT_BUDGET_PER_DAY} ne le dépasse pas encore` : `${LOT_BUDGET_PER_DAY} par jour, p90 mesuré du total au-delà d'un jour`;
  if (!stage) return basis;
  return `${ordinary} dérivés de l'estimate (${basis}), plus ${SPEC_STAGE_ALLOCATION} pour les étapes spec, ${stage === 'screen' ? 'maquette' : 'fiche'} et accept`;
}

/** Budget d'un lot, dérivé de son estimate et de sa catégorie : empêche quelques lots d'avaler le budget de la vague au détriment des autres. Un lot à `screen:` vaut le total mesuré d'un lot à écran (L194) ; un lot à `spec: true` y ajoute l'allocation de son étape (L191). */
export const lotBudget = (estimate: number, stage?: SpecStage): number => {
  const ordinary = estimate <= 0.5 ? LOT_BUDGET_FLOOR : Math.max(LOT_BUDGET_ONE_DAY, Math.round(estimate * LOT_BUDGET_PER_DAY));
  if (stage === 'screen') return Math.max(SCREEN_LOT_BUDGET, ordinary + SPEC_STAGE_ALLOCATION);
  return ordinary + (stage === 'spec' ? SPEC_STAGE_ALLOCATION : 0);
};
/** Sessions simultanées, toutes vagues confondues (`--max-sessions`, ou CADENCE_MAX_SESSIONS). */
export const DEFAULT_MAX_SESSIONS = 2;

export interface Args {
  lots: { project?: string; lot: string; model?: Model }[];
  dryRun: boolean;
  status?: string | true;
  /** `--waits` : l'attente de créneau de session par jour et par vague, lue dans les journaux ; `--since` écarte les vagues d'avant. */
  waits: boolean;
  since?: string;
  watch: boolean;
  /** Secondes entre deux rendus de `--status --watch`. */
  interval?: number;
  resume?: string | true;
  budget?: number;
  /** `--budget projet:lot=+N` (L223) : relève le budget d'un lot rendu sur budget, avec `--resume` ; `text` est le N tel que donné. */
  lotBudgets: { project?: string; lot: string; raise: number; text: string }[];
  /** `--goal "…"` (L258) : l'objectif du seul lot lancé, à la place de son titre dans les briefs. */
  goal?: string;
  maxSessions?: number;
  wave?: string;
  /** `--continue` (L147) : la vague tire elle-même le prochain lot prêt du plan quand ceux en cours sont finis. */
  continue: boolean;
  /** `--until HH:MM` : plus aucun lot n'est tiré à partir de cette heure. */
  until?: string;
  /** `until` en date, lue une fois au lancement (`orchestrate`). */
  untilAt?: Date;
  /** `--priority a,b` : ordre des projets pour le tirage, sinon la clé `priority:` du cadence.yaml du dossier de lancement. */
  priority?: string[];
  answers: { project?: string; lot: string; text: string }[];
  /** `--drop projet:lot` (L79) : retire un lot d'une vague vivante (`--wave` si plusieurs tournent). */
  drop: { project?: string; lot: string }[];
  /** `--stop-after-current` (L79) : la vague vivante finit ses sessions en cours puis s'arrête, reprenable. */
  stopAfterCurrent: boolean;
  /** `--integrate projet:lot` (L279, R27), avec `--resume` : rejoue à l'intégration un lot rendu à cette étape (`next: integrate`) ; ni `--resume` seul ni `--drop`, `--answer`, `--budget` ne le font. `--replay projet:lot` (L279, R26/R27, décision du lead du 24-10) en est la forme générale : elle rejoue aussi un lot rendu sur « écriture de plan refusée » (notes d'hypothèses ou de mineurs de la fiche) à l'étape gardée. */
  integrate: { project?: string; lot: string; replay?: boolean }[];
  /** `--remove-worktree projet:lot` (L279, R20) : retire le worktree et la branche conservés d'un lot ; `--abandon-commits` confirme l'abandon de ses commits non intégrés. */
  removeWorktree?: { project?: string; lot: string };
  abandonCommits: boolean;
}

/** `1500000`, `1.5M`, `800k`. */
export function parseBudget(text: string): number {
  const m = /^(\d+(?:[.,]\d+)?)\s*([kKmM]?)$/.exec(text.trim());
  if (!m) throw new RafError(`--budget invalide : ${text} (1500000, 1.5M, 800k)`);
  const n = Number(m[1].replace(',', '.')) * ({ '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as '' | 'k' | 'm']);
  if (!(n > 0)) throw new RafError(`--budget invalide : ${text}`);
  return Math.round(n);
}

export function parseMaxSessions(text: string, what = '--max-sessions'): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) < 1) throw new RafError(`${what} invalide : ${text} (entier ≥ 1)`);
  return Number(text);
}

// une vague (2026-10-04-1412) n'a ni « : » ni « / » : leur présence désigne un lot, quel que soit son motif (R-M7/ux-1)
const LOT_LIKE = /^(?:[\w.-]+(?:\/[\w.-]+)*:[\w.-][\w./-]*|[\w.-]+\/[\w./-]*|[A-Za-z]+\d+)(?:@\w+)?$/;
const MODELS = ['sonnet', 'opus', 'haiku'];

function lotArg(text: string): { project?: string; lot: string; model?: Model } {
  // le premier « : » sépare le projet du lot, un « @ » final le modèle ; le lot garde ses « / » (L120), le projet peut être un chemin depuis le dossier (`groupe/gamma`, projet imbriqué de lead tour --depth, L201)
  const m = /^(?:([\w.-]+(?:\/[\w.-]+)*):)?([\w.-][\w./-]*?)(?:@(\w+))?$/.exec(text);
  if (!m) throw new RafError(`lot invalide : ${text} (projet:lot, lot, projet:lot@haiku)`);
  if (m[3] && !MODELS.includes(m[3])) throw new RafError(`modèle inconnu : @${m[3]} (attendu : ${MODELS.join(', ')})`);
  return { project: m[1], lot: m[2], model: m[3] as Model | undefined };
}

/** `projet:lot=+200k`, `lot=+0.3M` (L223) : le « = » distingue le relèvement d'un lot du budget de la vague. */
function lotBudgetArg(text: string): Args['lotBudgets'][number] {
  const bad = () => new RafError(`--budget invalide : ${text} (projet:lot=+500k)`);
  const m = /^([^=]+)=\+(.+)$/.exec(text);
  if (!m) throw bad();
  let target: ReturnType<typeof lotArg>;
  let raise: number;
  try {
    target = lotArg(m[1]);
    raise = parseBudget(m[2]);
  } catch {
    throw bad();
  }
  if (target.model) throw bad();
  return { project: target.project, lot: target.lot, raise, text: m[2] };
}

export function parseOrchestrateArgs(argv: string[]): Args {
  const a: Args = { lots: [], lotBudgets: [], dryRun: false, waits: false, watch: false, continue: false, answers: [], drop: [], stopAfterCurrent: false, integrate: [], abandonCommits: false };
  const optional = (i: number) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') && !LOT_LIKE.test(argv[i + 1]) ? argv[i + 1] : undefined);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const value = (flag: string) => {
      if (argv[i + 1] === undefined) throw new RafError(`${flag} attend une valeur`);
      return argv[++i];
    };
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--status' || t === '--resume') {
      const v = optional(i);
      if (v !== undefined) i++;
      a[t === '--status' ? 'status' : 'resume'] = v ?? true;
    } else if (t === '--waits') a.waits = true;
    else if (t === '--since') {
      a.since = value(t);
      if (!isDay(a.since)) throw new RafError(`--since invalide : ${a.since} (AAAA-MM-JJ)`);
    } else if (t === '--watch') a.watch = true;
    else if (t === '--interval') a.interval = parseMaxSessions(value(t), '--interval');
    else if (t === '--budget') {
      const v = value(t);
      if (v.includes('=')) a.lotBudgets.push(lotBudgetArg(v));
      else a.budget = parseBudget(v);
    }
    else if (t === '--max-sessions') a.maxSessions = parseMaxSessions(value(t));
    else if (t === '--goal') {
      // Un texte oublié ne doit pas avaler l'option suivante (`--goal --dry-run` lancerait une vraie vague payante).
      const next = argv[i + 1];
      if (next?.startsWith('--')) throw new RafError(`--goal attend un texte, pas l'option ${next}`);
      a.goal = value(t).trim();
      if (a.goal === '') throw new RafError('--goal attend un texte non vide');
    } else if (t === '--wave') a.wave = value(t);
    else if (t === '--drop') a.drop.push(lotArg(value(t)));
    else if (t === '--stop-after-current') a.stopAfterCurrent = true;
    else if (t === '--integrate') a.integrate.push(lotArg(value(t)));
    else if (t === '--replay') a.integrate.push({ ...lotArg(value(t)), replay: true });
    else if (t === '--remove-worktree') a.removeWorktree = lotArg(value(t));
    else if (t === '--abandon-commits') a.abandonCommits = true;
    else if (t === '--continue') a.continue = true;
    else if (t === '--until') a.until = value(t);
    else if (t === '--priority') a.priority = parsePriority(value(t));
    else if (t === '--answer') {
      const target = lotArg(value(t));
      a.answers.push({ project: target.project, lot: target.lot, text: value(t) });
    } else if (t.startsWith('-')) throw new RafError(`option inconnue : ${t}`);
    else a.lots.push(lotArg(t));
  }
  return a;
}

interface Target {
  project: string;
  projectDir: string;
  repo: string;
  lot: string;
  model: Model;
}

/** Ce qu'un projet fournit à l'orchestrateur : sa configuration et la lecture de son plan (comme le CLI). */
export function projectEnv(repo: string): { config: OrchestrateConfig; loadPlan: () => Plan; configPath: string } {
  const configPath = join(repo, 'cadence.yaml');
  const loadPlan = planLoader(repo);
  return { config: readOrchestrateConfig(configPath), loadPlan, configPath };
}

const isProject = (dir: string) => existsSync(join(dir, PLAN_DEFAULT)) || existsSync(join(dir, PLAN_LEGACY)) || (existsSync(join(dir, 'cadence.yaml')) && /^plan\s*:/m.test(readFileSync(join(dir, 'cadence.yaml'), 'utf8')));

function resolveTargets(args: Args, io: OrchestrateIo, refusals: string[]): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const l of args.lots) {
    const projectDir = l.project ? resolve(io.cwd, l.project) : io.cwd;
    const project = l.project ?? basename(io.cwd);
    const key = lotKey(project, l.lot);
    if (seen.has(key)) {
      refusals.push(`${key} : lot donné deux fois`);
      continue;
    }
    seen.add(key);
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      refusals.push(`${key} : ${l.project ? `dossier ${projectDir} introuvable` : 'dossier courant illisible'}`);
      continue;
    }
    if (!isProject(projectDir)) {
      refusals.push(`${key} : ${projectDir} n'est pas un projet cadence (${PLAN_DEFAULT}, ${PLAN_LEGACY}, ou cadence.yaml avec une clé plan:)`);
      continue;
    }
    const repo = gitRoot(projectDir);
    if (!repo) {
      refusals.push(`${key} : ${projectDir} n'est pas dans un dépôt git`);
      continue;
    }
    out.push({ project, projectDir, repo, lot: l.lot, model: l.model ?? 'sonnet' });
  }
  return out;
}

async function trackedDirty(repo: string): Promise<string[]> {
  return (await snapshot(repo, { remote: false })).tracked.map((l) => l.slice(3));
}

/** `--effort` date de claude 2.1.284 (L137). Une version illisible n'est pas refusée. */
function olderThanEffort(version: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a < 2 || (a === 2 && (b < 1 || (b === 1 && c < 284)));
}

/** Variable d'environnement qui lève le refus de `orchestrate.worktrees: true` (mode expérimental, L279 ; lots L299–L301). Posée par le harnais des tests du mode. */
export const EXPERIMENTAL_WORKTREES_ENV = 'CADENCE_EXPERIMENTAL_WORKTREES';

/**
 * Seule décision d'activation du mode worktree (L279) : le départ (`preflight`), la file des lots (`planTrees`, `dryRun`) et la reprise (`resume`) passent tous par elle.
 * Le mode joue si la configuration le demande (ou si le lot repris a une branche `cadence/<vague>/…` à retrouver, `branchKept`) ET si la variable vaut exactement `1`.
 */
export function worktreesEnabled(config: { worktrees: boolean }, env: Record<string, string | undefined>, branchKept = false): boolean {
  return (config.worktrees || branchKept) && env[EXPERIMENTAL_WORKTREES_ENV] === '1';
}

/** Le refus de la garde d'activation, ou null : le mode est demandé (configuration, ou branche de lot à retrouver) sans que la variable le permette. */
function worktreesRefusal(key: string, config: { worktrees: boolean }, env: Record<string, string | undefined>, keptBranch?: string): string | null {
  const wanted = config.worktrees || !!keptBranch;
  if (!wanted || worktreesEnabled(config, env, !!keptBranch)) return null;
  const what = config.worktrees ? 'orchestrate.worktrees: true' : `la branche ${keptBranch} (lot joué dans un worktree)`;
  return `${key} : ${what} est refusé : le mode worktree par lot est EXPÉRIMENTAL et non activable tant que les lots L299, L300 et L301 ne sont pas faits (retirer la clé, ou poser ${EXPERIMENTAL_WORKTREES_ENV}=1 pour les tests du mode)`;
}

/** Préconditions : tout ce qui peut être refusé l'est ici, avant d'agir, sans verrou ni écriture. */
async function preflight(args: Args, targets: Target[], io: OrchestrateIo, deps: OrchestrateDeps, launch: string, opts: { resume?: boolean } = {}): Promise<{ refusals: string[]; lots: LotState[] }> {
  const refusals: string[] = [];
  if (io.env.CADENCE_ORCHESTRATED) refusals.push(`orchestrate ne se lance pas depuis une session orchestrée (vague ${io.env.CADENCE_ORCHESTRATED})`);
  const info = deps.claudeInfo();
  if (!info) refusals.push('claude introuvable (CADENCE_CLAUDE_BIN, ou claude dans le PATH)');
  else if (!info.jsonSchema) refusals.push(`claude ${info.version} n'a pas --json-schema : mettre claude à jour`);

  const lots: LotState[] = [];
  const repoChecked = new Set<string>();
  const byProject = new Map<string, string[]>();
  for (const t of targets) {
    const key = lotKey(t.project, t.lot);
    let env: ReturnType<typeof projectEnv>;
    let plan: Plan;
    try {
      env = projectEnv(t.repo);
      plan = env.loadPlan();
    } catch (e) {
      refusals.push(`${key} : ${(e as Error).message}`);
      continue;
    }
    // L279 : le mode worktree est une infrastructure expérimentale, non activable tant que L299–L301 ne sont pas faits (refus avant d'agir, `--dry-run` compris).
    const refused = worktreesRefusal(key, env.config, io.env);
    if (refused) {
      refusals.push(refused);
      continue;
    }
    if (info && olderThanEffort(info.version) && Object.values(env.config.effort).some((e) => e !== 'default')) {
      refusals.push(`${key} : claude ${info.version} n'a pas --effort (2.1.284 requise) : mettre claude à jour, ou orchestrate.effort à « default » pour chaque passe`);
      continue;
    }
    const lot = plan.lots().find((l) => l.id === t.lot);
    if (!lot) {
      refusals.push(`${key} : lot inconnu`);
      continue;
    }
    if (!isOpen(lot.status)) {
      refusals.push(`${key} : le lot est ${lot.status}`);
      continue;
    }
    if (plan.readonly && lot.status === 'todo' && !env.config.start) {
      refusals.push(`${key} : plan en lecture seule : démarrer le lot avec l'outil du projet (ou déclarer orchestrate.start dans cadence.yaml)`);
      continue;
    }
    const earlier = byProject.get(t.project) ?? [];
    const open = lot.after.filter((d) => {
      const dep = plan.lots().find((x) => x.id === d);
      return dep && isOpen(dep.status) && !earlier.includes(d);
    });
    if (open.length) {
      refusals.push(`${key} : dépendance(s) ni terminée(s) ni plus tôt dans la vague : ${open.join(', ')}`);
      continue;
    }
    // Condition de tirage (L219) : seuls les lots done du plan la lèvent, jamais un lot de la même vague ; un lot déjà doing n'est pas refusé pour elle.
    const gate = lot.status === 'todo' ? gateProgress(plan.lots(), lot) : undefined;
    if (gate && !gate.met) {
      refusals.push(`${key} : condition de tirage non remplie : ${gate.n === 0 ? 'gate invalide (raf check)' : gateText(gate)}`);
      continue;
    }
    // Dépôts voisins du lot (L62) : chacun doit exister et être un dépôt git, sinon refus avant d'agir comme pour le dépôt du projet.
    const neighbours = resolveLotRepos(t.repo, lot);
    if (neighbours.problems.length) {
      refusals.push(...neighbours.problems.map((p) => `${key} : ${p}`));
      continue;
    }
    byProject.set(t.project, [...earlier, t.lot]);
    for (const repo of [t.repo, ...neighbours.repos.map((r) => r.path)]) {
      if (repoChecked.has(repo)) continue;
      repoChecked.add(repo);
      const dirty = await trackedDirty(repo);
      if (dirty.length) refusals.push(`${basename(repo)} : arbre sale, ${dirty.length} fichier(s) suivi(s) modifié(s) : ${dirty.join(', ')}`);
      const hook = canInstallPrePush(repo);
      if (hook) refusals.push(`${basename(repo)} : ${hook}`);
      const busy = activeLock(join(sharedStateDir(repo), REPO_LOCK));
      if (busy && !opts.resume) refusals.push(`${basename(repo)} : une orchestration y est déjà en cours (${busy.wave}, pid ${busy.pid})`);
    }
    const node = resolveNode(t.repo, nvmVersionsDir(io.env));
    if (node.kind === 'missing') {
      refusals.push(`${key} : ${node.message}`);
      continue;
    }
    const small = lot.estimate <= 0.5 || lot.quickwin;
    const goal = args.goal ?? lot.goal;
    const screen = specScreen(t.repo, env.config.spec.dir, lot);
    const state = newLot({ project: t.project, repo: t.repo, lot: t.lot, title: lot.title, ...(goal ? { goal } : {}), visible: lot.visible, small, ...(screen ? { screen } : {}), ...(lot.spec && !screen ? { specLot: true as const } : {}), model: t.model, readOnlyPlan: plan.readonly });
    if (neighbours.repos.length) state.repos = neighbours.repos;
    state.estimate = lot.estimate;
    state.light = lot.estimate <= env.config.review.threshold;
    state.budget = lotBudget(lot.estimate, screen ? 'screen' : lot.spec ? 'spec' : undefined);
    state.dependsOn = lot.after.filter((d) => earlier.includes(d));
    if (node.kind === 'ok') state.node = { version: node.version, wanted: node.wanted, bin: node.bin, ...(node.skipped ? { skipped: node.skipped } : {}) };
    lots.push(state);
  }
  return { refusals, lots };
}

function agentsOf(deps: OrchestrateDeps): Record<string, AgentDef> {
  return readAgents(deps.agentsDir);
}

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

function dryRun(lots: LotState[], io: OrchestrateIo, deps: OrchestrateDeps, budget: number, id: string): void {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-orchestrate-'));
  const agents = agentsOf(deps);
  io.out(`vague ${id} — simulation, rien n'est lancé (budget ${budget} tokens comptés)`);
  const repos = [...new Set(lots.map((l) => l.repo))];
  for (const l of lots) {
    const env = projectEnv(l.repo);
    const lot = env.loadPlan().lot(l.lot);
    const slot = repos.indexOf(l.repo);
    io.out(`${lotKey(l.project, l.lot)} — ${l.title}`);
    if (l.goal) io.out(`  objectif donné : ${l.goal} (à la place du titre dans les briefs)`);
    io.out(`  budget du lot : ${l.budget} tokens comptés (base : ${lotBudgetBasis(lot.estimate, l.screen ? 'screen' : l.specLot ? 'spec' : undefined)})`);
    const mine = lots.filter((o) => o.repo === l.repo);
    const together = worktreesEnabled(env.config, io.env) && mine.length > 1 && !mine.some((o) => o.repos?.length) && !!repoBranch(l.repo);
    io.out(together ? `  file ${basename(l.repo)} · en parallèle des autres lots du dépôt, dans son worktree (cadence/${id}/${lotSlug(l.project, l.lot)}, créé à la prise du créneau)` : `  file ${basename(l.repo)} · ${slot < 2 ? `créneau ${slot + 1}` : 'en attente d\'un créneau'}`);
    if (l.repos?.length) io.out(`  dépôts voisins : ${l.repos.map((r) => r.rel).join(', ')} (verrou, garde de push et --add-dir ; leurs commits citent ${l.lot})`);
    if (l.node) {
      const sk = l.node.skipped;
      const skipped = sk?.length ? ` ; ${sk.join(', ')} ${sk.length > 1 ? 'écartées' : 'écartée'} : pas de node exécutable` : '';
      io.out(`  node : ${l.node.version} (.nvmrc ${l.node.wanted}${skipped})`);
    }
    const steps: { kind: 'precheck' | 'spec' | 'maquette' | 'fiche' | 'accept' | 'implement' | 'ux' | 'review' | 'review-small'; model: StepModel }[] = [{ kind: 'implement', model: l.model }];
    const specStage = !!(l.screen || l.specLot);
    if (specStage && env.config.accept) steps.unshift({ kind: 'accept', model: 'sonnet' });
    if (l.screen && env.config.maquette) steps.unshift({ kind: 'maquette', model: env.config.review.full });
    if (l.specLot && env.config.fiche) steps.unshift({ kind: 'fiche', model: 'sonnet' });
    if (specStage) steps.unshift({ kind: 'spec', model: 'sonnet' });
    if (needsPrecheck(env.config, env.loadPlan(), l.repo, l.lot, l.repos, l.goal)) steps.unshift({ kind: 'precheck', model: env.config.precheckLocal ? 'local' : 'sonnet' });
    const { light, full } = env.config.review;
    if (l.small) steps.push({ kind: l.visible ? 'review-small' : 'review', model: l.light ? light : full });
    else {
      steps.push({ kind: 'review', model: l.light ? light : full });
      if (l.visible && env.config.ux) steps.push({ kind: 'ux', model: full }); // L221 : l'UX est jouée une fois, après la revue de code conforme
    }
    io.out(`  étapes : ${steps.map((s) => `${s.kind} (${s.model})`).join(' → ')}${l.small ? ' — petit lot' : ''}${l.light ? ` — revue légère (${light}, pas de passe des mineurs ; un bloquant ou un majeur → correction puis revue ${full})` : ''}${l.visible && !env.config.ux ? ' — UX à faire par le lead (orchestrate.ux absent)' : ''}`);
    io.out(`  corrections : ${MAX_PASSES} passe(s) au plus (${MAX_PASSES_CONVERGING} si la revue converge), en session neuve`);
    io.out(l.light ? '  revue conforme avec mineurs : pas de passe des mineurs, ils sont rendus en notes' : '  revue conforme avec mineurs : une passe de correction des mineurs (session neuve), puis une revue courte ; les mineurs refusés sont rendus en « choix »');
    const pwDir = join(resolve(RunStore.runsDir(io.cwd)), id, lotSlug(l.project, l.lot), 'playwright');
    // brief écrit par --dry-run = base d'une délégation à la main : aucun dossier de vague (il n'existe pas)
    const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: headline(lot, l.goal), objectif: objective(lot, l.goal), commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: l.visible ? newsText(l.lot) : '', captures: '' };
    if (specStage) vars.spec = specText({ dir: env.config.spec.dir, render: env.config.spec.render, screen: l.screen, back: !!l.specLot });
    if (l.screen && env.config.maquette) vars.maquette = maquetteText({ fiche: `${env.config.spec.dir}/<écran>/fiche.yaml`, passes: 0, max: env.config.maquetteReviews });
    if (l.specLot && env.config.fiche) vars.fiche = ficheReviewText({ fiche: `${env.config.spec.dir}/<sujet>/fiche.yaml`, passes: 0 });
    if (specStage && env.config.accept) {
      const folder = `${env.config.spec.dir}/${l.screen ? '<écran>' : '<sujet>'}`;
      vars.accept = acceptText({ fiche: `${folder}/fiche.yaml`, maquette: `${folder}/maquette.html`, screen: !!l.screen, back: false, acceptation: acceptationFile(`${folder}/fiche.yaml`, l.lot), command: env.config.accept ?? '', test: env.config.test });
    }
    for (const s of steps) {
      const file = join(tmp, `${lotSlug(l.project, l.lot)}--${s.kind}.md`);
      const brief = renderBrief(briefName(l, s.kind), s.kind === 'fiche' || vars.fiche === undefined ? vars : { ...vars, fiche: '' }, deps.templatesDir); // la consigne de revue de fiche ne sert qu'au brief de la fiche : implement et review en sont la base d'une délégation à la main
      writeFileSync(file, brief);
      const playwright = !!mcpServersFor(s.kind, l.visible, '', l.small, !!l.screen).playwright;
      const local = s.model === 'local';
      const args = (local ? buildLocalArgs : buildArgs)(
        { kind: s.kind, sessionId: '<uuid>', brief: '<brief>', model: s.model === 'local' ? 'sonnet' : s.model, local, effort: env.config.effort[s.kind === 'review-small' ? 'review' : s.kind], schema: schemaFor(s.kind), agent: s.kind === 'implement' ? undefined : s.kind === 'spec' ? 'spec-writer' : s.kind === 'accept' ? 'acceptance-writer' : s.kind === 'ux' || s.kind === 'maquette' ? 'ux-reviewer' : s.kind === 'precheck' ? 'precheck-reader' : 'code-reviewer', cwd: l.repo, wave: id, permissionMode: env.config.permissionMode, addDirs: [...env.config.addDirs, ...(playwright && (s.kind === 'implement' || s.kind === 'spec') ? [pwDir] : []), ...neighbourDirs(l)], timeoutMs: 0, mcpConfig: '<mcp>', playwright },
        agents,
      ).map((a) => (a.startsWith('{') ? '<json>' : a));
      io.out(`  ${s.kind} : ${local ? 'claude-local' : 'claude'} ${args.join(' ')}`);
      io.out(`    brief : ${file}`);
      const servers = Object.keys(mcpServersFor(s.kind, l.visible, '', l.small, !!l.screen));
      io.out(`    mcp : ${servers.length ? `${servers.join(', ')} (captures dans le dossier de la vague : <vague>/${lotSlug(l.project, l.lot)}/playwright)` : 'aucun'}`);
    }
  }
}

function maxSessions(args: Args, io: OrchestrateIo): number {
  if (args.maxSessions !== undefined) return args.maxSessions;
  const env = io.env.CADENCE_MAX_SESSIONS;
  return env ? parseMaxSessions(env, 'CADENCE_MAX_SESSIONS') : DEFAULT_MAX_SESSIONS;
}

/** Plafond à AFFICHER (`--status`, `lead tour`) : le réglage de l'humain, jamais 2 en dur. Un réglage invalide ne casse pas l'affichage (le lancement, lui, le refuse) : retour au défaut. */
export function configuredCap(env: Record<string, string | undefined>, flag?: number): number {
  if (flag !== undefined) return flag;
  try {
    return env.CADENCE_MAX_SESSIONS ? parseMaxSessions(env.CADENCE_MAX_SESSIONS, 'CADENCE_MAX_SESSIONS') : DEFAULT_MAX_SESSIONS;
  } catch {
    return DEFAULT_MAX_SESSIONS;
  }
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Vagues vivantes (toutes, quel que soit leur dossier de départ), sessions du lead (L255), créneaux libres et dépôts qu'elles tiennent. Rien sans vague ni session du lead. */
export function liveLines(cap = DEFAULT_MAX_SESSIONS, now = new Date()): string[] {
  const home = cadenceHome();
  const waves = liveWaves(home);
  const holds = liveHolds(home, now);
  if (waves.length === 0 && holds.length === 0) return [];
  const slots = liveSlots(home).length;
  const lead = holds.length ? ` · sessions du lead : ${holds.length} (${holds.map((h) => h.label).join(', ')})` : '';
  const lines = [`vagues en cours : ${waves.length} · sessions en cours : ${slots}${lead} · créneaux libres : ${freeSlots(waves, cap, holds.length)} sur ${cap}`];
  for (const w of waves) lines.push(`  ${w.wave} (pid ${w.pid}, depuis ${w.started}) lancée depuis ${w.cwd} · plafond ${w.cap ?? '?'} · dépôts : ${w.repos.join(', ')}`);
  return lines;
}

/** Durée à la minute : « 12 min », « 5 h 10 min », « 2 j 3 h ». */
function longDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

/** Une ligne ⚠ par session du lead dont le TTL est échu et qui n'a pas été rendue (L278) : vide sans session échue. */
export function expiredHoldLines(now = new Date()): string[] {
  return expiredHolds(cadenceHome(), now).map((h) => {
    const since = Date.parse(h.since);
    const age = Number.isFinite(since) ? `inscrite depuis ${longDuration(now.getTime() - since)}, ` : '';
    return `⚠ session du lead échue : ${h.label} (${age}échue depuis ${longDuration(now.getTime() - Date.parse(h.expires))}) — la reprendre (cadence lead hold ${h.label} --ttl <minutes>) ou l'arrêter (cadence lead release ${h.label})`;
  });
}

/** `--continue` (L252) : la ligne des lots prêts dont aucune ressource n'est prise par un lot en cours ni par une vague, sans les lots du premier tirage `drawn` ni les ressources qu'ils tiennent. Vide si aucun. */
function freeLines(launch: string, drawn: LotState[]): string[] {
  const dirs = isLeadProject(launch) ? [launch] : findProjects(launch);
  const free = readyFree(dirs, cadenceHome(), drawn);
  const line = freeLine(dirs.filter((d) => free.has(d)).map((d) => ({ project: basename(d), free: free.get(d)! })), 60);
  return line ? [line] : [];
}

/** Efface l'écran et replace le curseur en haut : l'entrée d'un rendu de `--status --watch`. */
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
const DEFAULT_WATCH_INTERVAL = 10;

/** Ce que `--status` montre à un instant : les vagues vivantes, puis le tableau (absent si seules les vagues vivantes comptent). */
function statusView(args: Args, launch: string, cap: number, now: Date): { live: string[]; table?: string[]; running: boolean } {
  const store = typeof args.status === 'string' ? RunStore.find(launch, args.status) : RunStore.last(launch);
  const live = [...liveLines(cap, now), ...expiredHoldLines(now)];
  const waveLive = liveWaves(cadenceHome()).length > 0;
  if (!store && live.length && args.status === true) return { live, running: waveLive };
  if (!store) throw new RafError(typeof args.status === 'string' ? `vague inconnue : ${args.status}` : 'aucune vague dans ce dossier');
  // `running` : la vague suivie tourne — pour un <id> explicite, elle seule compte, pas les autres vagues de la machine
  const running = typeof args.status === 'string' ? liveWaves(cadenceHome()).some((w) => w.wave === store.readWave()!.id) : waveLive;
  const lots = store.lots();
  return { live, table: [...renderTable(store.readWave()!, lots), ...keptLines(lots.map((l) => l.repo), now.getTime())], running };
}

/** Refus d'une `--wave` déjà existante, identique en simulation et au vrai lancement. */
function waveExists(wave: string, io: OrchestrateIo): number {
  io.err(`orchestrate : --wave ${wave} : cette vague existe déjà`);
  return 2;
}

/**
 * `--remove-worktree projet:lot` (L279, R20) : seule commande qui retire un worktree conservé. Refus (code 2, rien retiré) pour le worktree d'une vague vivante (même avec `--abandon-commits`), et tant qu'un commit du lot n'est ni
 * intégré à la branche du dépôt ni confirmé abandonné par `--abandon-commits` ; un worktree entièrement intégré se retire sans option. `--wave` désigne la vague
 * quand plusieurs ont laissé un worktree pour ce lot.
 */
function removeWorktree(args: Args, io: OrchestrateIo): number {
  const t = args.removeWorktree!;
  const key = `${t.project ?? basename(io.cwd)}:${t.lot}`;
  const projectDir = t.project ? resolve(io.cwd, t.project) : io.cwd;
  const repo = existsSync(projectDir) ? gitRoot(projectDir) : null;
  const kept = repo ? keptTrees(repo, { includeActive: true }).filter((k) => k.lot === key && (args.wave === undefined || k.wave === args.wave)) : [];
  if (!repo || kept.length === 0) {
    io.err(`orchestrate : ${key} : aucun worktree conservé`);
    return 2;
  }
  if (kept.length > 1) {
    io.err(`orchestrate : ${key} : plusieurs worktrees conservés (vagues ${kept.map((k) => k.wave).join(', ')}) : précisez --wave`);
    return 2;
  }
  const k = kept[0]!;
  if (k.active) {
    // une vague vivante joue encore ce lot (ses sessions travaillent dans ce dossier) : refus sans rien retirer, même avec --abandon-commits
    io.err(`orchestrate : ${key} : la vague ${k.wave} est vivante et joue ce lot : worktree non retirable (arrêter la vague d'abord)`);
    return 2;
  }
  const gone = removeTree({ repo, dir: k.dir ?? '', branch: k.branch, base: k.base }, { abandon: args.abandonCommits });
  if (!gone.ok) {
    io.err(gone.dirty ? `orchestrate : ${key} : fichiers suivis modifiés dans le worktree (${gone.dirty.join(', ')}), --abandon-commits pour les abandonner` : gone.untracked ? `orchestrate : ${key} : fichiers non suivis dans le worktree (${gone.untracked.join(', ')}), --abandon-commits pour les abandonner` : `orchestrate : ${key} : ${gone.unintegrated} commit(s) non intégré(s), --abandon-commits pour les abandonner`);
    return 2;
  }
  io.out(`orchestrate : ${key} : worktree retiré (${gone.abandoned} commit(s) abandonné(s))`);
  return 0;
}

/** Point d'entrée de `cadence orchestrate`. 0 prêts · 1 rendus au lead · 2 refus avant d'agir · 3 suspendue (budget, quota). */
export async function orchestrate(argv: string[], io: OrchestrateIo, deps: OrchestrateDeps): Promise<number> {
  const args = parseOrchestrateArgs(argv);
  const launch = io.cwd;
  const today: Day = io.env.RAF_TODAY && isDay(io.env.RAF_TODAY) ? io.env.RAF_TODAY : toDay(io.now());

  if ((args.until !== undefined || args.priority !== undefined) && !args.continue) throw new RafError('--until et --priority s\'utilisent avec --continue');
  if (args.until !== undefined) args.untilAt = parseUntil(args.until, io.now()); // heure invalide ou passée : refus avant d'agir
  if (args.continue) priorityOf(args, launch); // une clé priority: illisible du cadence.yaml : refus avant d'agir, lots donnés ou non
  if (args.watch && args.status === undefined) throw new RafError('--watch s\'utilise avec --status');
  if (args.interval !== undefined && !args.watch) throw new RafError('--interval s\'utilise avec --status --watch');
  // --drop / --stop-after-current (L79) pilotent une vague VIVANTE : ni avec --status (rien à piloter), ni --stop-after-current avec --resume (il le contredit). --resume --drop retire le lot avant de rejouer la vague arrêtée.
  if (args.status !== undefined && (args.drop.length || args.stopAfterCurrent)) throw new RafError('--status ne se combine pas avec --drop / --stop-after-current');
  if (args.resume !== undefined && args.stopAfterCurrent) throw new RafError('--resume ne se combine pas avec --stop-after-current (il reprend la vague, il ne l\'arrête pas)');
  // L228 : la reprise n'a pas de simulation — elle relève le budget, réécrit wave.json et relance les sessions. Refusée ici, avant le réexec de l'instantané (une vague ancienne ne connaît pas ce refus).
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
  if (args.status !== undefined) {
    maxSessions(args, io); // une valeur invalide est refusée ici aussi
    if (!args.watch) {
      const { live, table } = statusView(args, launch, configuredCap(io.env, args.maxSessions), io.now());
      for (const line of live) io.out(line);
      if (!table) return 0; // sans identifiant : les vagues vivantes suffisent
      if (live.length) io.out('');
      for (const line of table) io.out(line);
      return 0;
    }
    // --watch : le même tableau, rafraîchi ; il s'arrête seul quand plus aucune vague ne tourne (le dernier rendu reste affiché)
    const sleep = deps.watchSleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    for (;;) {
      const { live, table, running } = statusView(args, launch, configuredCap(io.env, args.maxSessions), io.now());
      io.out(CLEAR_SCREEN);
      for (const line of live) io.out(line);
      if (table) {
        if (live.length) io.out('');
        for (const line of table) io.out(line);
      }
      if (!running) return 0;
      io.out('');
      io.out(`rafraîchi toutes les ${args.interval ?? DEFAULT_WATCH_INTERVAL} s — Ctrl-C pour quitter`);
      await sleep((args.interval ?? DEFAULT_WATCH_INTERVAL) * 1000);
    }
  }
  if (args.removeWorktree) return removeWorktree(args, io);
  if (args.resume !== undefined) return resume(args, argv, io, deps, launch, today);
  if (args.drop.length || args.stopAfterCurrent) return control(args, io);

  if (args.lots.length === 0 && !args.continue) throw new RafError('usage : cadence orchestrate <projet>:<lot>… [--budget 2M] [--max-sessions 2] [--dry-run] [--continue [--until 18:00] [--priority a,b]] | --waits [--since AAAA-MM-JJ] | --status [vague] [--watch [--interval 10]] | --resume [vague] [--answer projet:lot "réponse"] [--integrate projet:lot] [--replay projet:lot] | --drop projet:lot | --stop-after-current | --remove-worktree projet:lot [--abandon-commits]');
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
    dryRun(pre.lots, io, deps, budget, id);
    if (args.continue) for (const l of freeLines(launch, pre.lots)) io.out(l);
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
    const code = await continueRounds(await execute(wave, pre.lots, store, io, deps, today, maxSessions(args, io)), wave, pre.lots, store, io, deps, today, args, launch);
    abandon();
    return code;
  } catch (e) {
    abandon();
    throw e;
  }
}


const priorityOf = (args: Args, launch: string) => args.priority ?? readPriority(launch);

/**
 * Tire jusqu'à `n` lots prêts du plan (L147), dans l'ordre de priorité, et les passe au contrôle préalable comme un lot donné :
 * un lot refusé est sauté, sa cause rendue dans `skipped`. `exclude` reçoit chaque lot tiré ou refusé pour lui-même, pas ceux d'un
 * dépôt refusé ni un lot qui ne tient pas dans le reste du budget (il tiendra peut-être au tour suivant).
 * Un tour tire au plus UN lot par dépôt (le pool joue à la suite les lots d'un même dépôt, `--max-sessions` ne servirait à rien) ;
 * les lots écartés pour cela complètent le tour, dans l'ordre, quand aucun autre dépôt n'a de lot prêt.
 */
async function draw(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string, exclude: Set<string>, remaining: number, n: number): Promise<{ lots: LotState[]; skipped: string[] }> {
  const lots: LotState[] = [];
  const skipped: string[] = [];
  const badRepos = new Set<string>();
  const used = new Set<string>();
  type Pre = Awaited<ReturnType<typeof preflight>>;
  const deferred: { c: Candidate; repo: string; pre?: Pre }[] = [];
  /** `spread` : premier passage, un dépôt déjà pris ce tour renvoie le lot au second ; sinon (second passage) le lot complète le tour. */
  const attempt = async (c: Candidate, repo: string, spread: boolean, checked?: Pre): Promise<void> => {
    const key = lotKey(c.project, c.lot.id);
    if (badRepos.has(repo)) return;
    if (spread && used.has(repo)) return void deferred.push({ c, repo });
    const pre = checked ?? (await preflight(args, [{ project: c.project, projectDir: c.dir, repo, lot: c.lot.id, model: 'sonnet' }], io, deps, launch));
    if (pre.refusals.length) {
      // Un refus propre au lot l'écarte pour la vague ; celui d'un dépôt (arbre sale, orchestration en cours, pre-push) est passager :
      // le dépôt est sauté pour ce tirage seulement, une ligne, et ses lots restent tirables au suivant.
      const own = pre.refusals.filter((r) => r.startsWith(`${key} : `));
      if (own.length) exclude.add(key);
      if (own.length < pre.refusals.length) badRepos.add(repo);
      skipped.push(...pre.refusals.filter((r) => !skipped.includes(r)));
      return;
    }
    const lot = pre.lots[0];
    if (lot.budget! > remaining) return; // pas exclu : le budget du tour suivant le permettra peut-être
    if (spread && lotRepoPaths(lot).some((r) => used.has(r))) return void deferred.push({ c, repo, pre }); // un dépôt voisin déjà pris ce tour
    exclude.add(key);
    remaining -= lot.budget!;
    lots.push(lot);
    for (const r of lotRepoPaths(lot)) used.add(r);
  };
  for (const c of candidates(launch, { priority: priorityOf(args, launch), exclude, remaining })) {
    if (lots.length >= n) break;
    const repo = gitRoot(c.dir);
    if (repo) await attempt(c, repo, true);
  }
  for (const d of deferred) {
    if (lots.length >= n) break;
    await attempt(d.c, d.repo, false, d.pre);
  }
  return { lots, skipped };
}

/** Nombre de tours que la simulation de `--dry-run --continue` déroule au plus. */
const DRY_RUN_ROUNDS = 10;

/**
 * `--dry-run --continue` : ce que les tirages suivants joueraient, par tour, avec la même fonction `draw` que la vague (un lot par dépôt
 * par tour, contrôle préalable, budget) ; les lots sautés disent pourquoi. Le budget est décompté sur l'estimation des lots tirés
 * (la consommation réelle n'est pas connue). `firstSkipped` : causes écartées au premier tirage, quand il a fourni les lots donnés.
 */
async function continueDryRun(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string, given: LotState[], budget: number, firstSkipped: string[]): Promise<void> {
  io.out(`--continue : priorité ${priorityOf(args, launch).join(' > ') || '(aucune déclarée : ordre alphabétique)'}${args.until ? ` · jusqu'à ${args.until}` : ''}`);
  const said = new Set<string>();
  const skip = (causes: string[]) => {
    for (const s of causes) {
      if (said.has(s)) continue;
      said.add(s);
      io.out(`  lot sauté — ${s}`);
    }
  };
  skip(firstSkipped);
  const exclude = new Set(given.map((l) => lotKey(l.project, l.lot)));
  let remaining = budget - given.reduce((sum, l) => sum + (l.budget ?? 0), 0);
  const cap = maxSessions(args, io);
  const rounds: string[] = [];
  for (let round = 1; round <= DRY_RUN_ROUNDS && remaining > 0; round++) {
    const drawn = await draw(args, io, deps, launch, exclude, remaining, cap);
    skip(drawn.skipped);
    if (drawn.lots.length === 0) break;
    rounds.push(`tour ${round} : ${drawn.lots.map((l) => lotKey(l.project, l.lot)).join(', ')}`);
    remaining -= drawn.lots.reduce((sum, l) => sum + (l.budget ?? 0), 0);
  }
  io.out(rounds.length ? `  tirés ensuite, par tour (budget décompté sur les estimations) : ${rounds.join(' · ')}${rounds.length === DRY_RUN_ROUNDS ? ' · …' : ''}` : '  aucun autre lot prêt à tirer');
}

/** Lots rendus ou en échec de suite, en comptant depuis le dernier lot de la vague. */
function handedBackStreak(all: LotState[]): number {
  let n = 0;
  for (const l of [...all].reverse()) {
    if (l.status === 'handed-back' || l.status === 'failed') n++;
    else break;
  }
  return n;
}

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
    code = await execute(wave, drawn.lots, store, io, deps, today, cap, all);
    if (code === 2) return code;
  }
}

function contexts(lots: LotState[], envs: ReturnType<typeof projectEnv>[], wctx: WaveCtx): LotCtx[] {
  return lots.map((lot, i) => ({ wave: wctx, lot, config: envs[i].config, loadPlan: envs[i].loadPlan }));
}

/**
 * Quels lots jouent dans un worktree (L279). Un groupe de lots du même dépôt (`groupLots`) y joue si `orchestrate.worktrees` est vrai, s'il a au moins deux lots,
 * si le dépôt est sur une branche et si aucun de ses lots n'a de dépôt voisin (`repos:`, R2) ; sinon les lots restent à la suite, avec un avertissement qui dit pourquoi.
 * Un lot dont la branche existe déjà (reprise, R11) retrouve son worktree quel que soit le groupe ; un lot rendu à l'intégration dont la branche a disparu n'en reçoit pas. La branche de départ est celle du dépôt du lead à cet instant,
 * ou celle que la branche du lot a notée à sa création.
 */
function planTrees(ctxs: LotCtx[], store: RunStore, wave: string, log: (line: string) => void, env: Record<string, string | undefined>): void {
  for (const group of groupLots(ctxs)) {
    const repo = group[0].lot.repo;
    const branch = repoBranch(repo);
    const requested = group.length > 1 && group.every((c) => worktreesEnabled(c.config, env));
    const why = !requested ? null : group.some((c) => c.lot.repos?.length) ? 'des lots du groupe ont des dépôts voisins (repos:)' : !branch ? 'le dépôt est en HEAD détaché' : null;
    if (why) log(`orchestrate : ${basename(repo)} : worktrees demandés mais ${why} : lots joués à la suite`);
    for (const c of group) {
      const lotBr = lotBranch(wave, c.lot.project, c.lot.lot);
      // Chemin de reprise d'un lot rendu hors intégration : sa branche d'une vague passée devient celle de cette vague (recoverTree), puis se retrouve comme une reprise (R11).
      const dir = lotTreeDir(store.dir, c.lot.project, c.lot.lot, repo);
      const recovered = !baseBranchOf(repo, lotBr) && c.lot.next !== 'integrate' && branch && worktreesEnabled(c.config, env, true) ? recoverTree(repo, lotBr, dir, branch) : null;
      if (recovered) log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : branche ${recovered.from} d'une vague précédente reprise (${recovered.unintegrated} commit(s) non intégré(s)) : le lot repart de son travail`);
      const known = baseBranchOf(repo, lotBr);
      const base = known ?? branch;
      // Un lot repris à l'intégration dont la branche n'existe plus (retirée par --remove-worktree --abandon-commits) n'a plus de commits à intégrer : pas de worktree recréé au sommet, `integrateLot` le rend.
      if (c.lot.next === 'integrate' && !known) continue;
      if (((requested && !why) || (known && worktreesEnabled(c.config, env, true))) && base) c.tree = { dir, branch: lotBr, base, active: false };
    }
  }
}

/** Pose les verrous et les hooks, joue la vague, range l'état, rend le tableau et le code de sortie. */
async function execute(wave: WaveState, lots: LotState[], store: RunStore, io: OrchestrateIo, deps: OrchestrateDeps, today: Day, cap: number, all: LotState[] = lots): Promise<number> {
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
  /** Lots que la vague joue à la fois sur les dépôts qu'elle tient encore (un par dépôt, un par lot en worktree) : ce que le registre compte pour les créneaux libres. Absent (undefined) tant qu'aucun lot ne joue dans un worktree : le calcul reste celui des dépôts tenus. */
  const lanes = (): number | undefined => ctxs.some((c) => c.tree) ? groupLots(ctxs).filter((g) => g.every((c) => lotRepoPaths(c.lot).every((r) => !freed.has(r)))).reduce((n, g) => n + (g.every((c) => c.tree) ? g.length : 1), 0) : undefined; // hors mode worktree, rien n'est écrit : le registre compte les dépôts tenus, comme avant L279
  const freeRepo = (r: string) => {
    freed.add(r);
    const file = join(sharedStateDir(r), REPO_LOCK);
    releaseLock(file, process.pid);
    held.splice(0, held.length, ...held.filter((f) => f !== file));
    removePrePush(r, wave.id);
    try {
      updateWaveRepos(home, process.pid, repos.filter((x) => !freed.has(x)), lanes());
    } catch {
      // registre illisible : `--status` garde la liste de départ, le verrou est bien tombé
    }
  };
  const release = () => {
    for (const f of held) releaseLock(f, process.pid);
    held.length = 0;
    for (const r of repos) if (!freed.has(r)) removePrePush(r, wave.id);
    try {
      unregisterWave(home, process.pid);
    } catch {
      // registre illisible : l'entrée d'un processus mort est écartée à la prochaine inscription
    }
  };

  for (const r of repos) {
    const file = join(sharedStateDir(r), REPO_LOCK);
    const l = takeLock(file, { pid: process.pid, wave: wave.id, started: new Date().toISOString() });
    if (!l.ok) {
      io.err(`orchestrate : ${basename(r)} : une orchestration y est déjà en cours (${l.held.wave}, pid ${l.held.pid})`);
      release();
      return 2;
    }
    held.push(file);
    if (l.stale) io.err(`orchestrate : verrou de dépôt périmé retiré (${basename(r)}, pid ${l.stale.pid} mort)`);
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
  const claude: ClaudeFn = async (args, o) => {
    const free = await acquireSlot(home, cap, {
      wave: wave.id,
      pollMs: deps.slotPollMs,
      onWait: (h, ms) => wctx.log(`${o.lot ? `${o.lot} · ` : ''}en attente d'un créneau de session depuis ${duration(ms)} (${h.length}/${cap} en cours : ${[...new Set(h.map((x) => x.wave))].join(', ')})`),
      onGot: (ms) => wctx.log(`${o.lot ? `${o.lot} · ` : ''}créneau de session obtenu après ${duration(ms)} d'attente`),
    });
    try {
      return await deps.claude(args, o);
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
  const wctx: WaveCtx = {
    id: wave.id,
    store,
    budget,
    claude,
    agents: agentsOf(deps),
    today,
    claudeHome: deps.claudeHome,
    templates,
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
  planTrees(ctxs, store, wave.id, wctx.log, io.env);
  try {
    updateWaveRepos(home, process.pid, repos, lanes());
  } catch {
    // registre illisible : le décompte des créneaux libres reste celui des dépôts
  }

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
  try {
    await runPool(ctxs, cap, all, (c) => {
      // Un lot rendu ou en échec garde son worktree et sa branche (R12) : le journal en donne le chemin.
      if (c.tree?.active && c.lot.status !== 'ready') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : worktree conservé : ${c.tree.dir} (branche ${c.tree.branch})`);
      // Un lot rendu à l'étape d'intégration (`next: integrate`) : la ligne donne la commande qui le reprend (L279, R27).
      if (c.tree?.active && c.lot.status === 'handed-back' && c.lot.next === 'integrate') wctx.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : rendu à l'intégration : reprise par cadence orchestrate --resume ${wctx.id} --integrate ${lotKey(c.lot.project, c.lot.lot)}`);
      // Un dépôt dont tous les lots de la vague (reprise comprise) sont prêts ou rendus peut être livré pendant que la vague continue ailleurs.
      if (wctx.incident) return;
      for (const r of lotRepoPaths(c.lot)) {
        if (held.includes(join(sharedStateDir(r), REPO_LOCK)) && all.filter((l) => lotRepoPaths(l).includes(r)).every(finished)) freeRepo(r);
      }
    }, (lots) => lots.every((c) => c.tree));
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
  for (const line of renderTable(wave, all)) io.out(line);
  for (const line of keptLines(all.map((l) => l.repo))) io.out(line); // les worktrees conservés, avec leur chemin (R19)
  if (wave.status === 'suspended-budget' || wave.status === 'suspended-quota') return 3;
  return all.every((l) => l.status === 'ready') ? 0 : 1;
}

/** `--drop` / `--stop-after-current` (L79) : une demande écrite dans le dossier d'état de la vague vivante ; c'est elle qui la lit avant sa prochaine session. */
function control(args: Args, io: OrchestrateIo): number {
  const flags = '--drop / --stop-after-current';
  if (args.lots.length || args.continue || args.dryRun || args.budget !== undefined || args.answers.length) throw new RafError(`${flags} ne se combinent pas avec des lots à lancer, --continue, --dry-run, --budget ou --answer`);
  const live = liveWaves(cadenceHome()).filter((w) => w.cwd === io.cwd && (args.wave === undefined || w.wave === args.wave));
  if (live.length === 0) {
    io.err(`orchestrate : ${flags} : aucune vague en cours${args.wave ? ` (${args.wave})` : ''} lancée depuis ce dossier`);
    return 2;
  }
  if (live.length > 1) {
    io.err(`orchestrate : ${flags} : plusieurs vagues tournent depuis ce dossier (${live.map((w) => w.wave).join(', ')}) : précisez --wave`);
    return 2;
  }
  const store = RunStore.find(io.cwd, live[0].wave);
  if (!store) {
    io.err(`orchestrate : ${flags} : dossier d'état de la vague ${live[0].wave} introuvable`);
    return 2;
  }
  const lots = store.lots();
  const refusals: string[] = [];
  const keys: string[] = [];
  for (const d of args.drop) {
    const matches = lots.filter((l) => l.lot === d.lot && (d.project ? l.project === d.project : true));
    const where = `${d.project ? `${d.project}:` : ''}${d.lot}`;
    if (matches.length !== 1) refusals.push(matches.length ? `--drop ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--drop ${where} : lot inconnu dans la vague ${store.id}`);
    else if (lotFinished(matches[0])) refusals.push(`--drop ${lotKey(matches[0].project, matches[0].lot)} : le lot est déjà fini (${matches[0].status})`);
    else keys.push(lotKey(matches[0].project, matches[0].lot));
  }
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  // La demande est écrite quoi qu'il arrive (le fichier est inoffensif) ; mais une vague d'avant L79 ne le lira jamais : on le dit.
  if (!waveReadsControl(store.dir)) io.err(`orchestrate : ${flags} : la vague ${store.id} ne lit pas les demandes de contrôle (lancée avec une version de cadence d'avant L79) : la demande est écrite dans control.log mais cette vague ne la lira pas`);
  for (const k of keys) {
    store.requestDrop(k);
    store.journal(`demande : retirer ${k} de la vague`);
    io.out(`${k} : retrait demandé — la vague ${store.id} l'écarte avant sa prochaine session (la session en cours finit)`);
  }
  if (args.stopAfterCurrent) {
    store.requestStopAfterCurrent();
    store.journal('demande : arrêt après les sessions en cours');
    io.out(`vague ${store.id} : arrêt demandé — les sessions en cours finissent, aucune autre ne part ; reprise par « cadence orchestrate --resume ${store.id} »`);
  }
  return 0;
}

async function resume(args: Args, argv: string[], io: OrchestrateIo, deps: OrchestrateDeps, launch: string, today: Day): Promise<number> {
  const store = typeof args.resume === 'string' ? RunStore.find(launch, args.resume) : RunStore.last(launch, { unfinished: true });
  if (!store) throw new RafError(typeof args.resume === 'string' ? `vague inconnue : ${args.resume}` : 'aucune vague à reprendre dans ce dossier');
  if (deps.snapshot) {
    // La reprise tourne sur l'instantané de la vague, jamais sur le dist/ courant ; une vague d'avant L61 n'en a pas.
    if (snapshotExists(store.dir)) {
      // Une vague d'avant L223 refuserait « projet:lot=+N » comme budget invalide : seul le lot visé justifie de la rejouer avec le dist/ courant.
      if ((!args.lotBudgets.length || waveReadsLotBudget(store.dir)) && (!args.integrate.length || waveReadsIntegrate(store.dir)) && (!args.integrate.some((t) => t.replay) || waveReadsReplay(store.dir))) return deps.snapshot.reexec(toolDirOf(store.dir), argv, io.env, io);
      io.err(`orchestrate : vague ${store.id} : son instantané ne connaît pas ${args.lotBudgets.length && !waveReadsLotBudget(store.dir) ? '--budget projet:lot=+N (antérieur à L223)' : `${args.integrate.some((t) => t.replay) && waveReadsIntegrate(store.dir) ? '--replay' : '--integrate'} (antérieur à L279)`} : reprise avec le dist/ et les gabarits courants`);
    } else {
      io.err(`orchestrate : vague ${store.id} sans instantané (antérieure à L61) : reprise avec le dist/ et les gabarits courants`);
    }
  }
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
  // --resume --budget projet:lot=+N (L223) : un lot rendu sur budget est remis en jeu avec son budget relevé. Il subit ensuite les gardes d'un lot vivant.
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
    else raised.set(l, { from: l.budget ?? lotSpent(l), to: lotSpent(l) + b.raise, step: budgetStep(l)! });
  }
  // --resume --integrate projet:lot (L279, R27) : un lot rendu à l'étape d'intégration (next: integrate) n'est rejoué que si le lead le nomme. Ni --resume seul, ni --drop, --answer ou --budget ne le rejouent.
  const integ: LotState[] = [];
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
    else if (l.status !== 'handed-back' || (l.next !== 'integrate' && !(t.replay && planNoteHandBack(l)))) refusals.push(`${opt} ${key} : le lot n'est pas rendu ${t.replay ? "à l'étape d'intégration ni sur une écriture de plan refusée" : "à l'étape d'intégration"} (${l.status}, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'})`);
    else integ.push(l);
  }
  // L279 : la garde d'activation du mode worktree vaut aussi à la reprise (--resume, --integrate, --replay) : un lot repris dont la configuration demande les worktrees, ou dont la branche est à retrouver, est refusé sans la variable, avant toute écriture.
  for (const l of lots) {
    if (lotFinished(l) && !raised.has(l) && !integ.includes(l)) continue;
    if (drops.includes(lotKey(l.project, l.lot))) continue;
    let config: { worktrees: boolean };
    try {
      config = projectEnv(l.repo).config;
    } catch {
      continue; // un cadence.yaml illisible est refusé par execute, comme avant
    }
    const br = lotBranch(wave.id, l.project, l.lot);
    const refused = worktreesRefusal(lotKey(l.project, l.lot), config, io.env, baseBranchOf(l.repo, br) ? br : undefined);
    if (refused) refusals.push(refused);
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
  for (const repo of new Set(live.flatMap(lotRepoPaths))) {
    const busy = activeLock(join(sharedStateDir(repo), REPO_LOCK));
    if (busy && busy.pid !== process.pid) refusals.push(`${basename(repo)} : une orchestration y est déjà en cours (${busy.wave}, pid ${busy.pid})`);
  }
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
    const planNote = l.next !== 'integrate'; // rendu sur une écriture de plan refusée (--replay) : le lot repart de l'étape gardée
    if (planNote && l.outcome?.startsWith(HYPOTHESES_HANDBACK)) l.hypotheses = undefined; // les notes d'hypothèses se posent de nouveau (sans doublon) à l'entrée de l'étape
    l.status = 'suspended';
    l.outcome = null;
    const text = planNote ? `écriture du plan reprise à l'étape ${l.next} (--resume --replay)` : 'intégration reprise (--resume --integrate)';
    store.journal(`${k} → suspended — ${text}`);
    io.out(`${k} → suspended — ${text}`);
  }
  for (const l of live) {
    if (l.status === 'implementing' || l.status === 'reviewing' || l.status === 'fixing') l.status = 'suspended';
    store.writeLot(l);
  }
  if (args.budget !== undefined) wave.budget = wave.consumed + args.budget;
  store.clearStopRequest(); // un arrêt demandé à la vague d'avant ne doit pas arrêter celle-ci
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
    for (const line of renderTable(wave, lots)) io.out(line);
    for (const line of keptLines(lots.map((l) => l.repo))) io.out(line);
    return removed.length && !lots.every((l) => l.status === 'ready') ? 1 : 0;
  }
  return continueRounds(await execute(wave, live, store, io, deps, today, maxSessions(args, io), lots), wave, lots, store, io, deps, today, args, launch);
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
    agentsDir: AGENTS_DIR,
    snapshot: child ? undefined : { packageRoot: PACKAGE_ROOT, reexec: spawnReexec },
    claudeHome: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  };
}
