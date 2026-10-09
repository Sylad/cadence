import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { planLoader, readOrchestrateConfig, type OrchestrateConfig } from '../config.js';
import { isDay, toDay, type Day } from '../dates.js';
import { gitRoot, hooksDir } from '../git.js';
import { onTermination } from '../proc.js';
import { stopApps } from './app.js';
import { Plan, RafError, isOpen } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { pidAlive, sharedStateDir } from '../state.js';
import { acquireSlot, cadenceHome, freeSlots, liveSlots, liveWaves, registerWave, unregisterWave, updateWaveRepos } from './registry.js';
import { loadTemplates, newsText, objective, renderBrief, type BriefVars } from './briefs.js';
import { candidates, parsePriority, parseUntil, readPriority, stopReason, type Candidate } from './continue.js';
import { Budget, DROPPED, MAX_PASSES, countInterrupted, handBackDroppedQuestions, needsPrecheck, type LotCtx, type WaveCtx } from './cycle.js';
import { canInstallPrePush, installPrePush, removePrePush, snapshot } from './guard.js';
import { buildArgs, killSessions, mcpServersFor, readAgents, realClaude, type AgentDef, type ClaudeFn, type Model } from './launch.js';
import { activeLock, REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { runPool } from './pool.js';
import { schemaFor } from './schemas.js';
import { resolveLotRepos } from '../repos.js';
import { excludeState, lotFinished, lotKey, lotRepoPaths, lotSlug, neighbourDirs, newLot, RunStore, type LotState, type WaveState } from './state.js';
import { linkNodeBin, nvmVersionsDir, resolveNode, type NodeChoice } from './node-env.js';
import { quotaText, renderTable } from './table.js';
import { PACKAGE_ROOT, RESERVED_ENV, SnapshotRefusal, isSnapshotChild, resolveModulesDir, snapshotExists, waveReadsControl, withoutLaunchVars, spawnReexec, takeSnapshot, toolDirOf, type SnapshotDeps } from './snapshot.js';

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
}

export const DEFAULT_BUDGET = 2_000_000;

/** Tokens comptés par jour d'estimate (L78) ; mesuré le 06-10 : des lots de 0,5 j ont mangé 192 à 531 k, des lots de 1 j 455 à 468 k (2 M pour 6 lots). Depuis le plancher de L128 (450 k), ce plafond ne borne plus que les lots de plus de 1,125 j : les 5 lots du 06-10 passent tous. */
const LOT_BUDGET_PER_DAY = 400_000;
/**
 * Plancher (L128) : de quoi payer, dans le pire cas mesuré, une écriture, sa revue, une passe de correction et la revue
 * courte qui la suit (65 k, cf. REVIEW_RESERVE). Mesures de tous les `.cadence/runs/*` : passes fix médiane 45 k, p90 63 k,
 * max 112 k ; passes implement médiane 60 k, p90 93 k, max 282 k (L62). Pire cas : L62, 14 k de contrôle + 282 k d'écriture
 * + 80 k de revue = 376 k, plus 65 k de réserve = 441 k < 450 k, la passe fix part. Corrige L126 (200 k, rendu à la 2e passe) ;
 * L62 (estimate 1,5, donc 600 k) n'est pas changé par le plancher, la réserve de L145 couvre déjà sa correction et sa revue.
 */
const LOT_BUDGET_FLOOR = 450_000;

/** Budget d'un lot, dérivé de son estimate : empêche quelques lots d'avaler le budget de la vague au détriment des autres. */
export const lotBudget = (estimate: number): number => Math.max(LOT_BUDGET_FLOOR, Math.round(estimate * LOT_BUDGET_PER_DAY));
/** Sessions simultanées, toutes vagues confondues (`--max-sessions`, ou CADENCE_MAX_SESSIONS). */
export const DEFAULT_MAX_SESSIONS = 2;

export interface Args {
  lots: { project?: string; lot: string; model?: Model }[];
  dryRun: boolean;
  status?: string | true;
  watch: boolean;
  /** Secondes entre deux rendus de `--status --watch`. */
  interval?: number;
  resume?: string | true;
  budget?: number;
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
const LOT_LIKE = /^(?:[\w.-]+:[\w.-][\w./-]*|[\w.-]+\/[\w./-]*|[A-Za-z]+\d+)(?:@\w+)?$/;
const MODELS = ['sonnet', 'opus', 'haiku'];

function lotArg(text: string): { project?: string; lot: string; model?: Model } {
  // le premier « : » sépare le projet du lot, un « @ » final le modèle ; le lot garde ses « / » (L120)
  const m = /^(?:([\w.-]+):)?([\w.-][\w./-]*?)(?:@(\w+))?$/.exec(text);
  if (!m) throw new RafError(`lot invalide : ${text} (projet:lot, lot, projet:lot@haiku)`);
  if (m[3] && !MODELS.includes(m[3])) throw new RafError(`modèle inconnu : @${m[3]} (attendu : ${MODELS.join(', ')})`);
  return { project: m[1], lot: m[2], model: m[3] as Model | undefined };
}

export function parseOrchestrateArgs(argv: string[]): Args {
  const a: Args = { lots: [], dryRun: false, watch: false, continue: false, answers: [], drop: [], stopAfterCurrent: false };
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
    } else if (t === '--watch') a.watch = true;
    else if (t === '--interval') a.interval = parseMaxSessions(value(t), '--interval');
    else if (t === '--budget') a.budget = parseBudget(value(t));
    else if (t === '--max-sessions') a.maxSessions = parseMaxSessions(value(t));
    else if (t === '--wave') a.wave = value(t);
    else if (t === '--drop') a.drop.push(lotArg(value(t)));
    else if (t === '--stop-after-current') a.stopAfterCurrent = true;
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

const isProject = (dir: string) => existsSync(join(dir, 'docs/plan/raf.yaml')) || (existsSync(join(dir, 'cadence.yaml')) && /^plan\s*:/m.test(readFileSync(join(dir, 'cadence.yaml'), 'utf8')));

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
      refusals.push(`${key} : ${projectDir} n'est pas un projet cadence (docs/plan/raf.yaml, ou cadence.yaml avec une clé plan:)`);
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
    const state = newLot({ project: t.project, repo: t.repo, lot: t.lot, title: lot.title, visible: lot.visible, small, model: t.model, readOnlyPlan: plan.readonly });
    if (neighbours.repos.length) state.repos = neighbours.repos;
    state.light = lot.estimate <= env.config.review.threshold;
    state.budget = lotBudget(lot.estimate);
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
    io.out(`  budget du lot : ${l.budget} tokens comptés (dérivé de l'estimate)`);
    io.out(`  file ${basename(l.repo)} · ${slot < 2 ? `créneau ${slot + 1}` : 'en attente d\'un créneau'}`);
    if (l.repos?.length) io.out(`  dépôts voisins : ${l.repos.map((r) => r.rel).join(', ')} (verrou, garde de push et --add-dir ; leurs commits citent ${l.lot})`);
    if (l.node) {
      const sk = l.node.skipped;
      const skipped = sk?.length ? ` ; ${sk.join(', ')} ${sk.length > 1 ? 'écartées' : 'écartée'} : pas de node exécutable` : '';
      io.out(`  node : ${l.node.version} (.nvmrc ${l.node.wanted}${skipped})`);
    }
    const steps: { kind: 'precheck' | 'implement' | 'ux' | 'review' | 'review-small'; model: Model }[] = [{ kind: 'implement', model: l.model }];
    if (needsPrecheck(env.config, env.loadPlan(), l.repo, l.lot, l.repos)) steps.unshift({ kind: 'precheck', model: 'sonnet' });
    const { light, full } = env.config.review;
    if (l.small) steps.push({ kind: l.visible ? 'review-small' : 'review', model: l.light ? light : full });
    else {
      if (l.visible && env.config.ux) steps.push({ kind: 'ux', model: full });
      steps.push({ kind: 'review', model: l.light ? light : full });
    }
    io.out(`  étapes : ${steps.map((s) => `${s.kind} (${s.model})`).join(' → ')}${l.small ? ' — petit lot' : ''}${l.light ? ` — revue légère (${light}, pas de passe des mineurs ; un bloquant ou un majeur → correction puis revue ${full})` : ''}${l.visible && !env.config.ux ? ' — UX à faire par le lead (orchestrate.ux absent)' : ''}`);
    io.out(`  corrections : ${MAX_PASSES} passe(s) au plus, en session neuve`);
    io.out(l.light ? '  revue conforme avec mineurs : pas de passe des mineurs, ils sont rendus en notes' : '  revue conforme avec mineurs : une passe de correction des mineurs (session neuve), puis une revue courte ; les mineurs refusés sont rendus en « choix »');
    const pwDir = join(resolve(RunStore.runsDir(io.cwd)), id, lotSlug(l.project, l.lot), 'playwright');
    // brief écrit par --dry-run = base d'une délégation à la main : aucun dossier de vague (il n'existe pas)
    const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: lot.title, objectif: objective(lot), commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: l.visible ? newsText(l.lot) : '', captures: '' };
    for (const s of steps) {
      const file = join(tmp, `${lotSlug(l.project, l.lot)}--${s.kind}.md`);
      const brief = renderBrief(s.kind, vars, deps.templatesDir);
      writeFileSync(file, brief);
      const playwright = !!mcpServersFor(s.kind, l.visible, '', l.small).playwright;
      const args = buildArgs(
        { kind: s.kind, sessionId: '<uuid>', brief: '<brief>', model: s.model, effort: env.config.effort[s.kind === 'review-small' ? 'review' : s.kind], schema: schemaFor(s.kind), agent: s.kind === 'implement' ? undefined : s.kind === 'ux' ? 'ux-reviewer' : s.kind === 'precheck' ? 'precheck-reader' : 'code-reviewer', cwd: l.repo, wave: id, permissionMode: env.config.permissionMode, addDirs: [...env.config.addDirs, ...(playwright && s.kind === 'implement' ? [pwDir] : []), ...neighbourDirs(l)], timeoutMs: 0, mcpConfig: '<mcp>', playwright },
        agents,
      ).map((a) => (a.startsWith('{') ? '<json>' : a));
      io.out(`  ${s.kind} : claude ${args.join(' ')}`);
      io.out(`    brief : ${file}`);
      const servers = Object.keys(mcpServersFor(s.kind, l.visible, '', l.small));
      io.out(`    mcp : ${servers.length ? `${servers.join(', ')} (captures dans le dossier de la vague : <vague>/${lotSlug(l.project, l.lot)}/playwright)` : 'aucun'}`);
    }
  }
}

function maxSessions(args: Args, io: OrchestrateIo): number {
  if (args.maxSessions !== undefined) return args.maxSessions;
  const env = io.env.CADENCE_MAX_SESSIONS;
  return env ? parseMaxSessions(env, 'CADENCE_MAX_SESSIONS') : DEFAULT_MAX_SESSIONS;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Vagues vivantes (toutes, quel que soit leur dossier de départ), créneaux libres et dépôts qu'elles tiennent. */
export function liveLines(): string[] {
  const home = cadenceHome();
  const waves = liveWaves(home);
  if (waves.length === 0) return [];
  const slots = liveSlots(home).length;
  const lines = [`vagues en cours : ${waves.length} · sessions en cours : ${slots} · créneaux libres : ${freeSlots(waves, DEFAULT_MAX_SESSIONS)} sur ${DEFAULT_MAX_SESSIONS}`];
  for (const w of waves) lines.push(`  ${w.wave} (pid ${w.pid}, depuis ${w.started}) lancée depuis ${w.cwd} · plafond ${w.cap ?? '?'} · dépôts : ${w.repos.join(', ')}`);
  return lines;
}

/** Efface l'écran et replace le curseur en haut : l'entrée d'un rendu de `--status --watch`. */
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
const DEFAULT_WATCH_INTERVAL = 10;

/** Ce que `--status` montre à un instant : les vagues vivantes, puis le tableau (absent si seules les vagues vivantes comptent). */
function statusView(args: Args, launch: string): { live: string[]; table?: string[]; running: boolean } {
  const store = typeof args.status === 'string' ? RunStore.find(launch, args.status) : RunStore.last(launch);
  const live = liveLines();
  if (!store && live.length && args.status === true) return { live, running: true };
  if (!store) throw new RafError(typeof args.status === 'string' ? `vague inconnue : ${args.status}` : 'aucune vague dans ce dossier');
  // `running` : la vague suivie tourne — pour un <id> explicite, elle seule compte, pas les autres vagues de la machine
  const running = typeof args.status === 'string' ? liveWaves(cadenceHome()).some((w) => w.wave === store.readWave()!.id) : live.length > 0;
  return { live, table: renderTable(store.readWave()!, store.lots()), running };
}

/** Refus d'une `--wave` déjà existante, identique en simulation et au vrai lancement. */
function waveExists(wave: string, io: OrchestrateIo): number {
  io.err(`orchestrate : --wave ${wave} : cette vague existe déjà`);
  return 2;
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
  if (args.status !== undefined) {
    maxSessions(args, io); // une valeur invalide est refusée ici aussi
    if (!args.watch) {
      const { live, table } = statusView(args, launch);
      for (const line of live) io.out(line);
      if (!table) return 0; // sans identifiant : les vagues vivantes suffisent
      if (live.length) io.out('');
      for (const line of table) io.out(line);
      return 0;
    }
    // --watch : le même tableau, rafraîchi ; il s'arrête seul quand plus aucune vague ne tourne (le dernier rendu reste affiché)
    const sleep = deps.watchSleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    for (;;) {
      const { live, table, running } = statusView(args, launch);
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
  if (args.resume !== undefined) return resume(args, argv, io, deps, launch, today);
  if (args.drop.length || args.stopAfterCurrent) return control(args, io);

  if (args.lots.length === 0 && !args.continue) throw new RafError('usage : cadence orchestrate <projet>:<lot>… [--budget 2M] [--max-sessions 2] [--dry-run] [--continue [--until 18:00] [--priority a,b]] | --status [vague] [--watch [--interval 10]] | --resume [vague] [--answer projet:lot "réponse"] | --drop projet:lot | --stop-after-current');
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
  const freeRepo = (r: string) => {
    freed.add(r);
    const file = join(sharedStateDir(r), REPO_LOCK);
    releaseLock(file, process.pid);
    held.splice(0, held.length, ...held.filter((f) => f !== file));
    removePrePush(r, wave.id);
    try {
      updateWaveRepos(home, process.pid, repos.filter((x) => !freed.has(x)));
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
      onWait: (h, ms) => wctx.log(`en attente d'un créneau de session depuis ${duration(ms)} (${h.length}/${cap} en cours : ${[...new Set(h.map((x) => x.wave))].join(', ')})`),
      onGot: (ms) => wctx.log(`créneau de session obtenu après ${duration(ms)} d'attente`),
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
  };
  wave.status = 'running';
  wave.pid = process.pid;
  saveWave();
  const ctxs = contexts(lots, envs, wctx);

  // Ctrl-C, SIGTERM : les sessions sont tuées en bloc, les étapes marquées interrompues, les verrous et hooks libérés.
  const forget = onTermination(async () => {
    killSessions();
    await stopApps(); // les applications de la revue UX : SIGTERM, SIGKILL après 10 s
    for (const c of ctxs) {
      for (const s of c.lot.steps) {
        if (s.status === 'running') s.status = 'interrupted';
        // Les tokens d'une session tuée comptent : relus dans son journal.
        if (s.status === 'interrupted') countInterrupted(deps.claudeHome, c.lot.repo, s, budget);
      }
      if (c.lot.status === 'implementing' || c.lot.status === 'reviewing' || c.lot.status === 'fixing') c.lot.status = 'suspended';
      store.writeLot(c.lot);
    }
    wave.status = 'interrupted';
    saveWave();
    release();
  });
  const finished = lotFinished;
  try {
    await runPool(ctxs, cap, all, (c) => {
      // Un dépôt dont tous les lots de la vague (reprise comprise) sont prêts ou rendus peut être livré pendant que la vague continue ailleurs.
      if (wctx.incident) return;
      for (const r of lotRepoPaths(c.lot)) {
        if (held.includes(join(sharedStateDir(r), REPO_LOCK)) && all.filter((l) => lotRepoPaths(l).includes(r)).every(finished)) freeRepo(r);
      }
    });
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
    if (snapshotExists(store.dir)) return deps.snapshot.reexec(toolDirOf(store.dir), argv, io.env, io);
    io.err(`orchestrate : vague ${store.id} sans instantané (antérieure à L61) : reprise avec le dist/ et les gabarits courants`);
  }
  const wave = store.readWave()!;
  const refusals: string[] = [];
  const info = deps.claudeInfo();
  if (!info) refusals.push('claude introuvable (CADENCE_CLAUDE_BIN, ou claude dans le PATH)');
  const alive = liveWaves(cadenceHome()).find((w) => w.wave === wave.id && w.cwd === launch && w.pid !== process.pid);
  if (alive) refusals.push(`la vague ${alive.wave} tourne encore (pid ${alive.pid})`);
  if (wave.status === 'done') refusals.push(`la vague ${wave.id} est terminée`);

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
  // Un lot retiré ne jouera rien : il ne subit ni le verrou du dépôt, ni le .nvmrc, ni l'arbre sale — un refus pour LUI ne doit pas faire échouer la reprise des autres.
  const live: LotState[] = [];
  const removed: LotState[] = [];
  for (const l of lots) {
    if (lotFinished(l)) continue;
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
  for (const l of [...live, ...removed]) for (const s of l.steps) if (s.status === 'interrupted') countInterrupted(deps.claudeHome, l.repo, s, recovered);
  wave.consumed += recovered.consumed;
  wave.cacheRead += recovered.cacheRead;
  if (recovered.consumed || recovered.cacheRead) store.writeWave(wave);
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
  }
  if (live.length === 0) {
    if (lots.every(lotFinished)) {
      wave.status = 'done';
      store.writeWave(wave);
    }
    for (const line of renderTable(wave, lots)) io.out(line);
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
    claude: realClaude(bin, env),
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
