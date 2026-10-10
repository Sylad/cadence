import { execFileSync, spawn } from 'node:child_process';
import { toolBinOf, withoutLaunchVars } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import { coveredTasks, lotCommits, lotWork } from '../audit.js';
import { readDocsConfig, type OrchestrateConfig } from '../config.js';
import { docSyncBrief, docSyncGaps, filesOf } from '../docsync.js';
import type { Day } from '../dates.js';
import { readCommits, resolveCommit, type Commit } from '../git.js';
import { citedRefs } from '../link.js';
import { repoShas, repoWork, type LotRepo } from '../repos.js';
import { isOpen, type Plan } from '../plan.js';
import { isPlanOnly } from '../audit.js';
import { APP_TIMEOUT_S, startApp, type AppState } from './app.js';
import { capturesText, newsText, objective, renderBrief, reposText, type BriefName, type BriefVars, type Templates } from './briefs.js';
import { journalTokens, peakContext, mcpServersFor, playwrightDir, runSession, trackGroup, writeMcpConfig, type AgentDef, type ClaudeFn, type Model, type StepKind, type StepModel } from './launch.js';
import { cleanPlaywrightOutput, pushed, snapshot, type Snapshot } from './guard.js';
import type { Tokens } from './result.js';
import { checkShape, PRECHECK_SCHEMA, REVIEW_SCHEMA, schemaFor, WORK_SCHEMA, type PrecheckReport, type ReviewReport, type WorkReport } from './schemas.js';
import type { Constat, LotState, ReviewSummary, RunStore, StepState } from './state.js';
import { lotKey, lotRepoPaths, neighbourDirs } from './state.js';

/** Passes de correction au plus, puis la main est rendue au lead. */
export const MAX_PASSES = 2;

export class Budget {
  consumed = 0;
  cacheRead = 0;
  constructor(public limit: number) {}
  add(t: Tokens): void {
    this.consumed += t.counted;
    this.cacheRead += t.cacheRead;
  }
  get exhausted(): boolean {
    return this.consumed >= this.limit;
  }
}

/**
 * Compte au budget les tokens d'une étape tuée (signal) ou retrouvée morte (reprise), relus dans le journal de sa
 * session (`--session-id`). Une étape déjà comptée (`tokens`) ne l'est jamais deux fois. Vrai quand quelque chose a été compté.
 */
export function countInterrupted(claudeHome: string | undefined, repo: string, step: StepState, budget: Budget): boolean {
  if (!claudeHome || !step.sessionId || step.tokens || step.model === 'local') return false; // le modèle local n'a rien pris au quota
  const spent = journalTokens(claudeHome, repo, step.sessionId);
  if (!spent) return false;
  step.tokens = spent.tokens;
  step.peakContext = peakContext(claudeHome, repo, step.sessionId);
  budget.add(spent.tokens);
  return true;
}

export interface WaveCtx {
  id: string;
  store: RunStore;
  budget: Budget;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  today: Day;
  /** ~/.claude : pour relire le pic de contexte des sessions. */
  claudeHome?: string;
  /** Gabarits des briefs, lus une fois au début de la vague (et à sa reprise) : modifier un fichier en cours de vague ne change rien. */
  templates: Templates;
  quota: { hit: boolean; message?: string };
  /** Push ou revue qui a modifié le dépôt : la vague s'arrête. */
  incident: string | null;
  /** Dépôts salis par une revue (L133) → lot en cause : les lots qui restent dans leur file sont suspendus, ceux des autres dépôts continuent. */
  dirtyRepos?: Map<string, string>;
  log: (line: string) => void;
  saveWave: () => void;
}

export interface LotCtx {
  wave: WaveCtx;
  lot: LotState;
  config: OrchestrateConfig;
  loadPlan: () => Plan;
  /** Issue du lancement de l'application par le programme, le temps de l'étape qui la voit (L60). */
  app?: AppState;
}

const TERMINAL = new Set(['ready', 'handed-back', 'failed']);

const short = (c: { sha: string; subject: string }) => `${c.sha.slice(0, 7)} ${c.subject}`;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function save(c: LotCtx): void {
  c.wave.store.writeLot(c.lot);
}

function transition(c: LotCtx, status: LotState['status'], outcome?: string): void {
  c.lot.status = status;
  if (outcome !== undefined) c.lot.outcome = outcome;
  save(c);
  c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} → ${status}${outcome ? ` — ${outcome}` : ''}`);
}

const stop = (c: LotCtx, status: 'handed-back' | 'failed', outcome: string): null => {
  c.lot.next = null;
  transition(c, status, outcome);
  return null;
};

/** Fichiers suivis modifiés (chemins), d'après `git status --porcelain`. */
function trackedPaths(s: Snapshot): string[] {
  return s.tracked.map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

/** Commit d'entretien du plan, chemins explicites. Rend un message d'arbre sale quand autre chose que le plan a bougé. */
async function commitPlan(c: LotCtx, message: string): Promise<string | null> {
  const repo = c.lot.repo;
  const plan = c.loadPlan();
  const own = new Set([relative(repo, plan.path), ...plan.maintained]);
  const dirty = trackedPaths(await snapshot(repo, { remote: false }));
  if (dirty.length === 0) return null;
  const foreign = dirty.filter((f) => !own.has(f));
  if (foreign.length) return `arbre sale (fichiers hors plan) : ${foreign.join(', ')}`;
  git(repo, 'add', '--', ...dirty);
  git(repo, 'commit', '-q', '-m', message, '--', ...dirty);
  return null;
}

const shEscape = (s: string) => s.replace(/\s+/g, ' ').replace(/[\\"$`]/g, '\\$&');

/** Commande du projet, asynchrone : la boucle d'événements reste libre (délai de l'autre créneau, signaux). Son groupe est tué au délai et au signal. */
function sh(c: LotCtx, command: string, timeoutMs = 30 * 60_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: c.lot.repo, env: withoutLaunchVars(process.env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pid = child.pid;
    if (pid === undefined) {
      child.once('error', (e) => resolve({ code: 127, output: String(e.message) }));
      return;
    }
    const untrack = trackGroup(pid);
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (d: Buffer) => {
      if (size < 64 * 1024 * 1024) chunks.push(d);
      size += d.length;
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      untrack();
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // groupe vide
      }
      resolve({ code: code ?? (signal ? 137 : 1), output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** Démarre le lot : raf start (plan écrit par raf) ou la commande du projet (plan en lecture seule), puis commit du plan. */
async function startLot(c: LotCtx): Promise<string | null> {
  const plan = c.loadPlan();
  const lot = plan.lot(c.lot.lot);
  if (!isOpen(lot.status)) return `le lot est ${lot.status}`;
  if (lot.status === 'todo') {
    if (plan.readonly) {
      if (!c.config.start) return 'plan en lecture seule : démarrer le lot avec l\'outil du projet';
      const r = await sh(c, c.config.start.replaceAll('{lot}', c.lot.lot));
      if (r.code !== 0) return `orchestrate.start en échec (code ${r.code}) : ${r.output.trim().split('\n').slice(-3).join(' ')}`;
    } else {
      plan.setStatus(c.lot.lot, 'doing', c.wave.today);
      plan.save();
    }
    const dirty = await commitPlan(c, `plan: ${c.lot.lot} démarré (orchestrate ${c.wave.id})`);
    if (dirty) return dirty;
  }
  return null;
}

function lotCommitLines(c: LotCtx): string {
  const plan = c.loadPlan();
  const mine = lotWork(plan, c.lot.repo, c.lot.lot).reverse().map((k) => `- ${short(k)}`);
  const theirs = (c.lot.repos ?? []).flatMap((r) => repoWork(plan, r, c.lot.lot).reverse().map((k) => `- [${r.rel}] ${short(k)}`));
  return [...mine, ...theirs].join('\n');
}

/** Le lot a déjà du travail (commits citant le lot) dans son dépôt ou dans un dépôt voisin. */
function hasWork(plan: Plan, l: Pick<LotState, 'repo' | 'repos' | 'lot'>): boolean {
  return lotWork(plan, l.repo, l.lot).length > 0 || (l.repos ?? []).some((r) => repoWork(plan, r, l.lot).length > 0);
}

function constatLines(constats: Constat[]): string {
  return constats
    .map((k) => `- [${k.gravite}${k.source === 'code' ? '' : ` / ${k.source}`}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`)
    .join('\n');
}

/** Consigne de captures : `uxText` n'alimente que `ux` et `review-small` d'un petit lot visible, deux étapes qui chargent toujours le serveur Playwright de la vague. */
const SHOTS_TEXT = 'Take screenshots at 1440 and 390 px width, each with a relative file name only (e.g. `home-1440px.png`): they land in the wave\'s capture directory, outside the repository.';

function uxText(c: LotCtx): string {
  const ux = c.config.ux;
  if (!ux) {
    return 'No way to run the app is declared (cadence.yaml: orchestrate.ux): review the interface from the code, and list under "nonVerifie" what you could not see.';
  }
  if (c.app?.kind === 'ready') return [`The running app is at ${ux.url}.`, SHOTS_TEXT].join(' ');
  if (c.app) return `The app could not be verified (${c.app.kind === 'busy' ? 'the port is already in use' : 'it did not start'}): review the interface from the code, and list under "nonVerifie" what you could not see.`;
  return [
    ux.url ? `The running app is at ${ux.url}.` : '',
    ux.command ? `Start the app with: ${ux.command} (from the repository root), and stop it when you are done.` : '',
    SHOTS_TEXT,
  ]
    .filter(Boolean)
    .join(' ');
}

function choixText(choix: string[]): string {
  if (!choix.length) return '';
  return ['The author decided these interpretation questions on its own; re-read each choice against the lot, its notes and the code, and report a finding if one is wrong or changes the scope:', ...choix.map((x) => `- ${x}`)].join('\n');
}

/** Tests et build déjà lancés par le programme au HEAD relu : le relecteur ne les refait pas (L75). Vide si HEAD a bougé depuis ou si rien n'a tourné. */
function checksText(c: LotCtx): string {
  const k = c.lot.checks;
  if (!k?.runs.length || k.head !== git(c.lot.repo, 'rev-parse', 'HEAD')) return '';
  const runs = k.runs.map((r) => `- \`${r.command}\` (${r.label}): ${r.code === 0 ? 'green' : `RED, exit code ${r.code}`}`);
  return [`The program already ran these checks at HEAD ${k.head.slice(0, 7)}, just before this review:`, ...runs, 'Take these results as given: do not rebuild, do not rerun the whole suite, and do not wait on them. Run only a check they do not cover (a targeted test of a case you doubt), and list under "nonVerifie" what neither they nor you verified.'].join('\n');
}

/** Consigne docs.sync du brief de revue (L143) : calculée sur les commits du lot au moment de la revue, pas écrite d'avance. */
function docsText(c: LotCtx): string {
  const plan = c.loadPlan();
  const { sync } = readDocsConfig(plan.configFile ?? join(c.lot.repo, 'cadence.yaml'));
  if (!sync.length) return '';
  return docSyncBrief(sync, docSyncGaps(sync, filesOf(c.lot.repo, lotWork(plan, c.lot.repo, c.lot.lot))));
}

/** Gabarit d'une étape : la passe des mineurs et la revue courte qui la suit ont chacune le leur. */
function briefName(l: LotState, kind: StepKind): BriefName {
  if (kind === 'fix' && l.minorFix) return 'fix-minors';
  if (kind === 'review-small' && l.minorPass && !(l.small && l.visible)) return 'review-recheck';
  return kind;
}

function briefFor(c: LotCtx, kind: StepKind): string {
  const plan = c.loadPlan();
  const l = c.lot;
  const lot = plan.lot(l.lot);
  const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: lot.title, objectif: objective(lot), commits: '', reponse: '', constats: '', ux: uxText(c), choix: choixText(c.lot.choix ?? []), checks: kind === 'review' || kind === 'review-small' ? checksText(c) : '', docs: kind === 'review' || kind === 'review-small' ? docsText(c) : '', news: '', captures: '', repos: reposText(kind === 'implement' || kind === 'fix' ? 'write' : 'read', l.lot, l.repos ?? []) };
  if (l.visible) {
    const pwDir = playwrightDir(c.wave.store.lotDir(l.project, l.lot));
    vars.news = newsText(l.lot, pwDir);
    vars.captures = capturesText(pwDir);
  }
  if (kind === 'implement' || kind === 'fix') {
    const interrupted = [...l.steps].reverse().find((s) => s.kind === kind && s.status === 'interrupted');
    if (kind === 'fix') {
      vars.commits = lotCommitLines(c);
      vars.constats = constatLines(l.constats);
    } else if (interrupted) {
      const mine = lotCommitLines(c);
      vars.commits = mine
        ? `A previous session was interrupted; resume from these commits of the lot already present:\n${mine}`
        : 'A previous session was interrupted before any commit of the lot; start again from the current state of the repository.';
    }
    if (kind === 'implement' && l.precheck) vars.commits = [vars.commits, l.precheck].filter(Boolean).join('\n');
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  return renderBrief(briefName(l, kind), vars, c.wave.templates);
}

/** Les dépôts voisins du lot, vus avant et après une session. */
type Others = { repo: LotRepo; before: Snapshot; after: Snapshot }[];

type Done = { step: StepState; report: unknown; before: Snapshot; after: Snapshot; others: Others };

/** Tokens comptés par les sessions d'un lot (un lot repris compte ses étapes d'avant). */
export const lotSpent = (l: LotState): number => l.steps.reduce((n, s) => n + (s.tokens?.counted ?? 0), 0);

/** Le lot a dépensé son propre budget (L78) : il ne compte plus que sur le lead, la vague garde le sien pour les autres. */
const lotOver = (l: LotState): boolean => l.budget !== undefined && lotSpent(l) >= l.budget;

/**
 * Coût réservé à la revue qui suit une passe de correction (L145). Réserve fixe de 65 k tokens comptés, proche du p90 des
 * revues complètes. Mesure faite le 2026-10-09 sur les journaux `.cadence/runs/*` (67 dossiers de vague du 04 au 09-10,
 * `tokens.counted` des `N-review.json`, `N-review-small.json`, `N-ux.json` ; aucun journal `ux` conservé, 2 `review-small`
 * sans `tokens.counted` écartés ; p90 par interpolation linéaire) : 187 revues, médiane 43,4 k, p90 62,7 k, max 105,9 k ;
 * 114 revues courtes (review-small, après la passe des mineurs), médiane 37,4 k, p90 67,6 k, max 82,7 k ; ensemble des
 * 301 revues, médiane 42,3 k, p90 67,0 k, max 105,9 k. La revue courte a donc un p90 plus haut que la revue complète : 65 k
 * couvre 170 revues sur 187 (90,9 %) mais 99 revues courtes sur 114 (86,8 %). Une passe fix ne part que s'il reste de quoi payer cette revue.
 * Seule exception : des tests rouges après une écriture (work() appelle toFix() sans revue) — la passe fix suivante peut
 * alors être refusée et le lot revient au lead sans revue, avec ses constats.
 */
export const REVIEW_RESERVE = 65_000;

/** Une passe de correction laisse-t-elle de quoi rejouer la revue dans le budget du lot ? Sans budget de lot : toujours. */
const fixAffordable = (l: LotState): boolean => l.budget === undefined || lotSpent(l) + REVIEW_RESERVE < l.budget;

/** Cause d'une suspension demandée par `--stop-after-current` (L79). */
export const STOP_REQUESTED = 'arrêt demandé (--stop-after-current)';

/** Le lot a-t-il été écarté de la vague par `--drop` (L79) ? */
const dropped = (c: LotCtx): boolean => c.wave.store.control().drops.includes(lotKey(c.lot.project, c.lot.lot));
export const DROPPED = 'retiré de la vague (--drop)';

/** Pourquoi plus aucune session ne doit partir (incident, quota, budget), sinon null. */
function halted(w: WaveCtx, lot?: LotState): string | null {
  if (w.store.control().stopAfterCurrent) return STOP_REQUESTED;
  if (w.incident) return `vague arrêtée : ${w.incident}`;
  if (lot && w.dirtyRepos) {
    for (const r of lotRepoPaths(lot)) {
      const by = w.dirtyRepos.get(r);
      if (by) return `dépôt ${r} sali par la revue de ${by} : à nettoyer par le lead avant de reprendre`;
    }
  }
  if (w.quota.hit) return 'quota atteint';
  if (w.budget.exhausted) return 'budget atteint';
  return null;
}

/** Modèle d'une revue (L108) : la revue légère d'un lot léger tant qu'aucune correction n'a eu lieu, sinon la revue complète (UX comprise). */
function reviewModel(c: LotCtx, kind: StepKind): Model {
  const { light, full } = c.config.review;
  return c.lot.light && c.lot.pass === 0 && (kind === 'review' || kind === 'review-small') ? light : full;
}

/** Une session : budget et quota vérifiés avant, état écrit avant et après, journal gardé, contrôles du dépôt après. */
/** Rendu par `session(…, true)` quand l'étape locale n'a rien donné (Ollama éteint, délai, rapport sans structure) : l'appelant se replie sur Sonnet (L146). */
const LOCAL_FAILED = Symbol('local-failed');

async function session(c: LotCtx, kind: StepKind, local: true): Promise<Done | null | typeof LOCAL_FAILED>;
async function session(c: LotCtx, kind: StepKind, local?: false): Promise<Done | null>;
async function session(c: LotCtx, kind: StepKind, local = false): Promise<Done | null | typeof LOCAL_FAILED> {
  const w = c.wave;
  const l = c.lot;
  if (dropped(c)) return stop(c, 'handed-back', DROPPED);
  const halt = halted(w, l);
  if (halt) return suspend(c, halt);
  const write = kind === 'implement' || kind === 'fix';
  // Le budget du lot borne l'écriture, jamais la revue (L145) : une revue est jouée dès que le code est à relire (sauf tests rouges après une écriture, cf. REVIEW_RESERVE), la passe fix réserve son coût.
  if (write && (lotOver(l) || (kind === 'fix' && !fixAffordable(l)))) return overBudget(c, kind === 'fix' && !lotOver(l));

  const model: StepModel = write ? l.model : local ? 'local' : kind === 'precheck' ? 'sonnet' : reviewModel(c, kind); // le contrôle préalable ne fait que lire : pas d'Opus
  const effort = c.config.effort[kind === 'review-small' ? 'review' : kind];
  const before = await snapshot(l.repo);
  const neighbours = l.repos ?? [];
  const beforeOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const n = l.steps.length + 1;
  const sessionId = randomUUID();
  const step: StepState = { n, kind, model, ...(effort !== 'default' ? { effort } : {}), status: 'running', sessionId, started: new Date().toISOString(), headBefore: before.head ?? undefined };
  l.steps.push(step);
  const label = { implement: 'implementing', fix: 'fixing', review: 'reviewing', ux: 'reviewing', 'review-small': 'reviewing', precheck: 'implementing' } as const;
  transition(c, label[kind]);
  w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} (${model})`);

  let brief: string;
  try {
    brief = briefFor(c, kind);
  } catch (e) {
    step.status = 'failed';
    step.cause = (e as Error).message;
    return stop(c, 'failed', `brief de ${kind} : ${(e as Error).message}`);
  }
  const mcpConfig = writeMcpConfig(w.store.lotDir(l.project, l.lot), kind, l.visible, l.small);
  const playwright = !!mcpServersFor(kind, l.visible, '', l.small).playwright;
  if (playwright) l.uxCaptures = join(dirname(mcpConfig), 'playwright');
  l.pendingAnswer = null; // la réponse est dans le brief : elle ne repart pas avec la session suivante
  const outcome = await runSession(
    {
      kind,
      sessionId,
      brief,
      model: local ? 'sonnet' : (model as Model),
      effort,
      local,
      schema: schemaFor(kind),
      agent: kind === 'ux' ? 'ux-reviewer' : kind === 'precheck' ? 'precheck-reader' : write ? undefined : 'code-reviewer',
      cwd: l.repo,
      wave: w.id,
      permissionMode: c.config.permissionMode,
      addDirs: [...c.config.addDirs, ...(playwright && write ? [playwrightDir(dirname(mcpConfig))] : []), ...neighbourDirs(l)],
      nodeBin: l.node?.link,
      toolBin: toolBinOf(w.store.dir),
      mcpConfig,
      playwright,
      timeoutMs: write ? c.config.timeouts.work : c.config.timeouts.review,
    },
    {
      claude: w.claude,
      agents: w.agents,
      onSpawn: (pid) => {
        step.pid = pid;
        save(c);
      },
    },
  );
  step.ended = new Date().toISOString();
  const dir = w.store.lotDir(l.project, l.lot);
  const base = `${n}-${kind}`;

  if (outcome.kind !== 'ok' && !local) {
    // Une session en échec, au quota ou tuée au délai a consommé des tokens : ceux de sa sortie, sinon ceux de son journal.
    const spent = outcome.tokens ? { tokens: outcome.tokens, sessionId: outcome.sessionId } : w.claudeHome ? journalTokens(w.claudeHome, l.repo, outcome.sessionId ?? sessionId) : null;
    if (spent) {
      step.tokens = spent.tokens;
      if (spent.sessionId) step.sessionId = spent.sessionId;
      w.budget.add(spent.tokens);
      w.saveWave();
      if (w.claudeHome && spent.sessionId) step.peakContext = peakContext(w.claudeHome, l.repo, spent.sessionId);
    }
  }
  if (local && outcome.kind !== 'ok') {
    // Hors quota Anthropic : rien au budget (ni sortie, ni journal), et jamais d'arrêt du lot — Sonnet reprend le contrôle.
    const cause = outcome.kind === 'failed' ? outcome.cause : outcome.message;
    writeFileSync(join(dir, `${base}.json`), outcome.kind === 'failed' ? outcome.stdout : '');
    if (outcome.kind === 'failed') writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.status = 'failed';
    step.cause = cause;
    step.report = `${base}.json`;
    delete step.tokens;
    l.warnings.push(`contrôle préalable : modèle local sans résultat (${cause.slice(0, 200)}), repli sur Sonnet`);
    save(c);
    return LOCAL_FAILED;
  }
  if (outcome.kind === 'failed') {
    if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
    writeFileSync(join(dir, `${base}.json`), outcome.stdout);
    writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.report = `${base}.json`;
    step.status = 'failed';
    step.cause = outcome.cause;
    return stop(c, 'failed', `${kind} sans résultat : ${outcome.cause}`);
  }
  if (outcome.kind === 'quota') {
    if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
    step.status = 'interrupted';
    step.cause = outcome.message;
    w.quota = { hit: true, message: outcome.message };
    w.saveWave();
    c.lot.next = kind;
    transition(c, 'suspended', 'quota atteint');
    return null;
  }

  const res = outcome.result;
  if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({ ...res, structured: res.structured }, null, 2));
  step.report = `${base}.json`;
  step.sessionId = res.sessionId;
  step.tokens = local ? { ...res.tokens, counted: 0 } : res.tokens; // local : hors quota, hors budget
  if (res.formattingRetry) {
    step.formatRetry = true;
    w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} : rapport sans sortie structurée, relance de mise en forme`);
  }
  if (!local) w.budget.add(res.tokens);
  w.saveWave();
  if (w.claudeHome) step.peakContext = peakContext(w.claudeHome, l.repo, res.sessionId);

  const after = await snapshot(l.repo);
  const afterOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const others: Others = neighbours.map((repo, i) => ({ repo, before: beforeOthers[i], after: afterOthers[i] }));
  step.headAfter = after.head ?? undefined;
  // Le dépôt du projet d'abord, puis chaque voisin : mêmes contrôles, l'incident nomme le dépôt voisin.
  const watched = [{ where: '', path: l.repo, before, after }, ...others.map((o) => ({ where: ` dans ${o.repo.rel}`, path: o.repo.path, before: o.before, after: o.after }))];
  for (const { where, path, before: b, after: a } of watched) {
    if (pushed(b, a)) {
      step.status = 'failed';
      step.cause = `push détecté${where}`;
      w.incident = `push détecté${where} pendant ${lotKey(l.project, l.lot)} (${kind})`;
      w.saveWave();
      return stop(c, 'failed', `incident : ${w.incident}`);
    }
    if (b.guard && !a.guard) {
      step.status = 'failed';
      step.cause = `le hook pre-push de garde a disparu${where}`;
      w.incident = `le hook pre-push de garde a été supprimé${where} pendant ${lotKey(l.project, l.lot)} (${kind})`;
      w.saveWave();
      return stop(c, 'failed', `incident : ${w.incident}`);
    }
    if (!write && (b.head !== a.head || b.tracked.join() !== a.tracked.join() || b.untracked.join() !== a.untracked.join())) {
      // Incident du LOT (L133) : la revue a laissé des traces (captures, commit), ni push ni garde supprimée — les lots des autres dépôts continuent.
      step.status = 'failed';
      step.cause = `le dépôt${where} a changé pendant une revue`;
      const traces = [...trackedPaths(a).filter((f) => !trackedPaths(b).includes(f)), ...a.untracked.filter((f) => !b.untracked.includes(f))];
      (w.dirtyRepos ??= new Map()).set(path, lotKey(l.project, l.lot));
      const what = traces.length ? ` (${traces.join(', ')})` : b.head !== a.head ? ' (commit)' : '';
      return stop(c, 'handed-back', `incident : ${kind} de ${lotKey(l.project, l.lot)} a modifié le dépôt${where}${what}${lostVerdict(c, kind, res.structured)}`);
    }
  }
  step.status = 'ok';
  save(c);
  return { step, report: res.structured, before, after, others };
}

/** Verdict d'une revue interrompue par un incident du lot : rapporté au lead plutôt que perdu (L133). Rien n'est enregistré dans le plan. */
function lostVerdict(c: LotCtx, kind: StepKind, report: unknown): string {
  if (kind === 'precheck') return '';
  let rep: ReviewReport;
  try {
    rep = checkShape<ReviewReport>(report, REVIEW_SCHEMA);
  } catch {
    return ' ; la revue n\'a pas rendu de verdict exploitable';
  }
  const s = summarize(rep, '');
  const text = `verdict de la revue avant l'incident : ${s.conforme ? 'conforme' : 'non conforme'} (${s.bloquants} bloquant(s), ${s.majeurs} majeur(s), ${s.mineurs} mineur(s)) — « ${s.verdict} » — non enregistré dans le plan, à confirmer par le lead`;
  c.lot.warnings.push(text);
  return ` ; ${text}`;
}

/**
 * Budget du lot atteint avant une session d'écriture : le lot est rendu au lead (reprendre ne lui rendrait pas de budget), les autres continuent.
 * `reserve` : le budget n'est pas dépensé, mais la passe fix ne laisserait pas de quoi rejouer la revue (L145).
 */
function overBudget(c: LotCtx, reserve = false): null {
  const l = c.lot;
  // Une réponse du lead encore en attente n'a pas été consommée : elle ne doit pas se perdre sans qu'on le dise.
  const answer = l.pendingAnswer ? ` ; la réponse du lead (« ${l.pendingAnswer} ») n'a pas été jouée` : '';
  const why = reserve ? `budget du lot : ${lotSpent(l)} / ${l.budget} tokens comptés (dérivé de l'estimate), il ne reste pas de quoi payer la revue qui suivrait la correction (${REVIEW_RESERVE} réservés)` : `budget du lot atteint (${lotSpent(l)} / ${l.budget} tokens comptés, dérivé de l'estimate)`;
  // Tests rouges après une écriture : la passe fix refusée aurait suivi, le lot revient sans revue (L145) — la cause le dit.
  const red = l.next === 'fix' && l.constats.some((k) => k.source === 'tests');
  // Passe d'écriture qui vient d'être jouée, nommée d'après le compteur : l.pass - 1 passes de correction l'ont précédée (minorPass reste vrai après la passe des mineurs).
  const played = l.pass - 1;
  const after = l.minorPass && played === (l.minorPassAt ?? 0) ? 'la passe des mineurs' : played > 0 ? `la passe fix ${played}` : "l'implémentation";
  const prefix = red ? `tests rouges après ${after}, correction suivante non abordable : ` : '';
  const unreviewed = red ? ' ; le lot revient sans revue, avec ses constats' : '';
  return stop(c, 'handed-back', `${prefix}${why} : étape « ${l.next ?? '?'} » non jouée${answer}${unreviewed}, à décider par le lead`);
}

function suspend(c: LotCtx, why: string): null {
  transition(c, 'suspended', why);
  return null;
}

function summarize(rep: ReviewReport, head: string, repoHeads?: Record<string, string>): ReviewSummary {
  // Rien d'un rapport n'est cru sur parole : un constat de gravité majeure compte même si les totaux annoncés disent 0.
  const count = (g: string) => rep.constats.filter((k) => k.gravite === g).length;
  const bloquants = Math.max(rep.bloquants, count('bloquant'));
  const majeurs = Math.max(rep.majeurs, count('majeur'));
  return { conforme: bloquants === 0 && majeurs === 0, bloquants, majeurs, mineurs: Math.max(rep.mineurs, count('mineur')), verdict: rep.verdict.trim(), sousTaches: rep.sousTaches, nonVerifie: rep.nonVerifie, head, ...(repoHeads ? { repoHeads } : {}) };
}

function propose(c: LotCtx, text: string): void {
  if (!c.lot.proposals.includes(text)) c.lot.proposals.push(text);
}

const minorLine = (source: string, k: { fichier?: string; ligne?: number; texte: string }) => `[mineur ${source}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`;

const withoutLine = (line: string) => line.replace(/^(\[mineur \w+\] .*?):\d+ — /, '$1 — ');

function addProposals(c: LotCtx, rep: ReviewReport, source: string, withMinors = true): void {
  if (withMinors) for (const k of rep.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine(source, k));
  for (const t of rep.sousTaches) propose(c, `[sous-tâche ${source}] ${t}`);
}

function minorConstats(rep: ReviewReport): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'mineur').map((k) => ({ source: 'code', gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

function blockingConstats(rep: ReviewReport, source: 'code' | 'ux'): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'bloquant' || k.gravite === 'majeur').map((k) => ({ source, gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

function badReport(c: LotCtx, step: StepState, e: unknown): null {
  step.status = 'failed';
  step.cause = (e as Error).message;
  return stop(c, 'failed', `${step.kind} : ${(e as Error).message}`);
}

/** Le contrôle préalable ne vaut que pour un lot sans commit : avec des commits, l'implémentation reprend légitimement. */
export function needsPrecheck(config: { precheck: boolean }, plan: Plan, repo: string, lot: string, repos: LotRepo[] = []): boolean {
  return config.precheck && !hasWork(plan, { repo, repos, lot });
}

/**
 * Contrôle préalable (L77) : une session de lecture seule cherche si le livrable du lot est déjà dans le dépôt (fait par un
 * autre lot). « oui » rend le lot sans ouvrir d'implémentation ; « partiel » joint le constat au brief de l'implémentation.
 * Un rapport illisible ne bloque pas : avertissement, l'implémentation part.
 */
async function precheck(c: LotCtx): Promise<void> {
  const l = c.lot;
  let rep: PrecheckReport | null = null;
  let localYes = false;
  if (c.config.precheckLocal) {
    // Modèle local (L146) : un échec, un rapport illisible ou un « oui » (qui rendrait le lot sans implémentation) rend la main à Sonnet.
    const done = await session(c, 'precheck', true);
    if (!done) return;
    if (done !== LOCAL_FAILED) {
      try {
        rep = checkShape<PrecheckReport>(done.report, PRECHECK_SCHEMA);
      } catch (e) {
        l.warnings.push(`contrôle préalable : rapport du modèle local illisible (${(e as Error).message}), repli sur Sonnet`);
      }
      if (rep?.dejaPresent === 'oui') {
        localYes = true;
        rep = null;
      }
    }
  }
  if (!rep) {
    const done = await session(c, 'precheck');
    if (!done) return;
    try {
      rep = checkShape<PrecheckReport>(done.report, PRECHECK_SCHEMA);
    } catch (e) {
      l.warnings.push(`contrôle préalable illisible, implémentation lancée : ${(e as Error).message}`);
      l.next = 'implement';
      save(c);
      return;
    }
  }
  if (localYes) {
    l.warnings.push(
      rep.dejaPresent === 'oui'
        ? 'contrôle préalable : « oui » du modèle local, confirmé par Sonnet'
        : `contrôle préalable : le modèle local a dit « oui », Sonnet dit « ${rep.dejaPresent} » — le local s'est trompé, repasser orchestrate.precheck à true`,
    );
  }
  const proofs = rep.preuves.length ? ` (${rep.preuves.join(' ; ')})` : '';
  // « oui » sans preuve ne se vérifie pas : il vaut « partiel », l'implémentation part avec le constat.
  const unproven = rep.dejaPresent === 'oui' && rep.preuves.length === 0;
  if (unproven) l.warnings.push('contrôle préalable : « oui » sans preuve, traité comme partiel');
  if (rep.dejaPresent === 'oui' && !unproven) {
    stop(c, 'handed-back', `livrable déjà présent : ${rep.resume.trim()}${proofs}`);
    return;
  }
  if (rep.dejaPresent === 'partiel' || unproven) {
    l.precheck = `A pre-check found part of the deliverable already in the repository (do not redo it): ${rep.resume.trim()}${proofs}`;
    l.warnings.push(`contrôle préalable : livrable en partie présent — ${rep.resume.trim()}${proofs}`);
  }
  l.next = 'implement';
  save(c);
}

/** Étape d'écriture (implémentation, correction) : contrôles, puis étape suivante décidée. */
async function work(c: LotCtx, kind: 'implement' | 'fix'): Promise<void> {
  const l = c.lot;
  const minorsPass = kind === 'fix' && l.minorFix === true;
  const done = await session(c, kind);
  if (!done) return;
  l.minorFix = false; // la passe des mineurs est jouée : la suite se décide sur son rapport
  let rep: WorkReport;
  try {
    rep = checkShape<WorkReport>(done.report, WORK_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const plan = c.loadPlan();
  const range = done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined;
  const commits: Commit[] = readCommits(l.repo, { range });
  // Commits de la session dans chaque dépôt voisin (L62) : de la tête d'avant la session à la tête d'après.
  const theirs = done.others.map((o) => ({ repo: o.repo, commits: o.before.head ? readCommits(o.repo.path, { range: `${o.before.head}..HEAD` }) : [] }));
  const made = commits.length + theirs.reduce((n, t) => n + t.commits.length, 0);
  done.step.commits = [...commits.map(short).reverse(), ...theirs.flatMap((t) => t.commits.map((k) => `[${t.repo.rel}] ${short(k)}`).reverse())];
  // La liste de git fait foi ; l'écart avec celle du rapport est signalé.
  const real = new Set([...commits, ...theirs.flatMap((t) => t.commits)].map((k) => k.sha));
  for (const a of rep.commits) {
    if ([...real].some((s) => s.startsWith(a.sha) || a.sha.startsWith(s.slice(0, 7)))) continue;
    // Reprise : le rapport cite aussi les commits d'une session précédente du lot, hors de la plage de celle-ci.
    const full = /^[0-9a-f]{4,40}$/i.test(a.sha) ? resolveCommit(l.repo, a.sha) : null;
    if (full && lotCommits(plan, l.repo, l.lot).some((k) => k.sha === full)) continue;
    l.warnings.push(full ? `commit annoncé n'appartient pas à ${l.lot} : ${a.sha} ${a.sujet}` : `commit annoncé absent de git : ${a.sha} ${a.sujet}`);
  }
  for (const k of commits) {
    if (isPlanOnly(k.sha, plan, l.repo)) continue;
    if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  }
  for (const t of theirs) {
    for (const k of t.commits) if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} dans ${t.repo.rel} : ${short(k)}`);
  }
  save(c);

  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);

  // La passe des mineurs ne bloque jamais le lot (revue conforme déjà acquise) : une question est rendue en proposition.
  const questions = rep.questions.filter((q) => !isNonQuestion(q));
  // Une entrée filtrée reste visible (avertissement du lot, donc tableau de fin de vague) ; l'entrée vide n'a rien à montrer.
  for (const q of rep.questions) if (q.trim() && isNonQuestion(q)) l.warnings.push(`question ignorée (non-question) : « ${q.trim()} »`);
  if (minorsPass) for (const q of questions) propose(c, `[question passe des mineurs] ${q}`);
  if (!minorsPass && questions.length) {
    l.questions = questions;
    l.next = kind;
    transition(c, 'question', questions[0]);
    return;
  }
  const dirt = [
    ...trackedPaths(done.after),
    ...done.after.untracked.filter((f) => !done.before.untracked.includes(f)),
    ...done.others.flatMap((o) => [...trackedPaths(o.after), ...o.after.untracked.filter((f) => !o.before.untracked.includes(f))].map((f) => `${o.repo.rel}: ${f}`)),
  ];
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après ${kind} : ${dirt.join(', ')}`);
    return;
  }
  // Reprise : une session précédente de l'étape (correction ordinaire ou passe des mineurs) a pu commiter avant d'être coupée ; la revue d'origine ne vaut alors plus.
  // Référence : le HEAD de départ de la première session coupée de la série qui précède celle-ci (pas la revue, qui peut ne pas exister encore).
  let resumedFrom: string | undefined;
  for (const s of l.steps.slice(0, -1).reverse()) {
    if (s.kind !== 'fix' || s.status !== 'interrupted') break;
    resumedFrom = s.headBefore;
  }
  const headMoved = kind === 'fix' && made === 0 && !!resumedFrom && git(l.repo, 'rev-parse', 'HEAD') !== resumedFrom;
  if (minorsPass && made === 0 && !headMoved) {
    // Rien à corriger (mineurs jugés faux, listés en « choix ») : la revue conforme d'origine vaut, HEAD n'a pas bougé.
    for (const k of l.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine('code', k));
    l.constats = [];
    l.warnings.push('passe des mineurs sans commit : le lot conclut sur la revue conforme d\'origine, mineurs rendus en propositions');
    if (l.code) await conclude(c, l.code, ' sans commit');
    else stop(c, 'handed-back', 'passe des mineurs sans commit, mais aucune revue conforme gardée');
    return;
  }
  // La session peut n'avoir plus rien à commiter (réponse du lead, lot commité avant la vague) : le travail du lot est déjà dans git.
  // Même règle côté fix (L56) : la passe n'avait rien à ajouter, le lot a déjà ses commits de travail → revue neuve ; la passe reste consommée, MAX_PASSES borne la boucle.
  const alreadyDone = hasWork(plan, l);
  if (made === 0 && !alreadyDone && !headMoved) {
    stop(c, 'handed-back', `${kind} sans commit`);
    return;
  }
  if (headMoved) l.warnings.push(`${minorsPass ? 'passe des mineurs' : 'correction'} reprise sans nouveau commit : un commit d'une session précédente est relu par la revue`);
  else if (made === 0) l.warnings.push(kind === 'fix' ? 'fix sans nouveau commit : revue lancée sur les commits du lot' : `${kind} sans nouveau commit : revue lancée sur les commits déjà faits du lot`);

  const red: Constat[] = [];
  if (!rep.tests.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `tests annoncés rouges par la session : ${rep.tests.commande} — ${rep.tests.resultat}` });
  if (!rep.build.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `build annoncé rouge par la session : ${rep.build.commande} — ${rep.build.resultat}` });
  const runs: NonNullable<LotState['checks']>['runs'] = [];
  if (red.length === 0) {
    for (const [label, command] of [['tests', c.config.test], ['build', c.config.build]] as const) {
      if (!command) continue;
      const r = await sh(c, command);
      runs.push({ label, command, code: r.code });
      if (r.code !== 0) {
        red.push({ source: 'tests', gravite: 'bloquant', texte: `${command} en échec (code ${r.code}) :\n${r.output.trim().split('\n').slice(-40).join('\n')}` });
        break;
      }
    }
  }
  if (red.length) {
    toFix(c, red, 'tests rouges');
    return;
  }
  l.constats = [];
  l.checks = runs.length ? { head: git(l.repo, 'rev-parse', 'HEAD'), runs } : undefined;
  l.next = firstReview(c);
  save(c);
}

/** Revue de code qui clôt le cycle : complète, ou courte une fois la passe des mineurs jouée. */
const codeReview = (l: LotState): StepKind => (l.minorPass ? 'review-small' : 'review');

/**
 * Première étape après un travail d'écriture. Le code vient de changer : l'UX d'un lot visible est donc toujours rejouée
 * (une revue antérieure serait périmée), puis une revue de code clôt le cycle.
 */
function firstReview(c: LotCtx): StepKind {
  const l = c.lot;
  if (l.small) return l.visible || l.minorPass ? 'review-small' : 'review'; // passe unique code + ergonomie ; sans écran, une revue de code
  if (l.visible) {
    if (!c.config.ux) {
      l.uxNote = 'UX à faire par le lead (aucune application déclarée : cadence.yaml orchestrate.ux)';
      return codeReview(l);
    }
    return 'ux';
  }
  return codeReview(l);
}

/** Une passe de correction de plus, ou la main rendue au lead quand les deux sont faites. */
function toFix(c: LotCtx, constats: Constat[], what: string): void {
  const l = c.lot;
  l.constats = constats;
  if (l.pass >= MAX_PASSES) {
    stop(c, 'handed-back', `${what} après ${MAX_PASSES} passe(s) de correction`);
    return;
  }
  l.pass += 1;
  l.next = 'fix';
  save(c);
}

/** Les deux étapes qui voient l'application : la revue UX, et la passe unique d'un petit lot visible. */
const seesApp = (l: LotState, kind: StepKind) => kind === 'ux' || (kind === 'review-small' && l.small && l.visible);

const appNote = (state: AppState, ux: { url?: string }): string =>
  state.kind === 'busy' ? `UX non vérifiée : port occupé (${ux.url} répond déjà, l'application n'a pas été lancée)` : state.kind === 'unverified' ? `UX non vérifiée : ${state.cause}` : '';

/**
 * Avec `command` ET `url`, le programme lance l'application avant l'étape et la tue après (succès, erreur ou signal) :
 * port occupé ou application muette, la revue UX n'a pas lieu (note dans le lot, la revue de code suit) ; la passe
 * unique d'un petit lot, elle, a lieu sur le code seul.
 */
async function review(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<void> {
  const l = c.lot;
  const ux = c.config.ux;
  if (!ux?.command || !ux.url || !seesApp(l, kind)) return reviewStep(c, kind);
  const halt = halted(c.wave, l);
  if (halt) {
    suspend(c, halt); // la session n'aurait pas lieu : l'application ne se lance pas pour rien
    return;
  }
  c.wave.log(`${lotKey(l.project, l.lot)} · lancement de l'application (${ux.url})`);
  const app = await startApp({ command: ux.command, url: ux.url, cwd: l.repo, nodeBin: l.node?.link, log: join(c.wave.store.lotDir(l.project, l.lot), 'ux-app.log'), timeoutMs: (ux.timeout ?? APP_TIMEOUT_S) * 1000 });
  try {
    c.app = app.state;
    if (app.state.kind !== 'ready') {
      l.uxNote = appNote(app.state, ux);
      c.wave.log(`${lotKey(l.project, l.lot)} · ${l.uxNote.split('\n')[0]}`);
      if (kind === 'ux') {
        // Aucune session : une revue UX antérieure, périmée par le code qui a changé, ne pèse plus.
        l.ux = undefined;
        l.uxVerdict = null;
        l.constats = l.constats.filter((k) => k.source !== 'ux');
        l.next = codeReview(l);
        save(c);
        return;
      }
    } else if (l.uxNote?.startsWith('UX non vérifiée')) l.uxNote = undefined;
    await reviewStep(c, kind);
  } finally {
    c.app = undefined;
    await app.stop();
  }
}

async function reviewStep(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<void> {
  const l = c.lot;
  const done = await session(c, kind);
  if (!done) return;
  let rep: ReviewReport;
  try {
    rep = checkShape<ReviewReport>(done.report, REVIEW_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const summary = summarize(rep, done.after.head ?? '', done.others.length ? Object.fromEntries(done.others.map((o) => [o.repo.rel, o.after.head ?? ''])) : undefined);
  if (kind === 'ux') {
    l.ux = summary;
    addProposals(c, rep, 'ux');
    l.uxVerdict = summary.verdict;
    l.constats = blockingConstats(rep, 'ux');
    l.next = codeReview(l); // la revue de code clôt toujours le cycle
    save(c);
    return;
  }
  l.code = summary;
  const w = c.wave;
  if (l.small && l.visible) {
    // La passe unique d'un petit lot porte aussi l'ergonomie : son verdict vaut pour les deux. Sur un lot non petit, le verdict UX reste celui de l'agent UX.
    l.ux = summary;
    l.uxVerdict = summary.verdict;
  }
  const uxOk = l.small || !l.ux || l.ux.conforme;
  const minors = minorConstats(rep);
  // Revue conforme avec mineurs : une seule passe de correction des mineurs, avant de conclure (rien sous le tapis).
  // Budget épuisé : la passe n'aurait aucune session pour la jouer, le lot conclut sur la revue conforme et rend les mineurs.
  const wanted = summary.conforme && uxOk && !l.minorPass && !l.light && minors.length > 0; // lot léger : les mineurs restent des notes (L108)
  const noBudget = wanted && (w.budget.exhausted || !fixAffordable(l)) && !w.incident && !w.quota.hit;
  const minorPass = wanted && !noBudget;
  if (noBudget) l.warnings.push(`${w.budget.exhausted ? 'budget atteint' : 'budget du lot trop juste pour payer la revue qui suivrait'} : la passe des mineurs n'a pas eu lieu, mineurs rendus en propositions`);
  // Les mineurs confiés à la passe ont pu être proposés par une revue non conforme antérieure : si la revue qui la suit est
  // conforme, ils sont traités et ne restent pas en propositions (ceux que cette revue signale encore sont ajoutés juste après).
  if (l.minorPass && !minorPass && summary.conforme && uxOk && l.minorLines?.length) {
    // Chaque mineur confié retire UNE proposition : la même ligne d'abord, sinon une de même fichier et même texte (le correctif a pu décaler la ligne).
    // Un autre mineur de même fichier et même texte, à une autre ligne, reste donc proposé. Limite connue : un texte reformulé n'est pas reconnu et reste proposé.
    const left = [...l.proposals];
    const take = (match: (p: string) => boolean) => {
      const i = left.findIndex(match);
      if (i >= 0) left.splice(i, 1);
      return i >= 0;
    };
    const rest = l.minorLines.filter((m) => !take((p) => p === m));
    for (const m of rest) take((p) => withoutLine(p) === withoutLine(m));
    l.proposals = left;
    l.minorLines = [];
  }
  addProposals(c, rep, 'code', !minorPass);
  if (minorPass) {
    l.minorPass = true;
    l.minorPassAt = l.pass;
    l.minorLines = rep.constats.filter((k) => k.gravite === 'mineur').map((k) => minorLine('code', k));
    l.minorFix = true;
    l.constats = minors;
    l.next = 'fix';
    save(c);
    return;
  }
  if (summary.conforme && uxOk) {
    await conclude(c, summary);
    return;
  }
  const constats = [...blockingConstats(rep, 'code'), ...(!l.small && l.ux && !l.ux.conforme ? uxConstatsKept(c) : [])];
  toFix(c, constats, 'revue non conforme');
}

/** Constats UX de la dernière revue UX, gardés dans l'état par la revue elle-même (l.constats avant la revue de code). */
function uxConstatsKept(c: LotCtx): Constat[] {
  return c.lot.constats.filter((k) => k.source === 'ux');
}

/** Revue conforme : le verdict est enregistré avec le sha relu, puis le commit du plan. `raf done` reste au lead. */
async function conclude(c: LotCtx, code: ReviewSummary, minorNote = ''): Promise<void> {
  const l = c.lot;
  const plan = c.loadPlan();
  // Dépôts voisins du lot (L62) : le sha lu de chacun est enregistré avec le verdict, et dit dans son texte (un plan en lecture seule n'a que le texte).
  const neighbours = l.repos ?? [];
  const shas = repoShas(plan, neighbours, l.lot);
  const read = neighbours.length ? ` ; dépôts relus : ${neighbours.map((r) => `${r.rel}@${shas[r.rel]?.slice(0, 7) ?? 'aucun commit du lot'}`).join(', ')}` : '';
  const verdict = `${code.verdict} — orchestré (vague ${c.wave.id}, ${l.pass} passe(s) de correction${l.minorPass ? ` + passe des mineurs${minorNote}` : ''}${read})`;
  l.verdict = verdict;
  const newer = lotWork(plan, l.repo, l.lot)[0]?.sha ?? null;
  const moved = (code.head && newer !== null && git(l.repo, 'rev-parse', 'HEAD') !== code.head ? [''] : []).concat(
    neighbours.filter((r) => shas[r.rel] !== null && code.repoHeads?.[r.rel] && git(r.path, 'rev-parse', 'HEAD') !== code.repoHeads[r.rel]).map((r) => ` dans ${r.rel}`),
  );
  if (moved.length) {
    stop(c, 'handed-back', `un commit est postérieur à la revue${moved.join(',')} : verdict non enregistré`);
    return;
  }
  l.constats = [];
  // Sous-tâches ouvertes que des commits du lot citent (L82) : la revue conforme vaut pour elles, sinon `raf done` refuserait le lot.
  const covered = coveredTasks(plan, l.repo, l.lot, neighbours.flatMap((r) => repoWork(plan, r, l.lot)));
  if (!plan.readonly) {
    plan.recordReview(l.lot, verdict, c.wave.today, newer, neighbours.length ? shas : undefined);
    for (const k of covered) plan.setStatus(`${l.lot}/${k.task}`, 'done', c.wave.today);
    if (covered.length) l.warnings.push(`sous-tâches closes (couvertes par des commits qui les citent, revue conforme) : ${covered.map((k) => `${l.lot}/${k.task} (${k.sha.slice(0, 7)})`).join(', ')}`);
    plan.save();
    const dirty = await commitPlan(c, `plan: ${l.lot} revue de code enregistrée (orchestrate ${c.wave.id})`);
    if (dirty) {
      stop(c, 'handed-back', dirty);
      return;
    }
  } else {
    for (const k of covered) propose(c, `[sous-tâche clore] ${l.lot}/${k.task} — couverte par ${k.sha.slice(0, 7)}, revue conforme : à clore avant raf done`);
  }
  if (plan.readonly && c.config.verdict) {
    const r = await sh(c, c.config.verdict.replaceAll('{lot}', l.lot).replaceAll('{verdict}', shEscape(verdict)));
    if (r.code !== 0) l.warnings.push(`orchestrate.verdict en échec (code ${r.code}) : le lead reporte le verdict`);
    else {
      const dirty = await commitPlan(c, `plan: ${l.lot} revue de code notée (orchestrate ${c.wave.id})`);
      if (dirty) {
        stop(c, 'handed-back', dirty);
        return;
      }
    }
  }
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/** Formes connues de « pas de question » : l'entrée entière, normalisée, doit en égaler une (liste fermée, L52). */
const NON_QUESTIONS = new Set([
  '', 'vide', '(vide)', 'n/a', 'na', 'none', 'nothing', 'nil', 'rien', 'néant', 'neant', 'aucune', 'aucun',
  'aucune question', 'aucune autre question', 'aucune question bloquante', 'aucune question supplémentaire', 'aucune question supplementaire',
  'pas de question', 'pas de questions', 'pas de question bloquante', 'pas de questions bloquantes', 'plus de question', 'plus de questions',
  "je n'ai pas de question", "je n'ai pas de questions", "je n'ai aucune question", "je n'ai pas de question bloquante", "je n'ai pas de questions bloquantes", "je n'ai aucune question bloquante",
  'no question', 'no questions', 'no open question', 'no open questions', 'no blocking question', 'no blocking questions',
  'no other question', 'no other questions', 'no further question', 'no further questions',
  'i have no question', 'i have no questions', 'i have no blocking question', 'i have no blocking questions', 'there are no questions', 'there is no question',
]);

/** Casse, espaces, ponctuation finale (hors « ? ») et apostrophe typographique ramenés à la forme de comparaison. */
function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').replace(/[\s.!:;,\-–—…]+$/u, '');
}

/** Une « question » vide ou qui dit exactement qu'il n'y en a pas (« aucune question », « no questions », « n/a ») n'arrête pas le lot ; une entrée qui contient « ? » n'est jamais filtrée. */
export function isNonQuestion(q: string): boolean {
  if (q.includes('?')) return false;
  return NON_QUESTIONS.has(normalizeQuestion(q));
}

/** Fin de vague (L79) : un lot qui a posé sa question PENDANT la vague, puis retiré par `--drop`, n'a plus de cycle à jouer pour s'en apercevoir : il est rendu ici, sinon il resterait en question pour toujours. */
export function handBackDroppedQuestions(ctxs: LotCtx[]): void {
  for (const c of ctxs) if (c.lot.status === 'question' && dropped(c)) stop(c, 'handed-back', DROPPED);
  // Les lots restés en file derrière un lot retiré ne seront jamais joués (comme le pool pour une dépendance rendue au lead) : rendus aussi, de proche en proche.
  for (let moved = true; moved; ) {
    moved = false;
    for (const c of ctxs) {
      if (c.lot.steps.length || (c.lot.status !== 'queued' && c.lot.status !== 'suspended')) continue;
      const dead = (c.lot.dependsOn ?? []).filter((id) => {
        const d = ctxs.find((o) => o.lot.project === c.lot.project && o.lot.lot === id);
        return d?.lot.status === 'handed-back' || d?.lot.status === 'failed';
      });
      if (dead.length === 0) continue;
      stop(c, 'handed-back', `dépendance non prête dans la vague : ${dead.join(', ')}`);
      moved = true;
    }
  }
}

/** Joue le cycle d'un lot jusqu'à son terme, ou jusqu'à l'arrêt (question, budget, quota). Ne lève jamais. */
export async function runLot(c: LotCtx): Promise<void> {
  const l = c.lot;
  try {
    if (TERMINAL.has(l.status)) return;
    if (l.status === 'question' && dropped(c)) {
      // Un lot en question retiré (--drop, éventuellement à la reprise) : il n'attend plus de réponse, il est rendu au lead.
      stop(c, 'handed-back', DROPPED);
      return;
    }
    if (l.status === 'question' && !l.pendingAnswer) return;
    if (l.next === null && l.steps.length === 0) {
      if (dropped(c)) {
        stop(c, 'handed-back', DROPPED);
        return;
      }
      // Pas de raf start ni de commit du plan pour un lot qu'aucune session ne suivrait.
      const halt = halted(c.wave, l);
      if (halt) {
        suspend(c, halt);
        return;
      }
      const before = await snapshot(l.repo, { remote: false });
      if (before.tracked.length) {
        stop(c, 'handed-back', `dépôt sale avant le lot : ${trackedPaths(before).join(', ')}`);
        return;
      }
      const why = await startLot(c);
      if (why) {
        stop(c, 'handed-back', why);
        return;
      }
      l.startedSha = (await snapshot(l.repo, { remote: false })).head ?? undefined;
      l.next = needsPrecheck(c.config, c.loadPlan(), l.repo, l.lot, l.repos) ? 'precheck' : 'implement';
      save(c);
    }
    while (l.next && !TERMINAL.has(l.status)) {
      const kind = l.next;
      if (kind === 'precheck') await precheck(c);
      else if (kind === 'implement' || kind === 'fix') await work(c, kind);
      else await review(c, kind);
      if (l.status === 'suspended' || l.status === 'question') return;
    }
  } catch (e) {
    l.next = null;
    transition(c, 'failed', `erreur : ${(e as Error).message}`);
  } finally {
    // Sorties du MCP Playwright qu'une session a écrites dans le dépôt (L50) : jetables, retirées à la fin de chaque passage du lot.
    try {
      cleanPlaywrightOutput(l.repo);
    } catch {
      // nettoyage de confort : jamais une cause d'échec du lot
    }
  }
}
