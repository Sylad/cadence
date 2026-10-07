import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readOrchestrateConfig, readPlanConfig, type OrchestrateConfig } from '../config.js';
import { isDay, toDay, type Day } from '../dates.js';
import { gitRoot, hooksDir } from '../git.js';
import { onTermination } from '../proc.js';
import { stopApps } from './app.js';
import { Plan, RafError, isOpen } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { pidAlive, sharedStateDir } from '../state.js';
import { acquireSlot, cadenceHome, liveSlots, liveWaves, registerWave, unregisterWave } from './registry.js';
import { loadTemplates, newsText, objective, renderBrief, type BriefVars } from './briefs.js';
import { Budget, MAX_PASSES, countInterrupted, type LotCtx, type WaveCtx } from './cycle.js';
import { canInstallPrePush, installPrePush, removePrePush, snapshot } from './guard.js';
import { buildArgs, killSessions, mcpServersFor, readAgents, realClaude, type AgentDef, type ClaudeFn, type Model } from './launch.js';
import { activeLock, REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { runPool } from './pool.js';
import { schemaFor } from './schemas.js';
import { excludeState, lotKey, newLot, RunStore, type LotState, type WaveState } from './state.js';
import { linkNodeBin, nvmVersionsDir, resolveNode, type NodeChoice } from './node-env.js';
import { quotaText, renderTable } from './table.js';
import { PACKAGE_ROOT, RESERVED_ENV, SnapshotRefusal, isSnapshotChild, resolveModulesDir, snapshotExists, withoutLaunchVars, spawnReexec, takeSnapshot, toolDirOf, type SnapshotDeps } from './snapshot.js';

export interface OrchestrateIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

export interface OrchestrateDeps {
  claude: ClaudeFn;
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
/** Sessions simultanées, toutes vagues confondues (`--max-sessions`, ou CADENCE_MAX_SESSIONS). */
export const DEFAULT_MAX_SESSIONS = 2;

export interface Args {
  lots: { project?: string; lot: string; model?: Model }[];
  dryRun: boolean;
  status?: string | true;
  resume?: string | true;
  budget?: number;
  maxSessions?: number;
  wave?: string;
  answers: { project?: string; lot: string; text: string }[];
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

const LOT_LIKE = /^(?:[\w.-]+:)?[A-Za-z]+\d+(?:@\w+)?$/;
const MODELS = ['sonnet', 'opus', 'haiku'];

function lotArg(text: string): { project?: string; lot: string; model?: Model } {
  const m = /^(?:([\w.-]+):)?([\w.-]+?)(?:@(\w+))?$/.exec(text);
  if (!m) throw new RafError(`lot invalide : ${text} (projet:lot, lot, projet:lot@haiku)`);
  if (m[3] && !MODELS.includes(m[3])) throw new RafError(`modèle inconnu : @${m[3]} (attendu : ${MODELS.join(', ')})`);
  return { project: m[1], lot: m[2], model: m[3] as Model | undefined };
}

export function parseOrchestrateArgs(argv: string[]): Args {
  const a: Args = { lots: [], dryRun: false, answers: [] };
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
    } else if (t === '--budget') a.budget = parseBudget(value(t));
    else if (t === '--max-sessions') a.maxSessions = parseMaxSessions(value(t));
    else if (t === '--wave') a.wave = value(t);
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
  const planConfig = readPlanConfig(configPath, repo);
  const planPath = resolve(repo, planConfig?.path ?? 'docs/plan/raf.yaml');
  return { config: readOrchestrateConfig(configPath), loadPlan: () => Plan.load(planPath, { ...planConfig?.settings, config: configPath }), configPath };
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
    byProject.set(t.project, [...earlier, t.lot]);
    if (!repoChecked.has(t.repo)) {
      repoChecked.add(t.repo);
      const dirty = await trackedDirty(t.repo);
      if (dirty.length) refusals.push(`${basename(t.repo)} : arbre sale, ${dirty.length} fichier(s) suivi(s) modifié(s) : ${dirty.join(', ')}`);
      const hook = canInstallPrePush(t.repo);
      if (hook) refusals.push(`${basename(t.repo)} : ${hook}`);
      const busy = activeLock(join(sharedStateDir(t.repo), REPO_LOCK));
      if (busy && !opts.resume) refusals.push(`${basename(t.repo)} : une orchestration y est déjà en cours (${busy.wave}, pid ${busy.pid})`);
    }
    const node = resolveNode(t.repo, nvmVersionsDir(io.env));
    if (node.kind === 'missing') {
      refusals.push(`${key} : ${node.message}`);
      continue;
    }
    const small = lot.estimate <= 0.5 || lot.quickwin;
    const state = newLot({ project: t.project, repo: t.repo, lot: t.lot, title: lot.title, visible: lot.visible, small, model: t.model, readOnlyPlan: plan.readonly });
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
    io.out(`  file ${basename(l.repo)} · ${slot < 2 ? `créneau ${slot + 1}` : 'en attente d\'un créneau'}`);
    if (l.node) {
      const sk = l.node.skipped;
      const skipped = sk?.length ? ` ; ${sk.join(', ')} ${sk.length > 1 ? 'écartées' : 'écartée'} : pas de node exécutable` : '';
      io.out(`  node : ${l.node.version} (.nvmrc ${l.node.wanted}${skipped})`);
    }
    const steps: { kind: 'precheck' | 'implement' | 'ux' | 'review' | 'review-small'; model: Model }[] = [{ kind: 'implement', model: l.model }];
    if (env.config.precheck) steps.unshift({ kind: 'precheck', model: 'sonnet' });
    if (l.small) steps.push({ kind: l.visible ? 'review-small' : 'review', model: 'opus' });
    else {
      if (l.visible && env.config.ux) steps.push({ kind: 'ux', model: 'opus' });
      steps.push({ kind: 'review', model: 'opus' });
    }
    io.out(`  étapes : ${steps.map((s) => `${s.kind} (${s.model})`).join(' → ')}${l.small ? ' — petit lot' : ''}${l.visible && !env.config.ux ? ' — UX à faire par le lead (orchestrate.ux absent)' : ''}`);
    io.out(`  corrections : ${MAX_PASSES} passe(s) au plus, en session neuve`);
    io.out('  revue conforme avec mineurs : une passe de correction des mineurs (session neuve), puis une revue courte ; les mineurs refusés sont rendus en « choix »');
    const pwDir = join(resolve(RunStore.runsDir(io.cwd)), id, `${l.project}--${l.lot}`, 'playwright');
    // brief écrit par --dry-run = base d'une délégation à la main : aucun dossier de vague (il n'existe pas)
    const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: lot.title, objectif: objective(lot), commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: l.visible ? newsText(l.lot) : '', captures: '' };
    for (const s of steps) {
      const file = join(tmp, `${l.project}--${l.lot}--${s.kind}.md`);
      const brief = renderBrief(s.kind, vars, deps.templatesDir);
      writeFileSync(file, brief);
      const playwright = !!mcpServersFor(s.kind, l.visible, '', l.small).playwright;
      const args = buildArgs(
        { kind: s.kind, sessionId: '<uuid>', brief: '<brief>', model: s.model, schema: schemaFor(s.kind), agent: s.kind === 'implement' ? undefined : s.kind === 'ux' ? 'ux-reviewer' : s.kind === 'precheck' ? 'precheck-reader' : 'code-reviewer', cwd: l.repo, wave: id, permissionMode: env.config.permissionMode, addDirs: playwright && (s.kind === 'implement') ? [...env.config.addDirs, pwDir] : env.config.addDirs, timeoutMs: 0, mcpConfig: '<mcp>', playwright },
        agents,
      ).map((a) => (a.startsWith('{') ? '<json>' : a));
      io.out(`  ${s.kind} : claude ${args.join(' ')}`);
      io.out(`    brief : ${file}`);
      const servers = Object.keys(mcpServersFor(s.kind, l.visible, '', l.small));
      io.out(`    mcp : ${servers.length ? `${servers.join(', ')} (captures dans le dossier de la vague : <vague>/${l.project}--${l.lot}/playwright)` : 'aucun'}`);
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

/** Vagues vivantes (toutes, quel que soit leur dossier de départ) et dépôts qu'elles tiennent. */
function liveLines(): string[] {
  const home = cadenceHome();
  const waves = liveWaves(home);
  if (waves.length === 0) return [];
  const slots = liveSlots(home).length;
  const lines = [`vagues en cours : ${waves.length} · sessions en cours : ${slots}`];
  for (const w of waves) lines.push(`  ${w.wave} (pid ${w.pid}, depuis ${w.started}) lancée depuis ${w.cwd} · plafond ${w.cap ?? '?'} · dépôts : ${w.repos.join(', ')}`);
  return lines;
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

  if (args.status !== undefined) {
    const store = typeof args.status === 'string' ? RunStore.find(launch, args.status) : RunStore.last(launch);
    maxSessions(args, io); // une valeur invalide est refusée ici aussi
    const live = liveLines();
    for (const line of live) io.out(line);
    if (!store && live.length && args.status === true) return 0; // sans identifiant : les vagues vivantes suffisent
    if (!store) throw new RafError(typeof args.status === 'string' ? `vague inconnue : ${args.status}` : 'aucune vague dans ce dossier');
    if (live.length) io.out('');
    for (const line of renderTable(store.readWave()!, store.lots())) io.out(line);
    return 0;
  }
  if (args.resume !== undefined) return resume(args, argv, io, deps, launch, today);

  if (args.lots.length === 0) throw new RafError('usage : cadence orchestrate <projet>:<lot>… [--budget 2M] [--max-sessions 2] [--dry-run] | --status [vague] | --resume [vague] [--answer projet:lot "réponse"]');
  const refusals: string[] = [];
  const targets = resolveTargets(args, io, refusals);
  const pre = await preflight(args, targets, io, deps, launch);
  refusals.push(...pre.refusals);
  const budget = args.budget ?? DEFAULT_BUDGET;
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  if (args.wave !== undefined && !WAVE_ID_RE.test(args.wave)) throw new RafError(`--wave invalide : ${args.wave}`);
  if (args.dryRun) {
    const id = waveId(io, args.wave, launch);
    if (args.wave && existsSync(join(RunStore.runsDir(launch), id))) return waveExists(args.wave, io);
    dryRun(pre.lots, io, deps, budget, id);
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
    const code = await execute(wave, pre.lots, store, io, deps, today, maxSessions(args, io));
    abandon();
    return code;
  } catch (e) {
    abandon();
    throw e;
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
  const repos = [...new Set(lots.map((l) => l.repo))];
  const release = () => {
    for (const f of held) releaseLock(f, process.pid);
    held.length = 0;
    for (const r of repos) removePrePush(r, wave.id);
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
  try {
    await runPool(ctxs, cap, all);
  } finally {
    forget();
    const finished = (l: LotState) => l.status === 'ready' || l.status === 'handed-back' || l.status === 'failed';
    // « done » = plus rien à reprendre : une question en attente ou un lot suspendu garde la vague reprenable.
    wave.status = wctx.incident ? 'interrupted' : wctx.quota.hit ? 'suspended-quota' : lots.some((l) => l.status === 'suspended') ? 'suspended-budget' : all.every(finished) ? 'done' : 'interrupted';
    saveWave();
    release();
  }
  if (wctx.incident) io.err(`orchestrate : incident — ${wctx.incident}`);
  if (wctx.quota.hit) io.err(`orchestrate : quota atteint — ${quotaText(wctx.quota.message ?? '')}`.trim());
  for (const line of renderTable(wave, all)) io.out(line);
  if (wave.status === 'suspended-budget' || wave.status === 'suspended-quota') return 3;
  return all.every((l) => l.status === 'ready') ? 0 : 1;
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
  const live: LotState[] = [];
  for (const l of lots) {
    const finished = l.status === 'ready' || l.status === 'handed-back' || l.status === 'failed';
    if (finished) continue;
    for (const s of l.steps) {
      if (s.status !== 'running') continue;
      if (s.pid && pidAlive(s.pid)) refusals.push(`${lotKey(l.project, l.lot)} : session encore en vie, pid ${s.pid}`);
      else s.status = 'interrupted';
    }
    live.push(l);
  }
  // Comme au départ : un dépôt tenu par une autre orchestration vivante est refusé avant toute écriture.
  for (const repo of new Set(live.map((l) => l.repo))) {
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
  for (const l of live) for (const s of l.steps) if (s.status === 'interrupted') countInterrupted(deps.claudeHome, l.repo, s, recovered);
  wave.consumed += recovered.consumed;
  wave.cacheRead += recovered.cacheRead;
  if (recovered.consumed || recovered.cacheRead) store.writeWave(wave);
  for (const l of live) {
    if (l.status === 'implementing' || l.status === 'reviewing' || l.status === 'fixing') l.status = 'suspended';
    store.writeLot(l);
  }
  if (args.budget !== undefined) wave.budget = wave.consumed + args.budget;
  const dirty = new Set<string>();
  for (const l of live) if (!dirty.has(l.repo)) {
    dirty.add(l.repo);
    const d = await trackedDirty(l.repo);
    if (d.length) refusals.push(`${basename(l.repo)} : arbre sale, ${d.length} fichier(s) suivi(s) modifié(s) : ${d.join(', ')}`);
  }
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  if (live.length === 0) {
    for (const line of renderTable(wave, lots)) io.out(line);
    return 0;
  }
  return execute(wave, live, store, io, deps, today, maxSessions(args, io), lots);
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
