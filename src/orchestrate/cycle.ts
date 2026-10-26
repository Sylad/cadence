import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { toolBinOf, withoutLaunchVars } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coveredTasks, lotCommits, lotWork } from '../audit.js';
import { readDocsConfig, type OrchestrateConfig } from '../config.js';
import { articleRepoDir, articlesBrief, docSyncBrief, docSyncGaps, filesOf, gapMessage, type DocSyncGap, type DocSyncRule } from '../docsync.js';
import { testGateMissing } from '../testgate.js';
import type { Day } from '../dates.js';
import { changedFiles, gitCommonDir, isAncestor, readCommits, resolveCommit, type Commit } from '../git.js';
import { blockingLots, gitCommitsIn } from './table.js';
import { citedRefs } from '../link.js';
import { repoShas, repoWork, type LotRepo } from '../repos.js';
import { isOpen, type Plan } from '../plan.js';
import { isPlanOnly } from '../audit.js';
import { compareBaseline, failedTests, hasUnnamedFailure } from './baseline.js';
import { isJestTest, replayFile, shellArg, TEST_WORKERS_ENV, testWorkersText } from './workers.js';
import { APP_TIMEOUT_S, startApp, type AppState } from './app.js';
import { capturesText, headline, integrationText, localReading, newsText, objective, renderBrief, reposText, shotsText, TEMPLATES_DIR, tmpText, type BriefName, type BriefVars, type Templates } from './briefs.js';
import { SlotAbandoned } from './registry.js';
import { journalTokens, peakContext, mcpServersFor, playwrightDir, runSession, trackGroup, writeMcpConfig, type AgentDef, type AnyModel, type ClaudeFn, type Model, type SessionKind, type StepModel } from './launch.js';
import { cleanPlaywrightOutput, pushed, remoteAdvances, snapshot, type Snapshot } from './guard.js';
import { sumTokens, type Tokens } from './result.js';
import { cutReport, EXTENSION_MS, MAX_EXTENSIONS, workTimeoutMs } from './timeouts.js';
import { ACCEPT_SCHEMA, checkShape, PRECHECK_SCHEMA, REVIEW_SCHEMA, schemaFor, SPEC_SCHEMA, WORK_SCHEMA, type AcceptReport, type PrecheckReport, type ReviewReport, type SpecReport, type WorkReport } from './schemas.js';
import { type Acceptation, acceptationFile, acceptCommands, isAcceptList, acceptText, checkAcceptation, findAcceptation, isAcceptationFile, lockViolations, lotStartHead, parseAcceptation, planAcceptRuns, redSha, resealedRouge, sealAcceptation, setVert } from './accept.js';
import { avalFicheText, ficheContracts, ficheRules, hasScreenPart } from './aval.js';
import { ficheReviewText, reviewedSheetText } from './fiche.js';
import { bulletLines, maquetteText, reviewedText } from './maquette.js';
import { answeredText, checkSpec, costlyHypotheses, ficheHasBack, ficheReady, findFiche, hypothesisLines, answerAltersRule, hypothesisNote, LEAD_SOURCE, ruleIdsSourcedByLead, sourceRules, specText, type FicheParts } from './spec.js';
import type { Constat, LotState, ReviewSummary, RunStore, StepState } from './state.js';
import { decisionsText, humanDecisions } from './decisions.js';
import { LOCAL_PRECHECK_UNREADABLE, PRECHECK_UNREADABLE, lotKey, lotRepoPaths, neighbourDirs } from './state.js';
import { advance, INTEGRATE_WAIT_MS, mergeBase, patchId, rebaseOnto, repoBranch, takeRepoWrite } from './integrate.js';
import { mutexFor } from './mutex.js';
import { branchExists, git, gitFailure, integrated, linkIgnored, lotBranch, planFileSet, planSeenFrom, prepareTree, removeTree, trackedDirty } from './worktree.js';

/** Passes de correction au plus, puis la main est rendue au lead. */
export const MAX_PASSES = 2;
/** Plafond quand la revue converge (L205) : le nombre de bloquants+majeurs a baissé d'une revue à l'autre et il n'en reste qu'un. */
export const MAX_PASSES_CONVERGING = MAX_PASSES + 1;

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
  /** Part de la machine de chaque session (L350) : posée en CADENCE_TEST_WORKERS dans les sessions et la porte, et dite aux gabarits. Absent (vague construite à la main) : rien n'est posé. */
  testWorkers?: number;
  /** Push ou revue qui a modifié le dépôt : la vague s'arrête. */
  incident: string | null;
  /** Dépôts salis par une revue (L133) → lot en cause : les lots qui restent dans leur file sont suspendus, ceux des autres dépôts continuent. */
  dirtyRepos?: Map<string, string>;
  /** Parmi `dirtyRepos`, ceux laissés en HEAD déplacé par une session d'écriture (L214) : même file retenue, autre message. */
  movedRepos?: Set<string>;
  /** Pourquoi le modèle local est écarté pour la suite de la vague (L322) : posé au premier échec d'une session locale, il envoie les lots suivants droit à Sonnet. */
  localOut?: string;
  log: (line: string) => void;
  saveWave: () => void;
  /** Attente du verrou d'intégration du dépôt (L279, R25) : bornes par défaut INTEGRATE_WAIT_MS et INTEGRATE_POLL_MS ; réglables pour les tests. */
  integrate?: { waitMs?: number; pollMs?: number };
}

/** Le worktree prévu pour un lot (L279) : créé à la prise du créneau (`active` une fois prêt), retrouvé à la reprise. */
export interface LotTree {
  dir: string;
  branch: string;
  /** Branche du dépôt sur laquelle le lot est parti et à laquelle il s'intègre (R24). */
  base: string;
  active: boolean;
}

export interface LotCtx {
  wave: WaveCtx;
  lot: LotState;
  config: OrchestrateConfig;
  loadPlan: () => Plan;
  /** Issue du lancement de l'application par le programme, le temps de l'étape qui la voit (L60). */
  app?: AppState;
  /** Worktree du lot (L279) ; absent : le lot joue dans le dépôt lui-même. */
  tree?: LotTree;
  /** Posé le temps de la revue courte du diff rebasé (R17) : le brief le dit à la session. */
  integration?: { base: string };
}

const TERMINAL = new Set(['ready', 'handed-back', 'failed']);

/**
 * Où le lot travaille (L279) : son worktree quand il en a un, sinon le dépôt du projet. Tout ce que le cycle lit ou écrit du travail du lot — sessions,
 * commits, contrôles, fiche, acceptation — passe par là ; le plan, lui, n'est jamais lu ni écrit ici que dans le dépôt du projet (`c.lot.repo`, R21).
 */
export const workDir = (c: LotCtx): string => (c.tree?.active ? c.tree.dir : c.lot.repo);
const wd = workDir;

/** Le plan tel que les lectures d'historique (lotWork, isPlanOnly, coveredTasks, unreviewedWork) le voient depuis `wd(c)` : son chemin est celui du fichier correspondant dans le worktree (R21). */
const histPlan = (c: LotCtx): Plan => (wd(c) === c.lot.repo ? c.loadPlan() : planSeenFrom(c.loadPlan(), c.lot.repo, wd(c)));

const short = (c: { sha: string; subject: string }) => `${c.sha.slice(0, 7)} ${c.subject}`;

function save(c: LotCtx): void {
  c.wave.store.writeLot(c.lot);
}

function transition(c: LotCtx, status: LotState['status'], outcome?: string): void {
  c.lot.status = status;
  if (outcome !== undefined) c.lot.outcome = outcome;
  save(c);
  c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} → ${status}${outcome ? ` — ${outcome}` : ''}`);
}

/** Une session jouée au modèle d'escalade (L337) : la correction escaladée et la revue neuve qui la suit. L'UX, la fiche, le précheck… gardent leur modèle. */
const escalatedSession = (c: LotCtx, kind: SessionKind): boolean =>
  c.lot.escalation?.stage === 'fix' && (kind === 'fix' || kind === 'review' || kind === 'review-small');

/**
 * Rend ou échoue le lot. `noResult` : la session escaladée n'a rien rendu (sortie vide, erreur de lancement, coupure, délai) — seul cas où l'escalade est dite
 * « en échec » (L338) : le modèle n'a pas jugé le lot. Un retrait (--drop) ou un incident du dépôt pendant l'escalade laisse l'escalade sans issue : ce n'est pas
 * un échec du modèle et `cadence perf` ne le compte pas contre lui.
 */
const stop = (c: LotCtx, status: 'handed-back' | 'failed', outcome: string, noResult = false): null => {
  c.lot.next = null;
  const e = c.lot.escalation;
  if (e && !e.issue && noResult) {
    // Une session escaladée a échoué ou été coupée (L337) : le modèle n'a pas jugé le lot. `toFix` pose `rendu` avant de rendre un lot sur un verdict.
    e.stage = 'done';
    e.issue = 'échec';
    c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · escalade ${e.model} : session sans résultat, le lot n'a pas été jugé par ce modèle`);
  }
  transition(c, status, outcome);
  return null;
};

/** Fichiers suivis modifiés (chemins), d'après `git status --porcelain`. */
function trackedPaths(s: Snapshot): string[] {
  return s.tracked.map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

/**
 * Commit d'entretien du plan, chemins explicites. Rend un message d'arbre sale quand autre chose que le plan a bougé.
 * Dans le dépôt du projet (`root` par défaut) : jamais dans un worktree de lot (R21). Les commits de TRAVAIL du cycle (scellé et `vert: true` de l'acceptation)
 * se font, eux, dans `wd(c)`, sur la branche du lot.
 */
async function commitPlan(c: LotCtx, message: string, root = c.lot.repo): Promise<string | null> {
  const repo = root;
  const ownFile = planOwnFile(c, repo);
  const dirty = trackedPaths(await snapshot(repo, { remote: false }));
  if (dirty.length === 0) return null;
  const foreign = dirty.filter((f) => !ownFile(f));
  if (foreign.length) return `arbre sale (fichiers hors plan) : ${foreign.join(', ')}`;
  git(repo, 'add', '--', ...dirty);
  git(repo, 'commit', '-q', '-m', message, '--', ...dirty);
  return null;
}

/**
 * Sha d'où le lot est parti : le parent de son plus ancien commit de travail (un lot relancé, ou déjà en partie commité, a ses propres
 * commits avant la vague), à défaut le HEAD d'avant la première session de la vague.
 */
const startSha = (c: LotCtx): string | undefined => lotStartHead(wd(c), lotWork(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha)) ?? c.lot.steps.find((s) => s.headBefore)?.headBefore;

/**
 * Échecs des tests au sha de départ du lot (L213) : la commande est rejouée dans un worktree jetable de ce sha, hors du dépôt,
 * avec des liens vers les dossiers ignorés de tout niveau (node_modules, .venv… ; `dist` et les autres sorties de build exclus, une commande
 * de tests qui y écrit toucherait le build du lot) pour que les dépendances s'y trouvent. Les `node_modules` sont recréés entrée par entrée
 * pour que les paquets de workspace résolvent dans le worktree (`mirrorNodeModules`). Un rouge nommé y est rejoué seul (L350) avant d'être retenu.
 * Null quand le worktree ne peut être monté : l'appelant garde alors les tests pour rouges.
 */
async function baselineFailures(c: LotCtx, command: string): Promise<string[] | null> {
  const l = c.lot;
  const sha = startSha(c);
  if (!sha) return null;
  if (l.baseline?.verified && l.baseline.sha === sha && l.baseline.command === command) return l.baseline.failures;
  const dir = mkdtempSync(join(tmpdir(), 'cadence-baseline-'));
  const links: string[] = [];
  try {
    git(l.repo, 'worktree', 'add', '--detach', '-f', dir, sha);
    links.push(...linkIgnored(l.repo, dir));
    // Le build d'abord, comme dans la porte (L333) : les tests lisent ce qu'il produit (`dist`), le départ sans lui rougirait tout. Un build rouge au départ
    // ne dit rien des tests : pas de ligne de base, l'appelant garde les tests pour rouges.
    if (c.config.build && (await sh(c, c.config.build, 30 * 60_000, {}, dir)).code !== 0) return null;
    const r = await sh(c, command, 30 * 60_000, {}, dir);
    // Ligne de base comprise (L350) : un rouge du sha de départ est rejoué seul dans le même worktree avant d'être retenu. Sous charge, un test
    // qui passe seul au départ rougirait ici et excuserait une vraie régression du lot (« déjà rouge au départ »). Un échec sans nom reste tel quel.
    const found = r.code === 0 ? [] : failedTests(r.output);
    const named = found.length && !hasUnnamedFailure(r.output) ? found : [];
    const { red: failures, unstable } = named.length ? await replayAlone(c, command, named, dir) : { red: found, unstable: [] as string[] };
    if (unstable.length) c.wave.log(`${lotKey(l.project, l.lot)} · ligne de base ${sha.slice(0, 7)} : ${unstable.length} test(s) rouge(s) sous charge, vert(s) rejoué(s) seul(s), non retenu(s) comme déjà rouge(s) : ${unstable.join(' ; ')}`);
    l.baseline = { sha, command, failures, verified: true };
    save(c);
    return failures;
  } catch {
    return null;
  } finally {
    for (const k of links) if (lstatSync(k, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(k);
    try {
      git(l.repo, 'worktree', 'remove', '--force', dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      git(l.repo, 'worktree', 'prune');
    } catch {
      // rien à élaguer
    }
  }
}

type VsBase = { kind: 'unknown' } | { kind: 'existing'; n: number } | { kind: 'new'; nouveaux: string[]; existants: number };

/** Des tests rouges comparés à la ligne de base (L213) : tous déjà rouges au départ, ou au moins un nouveau, ou rien de comparable. */
async function againstBaseline(c: LotCtx, command: string, output: string): Promise<VsBase> {
  const now = failedTests(output);
  if (!now.length || hasUnnamedFailure(output)) return { kind: 'unknown' };
  const base = await baselineFailures(c, command);
  if (!base?.length) return { kind: 'unknown' };
  const { nouveaux, existants } = compareBaseline(now, base);
  return nouveaux.length ? { kind: 'new', nouveaux, existants: existants.length } : { kind: 'existing', n: existants.length };
}

const shEscape = (s: string) => s.replace(/\s+/g, ' ').replace(/[\\"$`]/g, '\\$&');

/** Commande du projet, asynchrone : la boucle d'événements reste libre (délai de l'autre créneau, signaux). Son groupe est tué au délai et au signal. */
function sh(c: LotCtx, command: string, timeoutMs = 30 * 60_000, env: Record<string, string> = {}, cwd = wd(c)): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...withoutLaunchVars(process.env), ...(c.wave.testWorkers ? { [TEST_WORKERS_ENV]: String(c.wave.testWorkers) } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
      const r = await sh(c, c.config.start.replaceAll('{lot}', c.lot.lot), undefined, undefined, c.lot.repo);
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
  const plan = histPlan(c);
  const mine = lotWork(plan, wd(c), c.lot.lot).reverse().map((k) => `- ${short(k)}`);
  const theirs = (c.lot.repos ?? []).flatMap((r) => repoWork(plan, r, c.lot.lot).reverse().map((k) => `- [${r.rel}] ${short(k)}`));
  return [...mine, ...theirs].join('\n');
}

/** Le lot a déjà du travail (commits citant le lot) dans son dépôt ou dans un dépôt voisin. */
function hasWork(plan: Plan, root: string, l: Pick<LotState, 'repos' | 'lot'>): boolean {
  return lotWork(plan, root, l.lot).length > 0 || (l.repos ?? []).some((r) => repoWork(plan, r, l.lot).length > 0);
}

function constatLines(constats: Constat[]): string {
  return constats
    .map((k) => `- [${k.gravite}${k.source === 'code' ? '' : ` / ${k.source}`}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`)
    .join('\n');
}

/** Consigne de captures : `uxText` n'alimente que `ux` et `review-small` d'un petit lot visible, deux étapes qui chargent toujours le serveur Playwright de la vague. */
const shotsAt = (dir: string): string => `Take screenshots at 1440 and 390 px width, in the wave's capture directory (outside the repository), each named with its full path, e.g. \`${dir}/home-1440px.png\`.`;

function uxText(c: LotCtx): string {
  const ux = c.config.ux;
  const SHOTS_TEXT = shotsAt(playwrightDir(c.wave.store.lotDir(c.lot.project, c.lot.lot)));
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
  const b = c.lot.baseline;
  // Sans orchestrate.test aucun rejeu : la base annoncée par la session (non vérifiée) est la seule trace des échecs de départ ; elle s'ajoute aux runs du programme (le build), elle ne les remplace pas.
  const declared = b && !b.verified && b.failures.length ? `The author reports ${b.failures.length} test(s) already red at the start sha${b.sha ? ` ${b.sha.slice(0, 7)}` : ''}, before this lot (not verified by the program):\n${b.failures.map((t) => `- ${t}`).join('\n')}\nThey are not defects of this lot, do not report them as findings; a failing test outside this list is still a finding.` : '';
  const k = c.lot.checks;
  if (!k?.runs.length || k.head !== git(wd(c), 'rev-parse', 'HEAD')) return declared;
  const runs = k.runs.map((r) => `- \`${r.command}\` (${r.label}): ${r.code === 0 ? (r.instables?.length ? `green; ${r.instables.length} test(s) red under load in the whole suite, green when replayed alone, not defects: ${r.instables.join(' ; ')}` : 'green') : r.dejaRouges ? `RED, exit code ${r.code}, but every failing test (${r.dejaRouges}) was already red at the start sha${c.lot.baseline?.sha ? ` ${c.lot.baseline.sha.slice(0, 7)}` : ''}: not a defect of this lot, do not report them as findings` : `RED, exit code ${r.code}`}`);
  const ran = [`The program already ran these checks at HEAD ${k.head.slice(0, 7)}, just before this review:`, ...runs, 'Take these results as given: do not rebuild, do not rerun the whole suite, and do not wait on them. Run only a check they do not cover (a targeted test of a case you doubt), and list under "nonVerifie" what neither they nor you verified.'].join('\n');
  return declared ? `${ran}\n${declared}` : ran;
}

/** La clé `docs` du cadence.yaml du projet de ce lot. */
const docsConfig = (c: LotCtx) => readDocsConfig(histPlan(c).configFile ?? join(wd(c), 'cadence.yaml'));

/** Écarts docs.sync des commits du lot (L143), calculés au moment de la demande : ni gardés ni écrits d'avance. Un écart acquitté et motivé (`raf docs-ok`, L317) n'en est plus un. */
function docGaps(c: LotCtx): { sync: DocSyncRule[]; gaps: DocSyncGap[] } {
  const { sync } = docsConfig(c);
  const plan = histPlan(c);
  const acknowledged = !!plan.lots().find((x) => x.id === c.lot.lot)?.docsOk;
  return { sync, gaps: sync.length && !acknowledged ? docSyncGaps(sync, filesOf(wd(c), lotWork(plan, wd(c), c.lot.lot))) : [] };
}

/** Cause du renvoi au lead d'un lot dont l'écart docs.sync est ouvert (L317), null sans écart. */
function openDocGap(c: LotCtx): string | null {
  const { gaps } = docGaps(c);
  if (!gaps.length) return null;
  return `documentation en retard (docs.sync) : ${gaps.flatMap((g) => g.touched).join(', ')} sans la documentation attendue, et aucun écart acquitté — écrire la documentation, ou \`raf docs-ok ${c.lot.lot} --reason "…"\` si elle reste vraie`;
}

/** Consigne docs.sync du brief de revue (L143). */
function docsText(c: LotCtx): string {
  const { sync, gaps } = docGaps(c);
  return sync.length ? docSyncBrief(sync, gaps) : '';
}

/** Gabarit d'une étape : la passe des mineurs et la revue courte qui la suit ont chacune le leur. */
export function briefName(l: LotState, kind: SessionKind, integration = false): BriefName {
  if (l.specLot && !l.screen && (kind === 'spec' || kind === 'accept')) return `${kind}-back`;
  if (kind === 'fix' && l.docsFix) return 'fix-docs';
  if (kind === 'fix' && l.minorFix) return 'fix-minors';
  if (kind === 'review-small' && l.minorPass && !integration && !(l.small && l.visible)) return 'review-recheck'; // la revue d'intégration (R17) garde le gabarit qui porte {{integration}}
  return kind;
}

/** Gabarit de fiche livré avec le paquet, joint au brief de la spec (la session ne lit pas le dossier du paquet). */
function ficheTemplate(): string | undefined {
  try {
    return readFileSync(join(TEMPLATES_DIR, '..', 'fiche.yaml'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Gabarit de la partie back de la fiche (L187), joint au brief de la spec d'un lot `spec: true`. */
function ficheBackTemplate(): string | undefined {
  try {
    return readFileSync(join(TEMPLATES_DIR, '..', 'fiche-back.yaml'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Le lot passe par l'étape spec : il déclare `screen:` (écran) ou `spec: true` (comportement sans écran, L188). */
const hasSpecStage = (l: LotState): boolean => !!(l.screen || l.specLot);

/**
 * Les parties que la fiche du lot doit avoir : l'écran d'un lot à `screen:`, le sujet d'un lot à `spec: true` (sans écran). Un lot mixte est un lot
 * `screen:` dont la FICHE a une partie back (bloc `sujet`, décision du lead) : la fiche écrite le dit, pas un champ du plan.
 */
const partsOf = (c: LotCtx, fiche?: string | null): FicheParts => ({ screen: !!c.lot.screen, back: !!c.lot.specLot || (!!c.lot.screen && !!fiche && ficheHasBack(wd(c), fiche)) });

/** Gabarit du lanceur de tests livré avec le paquet, joint au brief de l'étape accept. */
function acceptRunner(): string | undefined {
  try {
    return readFileSync(join(TEMPLATES_DIR, '..', 'acceptation-runner.mjs'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Fiche du lot : celle de l'étape spec, ou la fiche retrouvée dans le dépôt (reprise). */
function ficheOf(c: LotCtx): string | null {
  const l = c.lot;
  return l.spec && 'fiche' in l.spec ? l.spec.fiche : findFiche(wd(c), c.config.spec.dir, l.lot);
}

/**
 * Consigne de la fiche pour les étapes en aval d'un lot qui en a une (L174) : implement, fix, revue de code, UX de conformité.
 * Vide quand le lot n'a pas de fiche (sous le seuil, ou pas encore écrite) ou qu'elle est illisible.
 */
function avalOf(c: LotCtx, kind: SessionKind): string {
  const l = c.lot;
  const step = kind === 'implement' || kind === 'fix' || kind === 'ux' ? kind : kind === 'review' || kind === 'review-small' ? 'review' : null;
  const fiche = step ? ficheOf(c) : null;
  if (!step || !fiche) return '';
  let rules: string[];
  let contracts: string[];
  let screen: boolean;
  try {
    const doc = parse(readFileSync(join(wd(c), fiche), 'utf8'));
    rules = ficheRules(doc);
    contracts = ficheContracts(doc);
    screen = hasScreenPart(doc);
  } catch {
    return '';
  }
  if (!rules.length || (step === 'ux' && !screen)) return '';
  const acceptation = l.accept?.acceptation ?? findAcceptation(wd(c), c.config.spec.dir, l.lot) ?? undefined;
  const o = { fiche, rules, acceptation, rouge: l.accept?.rouge, contracts, screen };
  const text = avalFicheText(step, o);
  // la revue courte d'un petit lot visible est sa seule passe : elle porte aussi la conformité à la maquette
  return kind === 'review-small' && l.small && l.visible && screen ? `${text}\n${avalFicheText('ux', o)}` : text;
}

/** Consigne de la part de machine de la session (L350) ; vide quand la vague n'en a pas calculé. */
const workersText = (c: LotCtx): string => (c.wave.testWorkers ? testWorkersText(c.wave.testWorkers) : '');

function briefFor(c: LotCtx, kind: SessionKind, local = false): string {
  const plan = c.loadPlan();
  const l = c.lot;
  const lot = plan.lot(l.lot);
  const tmpDir = c.wave.store.tmpDir(l.project, l.lot);
  const vars: BriefVars = { chemin: wd(c), lot: l.lot, titre: headline(lot, l.goal), objectif: objective(lot, l.goal), commits: '', reponse: '', constats: '', spec: '', ux: uxText(c), choix: choixText(c.lot.choix ?? []), checks: kind === 'review' || kind === 'review-small' ? checksText(c) : '', docs: kind === 'review' || kind === 'review-small' ? docsText(c) : '', news: '', captures: '', tmp: tmpText(tmpDir), workers: kind === 'implement' || kind === 'fix' ? workersText(c) : '', repos: reposText(kind === 'implement' || kind === 'fix' ? 'write' : 'read', l.lot, l.repos ?? []), integration: c.integration ? integrationText(c.integration.base) : '' };
  if (l.visible) {
    const pwDir = playwrightDir(c.wave.store.lotDir(l.project, l.lot));
    vars.news = newsText(l.lot, pwDir);
    vars.captures = capturesText(pwDir);
  }
  if (mcpServersFor(kind, l.visible, '', l.small, !!l.screen).playwright) vars.shots = shotsText(playwrightDir(c.wave.store.lotDir(l.project, l.lot)));
  vars.fiche = hasSpecStage(l) ? avalOf(c, kind) : '';
  if (kind === 'implement' || kind === 'fix') vars.decisions = decisionsText(humanDecisions(lot, lot.parent ? plan.lots().find((x) => x.id === lot.parent) : undefined));
  if (kind === 'precheck' && local) vars.lecture = localReading({ ...lot, goal: l.goal ?? lot.goal });
  if (kind === 'spec') {
    const reviewed = [...(l.ficheConstats ?? []), ...(l.maquetteConstats ?? [])];
    const written = ficheOf(c);
    const back = partsOf(c, written).back;
    const session = { run: (l.specRuns ?? 0) + 1, max: specBudget(c) };
    vars.spec = specText({
      dir: c.config.spec.dir,
      render: c.config.spec.render,
      screen: l.screen,
      back,
      problems: l.specProblems,
      review: !reviewed.length ? undefined : back ? reviewedSheetText(reviewed, !!l.screen, session) : reviewedText(reviewed, session),
      template: l.screen ? ficheTemplate() : undefined,
      templateBack: back || l.screen ? ficheBackTemplate() : undefined,
    });
    const mine = lotCommitLines(c);
    if (mine) vars.commits = `Commits of the lot already present (do not redo them; fix or complete the spec from them):\n${mine}`;
    if (l.pendingAnswer) vars.reponse = l.specAsked?.length ? answeredText(l.specAsked, l.pendingAnswer, ruleIdsSourcedByLead(wd(c), ficheOf(c) ?? '', l.specAskedRules ?? [])) : `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  if (kind === 'fiche') {
    vars.fiche = ficheReviewText({ fiche: ficheOf(c) ?? '', passes: l.fiche?.passes ?? 0, previous: l.ficheConstats });
    vars.reponse = '';
  }
  if (kind === 'maquette') {
    vars.maquette = maquetteText({ fiche: ficheOf(c) ?? '', passes: l.maquette?.passes ?? 0, max: c.config.maquetteReviews, previous: l.maquetteConstats });
    vars.reponse = '';
  }
  if (kind === 'accept') {
    const fiche = ficheOf(c) ?? '';
    const folder = posix.dirname(fiche);
    vars.accept = acceptText({ fiche, maquette: `${folder}/maquette.html`, screen: !!l.screen, back: !!l.screen && partsOf(c, fiche).back, acceptation: acceptationFile(fiche, l.lot), command: c.config.accept ?? '', test: c.config.test, runner: acceptRunner(), problems: l.acceptProblems });
    vars.objectif = ''; // l'oracle est écrit depuis la fiche et la maquette seules, pas depuis le texte du lot
    vars.commits = '';
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  if (kind === 'implement' || kind === 'fix') {
    const interrupted = [...l.steps].reverse().find((s) => s.kind === kind && s.status === 'interrupted');
    if (kind === 'fix') {
      vars.commits = lotCommitLines(c);
      vars.constats = constatLines(l.constats);
      if (l.docsFix) {
        vars.elsewhere = articlesBrief(l.repo, docsConfig(c).articles ?? []);
        vars.ack = wd(c) === l.repo
          ? `run \`raf docs-ok ${l.lot} --reason "why the documentation stays true"\` (a reason is required), then commit the plan file alone (\`git add -- .cadence/raf.yaml\`, or the path of the plan; message \`chore(${l.lot}): docs-ok\`).`
          : `this is a worktree, where only the program writes the plan: do not run \`raf docs-ok\` and do not touch the plan file. Make no commit and say under "choix" why the documentation stays true: the lot is handed back to the lead, who acknowledges it in the main checkout (\`raf docs-ok ${l.lot} --reason "…"\`).`;
      }
    } else if (interrupted) {
      const mine = lotCommitLines(c);
      vars.commits = mine
        ? `A previous session was interrupted; resume from these commits of the lot already present:\n${mine}`
        : 'A previous session was interrupted before any commit of the lot; start again from the current state of the repository.';
    }
    if (kind === 'implement' && l.precheck) vars.commits = [vars.commits, l.precheck].filter(Boolean).join('\n');
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  return renderBrief(briefName(l, kind, !!c.integration), vars, c.wave.templates);
}

/** Les dépôts voisins du lot, vus avant et après une session. */
type Others = { repo: LotRepo; before: Snapshot; after: Snapshot }[];

type Done = { step: StepState; report: unknown; before: Snapshot; after: Snapshot; others: Others };

/** Tokens comptés par les sessions d'un lot (un lot repris compte ses étapes d'avant). */
export const lotSpent = (l: LotState): number => l.steps.reduce((n, s) => n + (s.tokens?.counted ?? 0), 0);

/** Le lot a dépensé son propre budget (L78) : il ne compte plus que sur le lead, la vague garde le sien pour les autres. */
const lotOver = (l: LotState): boolean => l.budget !== undefined && lotSpent(l) >= l.budget - heldForEscalation(l);

/**
 * Coût réservé à l'escalade de modèle (L349) : une correction puis une revue neuve complète, jouées au modèle d'escalade. `lotBudget` l'ajoute au budget dérivé de
 * l'estimate quand `orchestrate.escalation` est déclarée, comme REVIEW_RESERVE paie la dernière passe : sans elle, l'escalade (L337) ne jouait que sur les lots
 * qui avaient peu consommé (cadence L341 494 k / 600 k et L342 572 k / 600 k, rendus « escalade fable non jouée (budget) »). ESTIMATION, aucune mesure : aucune
 * escalade n'a été jouée depuis L337 (le seul journal qui en porte une, cadence L342, l'a laissée non jouée). Elle est déduite des journaux `.cadence/runs` du
 * 2026-10-26 (823 passes fix : p90 67 k ; 1 009 revues complètes : p90 109 k), soit 176 k, arrondis à 175 k, au nombre de tokens comptés du modèle des passes
 * (le comptage ne distingue pas le tarif du modèle). À remesurer sur les premières escalades jouées (`cadence perf`, « Escalade de modèle »).
 */
export const ESCALATION_RESERVE = 175_000;

/** Part du budget que les passes ordinaires doivent laisser à l'escalade : retenue tant que l'escalade n'est pas engagée (ou écartée), libérée ensuite. */
export const heldForEscalation = (l: LotState): number => (l.escalation ? 0 : (l.escalationReserve ?? 0));

/**
 * Compteur du lot face au budget de ses passes ordinaires, pour les messages de refus (L349) : la part retenue pour l'escalade en est déduite et nommée
 * (« 6000 / 160999 tokens comptés, 175000 retenus pour l'escalade sur 335999 »), sinon un refus dans cette part contredirait ses propres chiffres ; sans
 * part retenue, le texte d'avant (« 6000 / 335999 tokens comptés »).
 */
const budgetCount = (l: LotState): string => {
  const held = heldForEscalation(l);
  return `${lotSpent(l)} / ${(l.budget ?? 0) - held} tokens comptés${held ? `, ${held} retenus pour l'escalade sur ${l.budget}` : ''}`;
};

/**
 * Coût réservé à une passe de correction et à la revue courte qui la suit (L145, étendu L218). Réserve fixe de 155 k tokens comptés :
 * p90 d'une passe fix (65 k) plus p90 d'une revue courte Opus (88 k), arrondi. Mesure faite le 2026-10-15 sur les journaux
 * `.cadence/runs` (523 fichiers de lot) : 497 passes fix Sonnet, médiane 45 k, p90 65 k, max 124 k ; 272 revues courtes Opus,
 * médiane 45 k, p90 88 k ; la somme des p90 majore le p90 de la somme, elle n'a pas été recalculée par lot. La réserve de L145 (65 k, revue
 * seule) laissait un lot rendu avant la correction à 740 k / 800 k (warhammer L120) ou 406 k / 450 k (maritime B26.1). Une passe fix ne part
 * que s'il reste de quoi payer la correction ET sa revue ; sinon le lot est rendu avec « correction non jouée (budget) ».
 * Seule exception : des tests rouges après une écriture (work() appelle toFix() sans revue) — la passe fix suivante peut
 * alors être refusée et le lot revient au lead sans revue, avec ses constats.
 */
export const REVIEW_RESERVE = 155_000;

/** Étapes d'écriture : les seules que le budget du lot borne (`session`), donc les seules qu'il puisse laisser non jouées. */
const WRITE_STEPS: readonly SessionKind[] = ['implement', 'fix', 'spec', 'accept'];

/**
 * Étape d'écriture que le budget a laissée non jouée (L223), pour un lot rendu au lead sur budget ; null sinon. `stop` vide `next` : l'étape se lit
 * dans l'outcome que `overBudget` écrit (« étape « fix » non jouée »), repli sur `next` s'il est resté. Reconnu par ce texte (aucun marqueur dans
 * l'état) : « correction non jouée (budget) » ou « budget du lot atteint ».
 */
export function budgetStep(l: LotState): SessionKind | null {
  if (l.status !== 'handed-back' || !/correction non jouée \(budget\)|budget du lot atteint/.test(l.outcome ?? '')) return null;
  const named = /étape « ([\w-]+) » non jouée/.exec(l.outcome ?? '')?.[1] as SessionKind | undefined;
  const step = named ?? l.next;
  return step && step !== 'integrate' && WRITE_STEPS.includes(step) ? step : null;
}

/** Le budget du lot paie-t-il la passe de correction et la revue courte qui la suit ? Sans budget de lot : toujours. La part de l'escalade (L349) n'est pas à dépenser, sauf pour décider l'escalade elle-même (`escalating`). */
const fixAffordable = (l: LotState, escalating = false): boolean => l.budget === undefined || lotSpent(l) + REVIEW_RESERVE < l.budget - (escalating ? 0 : heldForEscalation(l));

/** Cause d'une suspension demandée par `--stop-after-current` (L79). */
export const STOP_REQUESTED = 'arrêt demandé (--stop-after-current)';

/** Le lot a-t-il été écarté de la vague par `--drop` (L79) ? */
const dropped = (c: LotCtx): boolean => c.wave.store.control().drops.includes(lotKey(c.lot.project, c.lot.lot));
export const DROPPED = 'retiré de la vague (--drop)';

/** Mention de la réponse du lead restée en attente : un lot rendu sans que la session l'ait lue le dit (comme overBudget). */
const unplayedAnswer = (l: LotState): string => (l.pendingAnswer ? ` ; la réponse du lead (« ${l.pendingAnswer} ») n'a pas été jouée` : '');

/** Pourquoi plus aucune session ne doit partir (incident, quota, budget), sinon null. */
function halted(w: WaveCtx, lot?: LotState): string | null {
  if (w.store.control().stopAfterCurrent) return STOP_REQUESTED;
  if (w.incident) return `vague arrêtée : ${w.incident}`;
  if (lot && w.dirtyRepos) {
    for (const r of lotRepoPaths(lot)) {
      const by = w.dirtyRepos.get(r);
      if (by && w.movedRepos?.has(r)) return `dépôt ${r} laissé en HEAD déplacé par ${by} : à remettre sur sa branche par le lead avant de reprendre`;
      if (by) return `dépôt ${r} sali par la revue de ${by} : à nettoyer par le lead avant de reprendre`;
    }
  }
  if (w.quota.hit) return 'quota atteint';
  if (w.budget.exhausted) return 'budget atteint';
  return null;
}

/** Modèle d'une revue (L108) : la revue légère d'un lot léger tant qu'aucune correction n'a eu lieu, sinon la revue complète (UX comprise). */
function reviewModel(c: LotCtx, kind: SessionKind): AnyModel {
  const { light, full } = c.config.review;
  // Escalade (L337) : la revue neuve qui suit la correction escaladée se joue au modèle de l'escalade ; l'UX garde le sien.
  if (c.lot.escalation?.stage === 'fix' && (kind === 'review' || kind === 'review-small')) return c.lot.escalation.model;
  return c.lot.light && c.lot.pass === 0 && (kind === 'review' || kind === 'review-small') ? light : full;
}

/** Écarte le modèle local pour le reste de la vague (L322) : le premier échec suffit, les lots suivants n'attendent pas de le constater à leur tour. */
function benchLocal(c: LotCtx, cause: string): void {
  c.wave.localOut ??= cause.slice(0, 200);
}

/** Rendu par `session(…, true)` quand l'étape locale n'a rien donné (Ollama éteint, délai, rapport sans structure) : l'appelant se replie sur Sonnet (L146). */
const LOCAL_FAILED = Symbol('local-failed');

/** Une session : budget et quota vérifiés avant, état écrit avant et après, journal gardé, contrôles du dépôt après. */
async function session(c: LotCtx, kind: SessionKind, local: true): Promise<Done | null | typeof LOCAL_FAILED>;
async function session(c: LotCtx, kind: SessionKind, local?: false): Promise<Done | null>;
async function session(c: LotCtx, kind: SessionKind, local = false): Promise<Done | null | typeof LOCAL_FAILED> {
  const w = c.wave;
  const l = c.lot;
  if (dropped(c)) return stop(c, 'handed-back', DROPPED + unplayedAnswer(l));
  const halt = halted(w, l);
  if (halt) return suspend(c, halt);
  const write = kind === 'implement' || kind === 'fix' || kind === 'spec' || kind === 'accept';
  // Le budget du lot borne l'écriture, jamais la revue (L145) : une revue est jouée dès que le code est à relire (sauf tests rouges après une écriture, cf. REVIEW_RESERVE), la passe fix réserve son coût.
  if (write && (lotOver(l) || (kind === 'fix' && !fixAffordable(l)))) return overBudget(c, kind === 'fix' && !lotOver(l));

  const model: StepModel = kind === 'spec' || kind === 'accept' || kind === 'fiche' ? 'sonnet' : write ? (kind === 'fix' && l.escalation?.stage === 'fix' ? l.escalation.model : l.model) : local ? 'local' : kind === 'precheck' ? 'sonnet' : reviewModel(c, kind); // le contrôle préalable ne fait que lire : pas d'Opus
  const effort = c.config.effort[kind === 'review-small' ? 'review' : kind];
  const before = await snapshot(wd(c));
  const neighbours = l.repos ?? [];
  const beforeOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const n = l.steps.length + 1;
  const sessionId = randomUUID();
  const step: StepState = { n, kind, model, ...(effort !== 'default' ? { effort } : {}), status: 'running', sessionId, started: new Date().toISOString(), headBefore: before.head ?? undefined };
  l.steps.push(step);
  const label = { implement: 'implementing', fix: 'fixing', review: 'reviewing', ux: 'reviewing', 'review-small': 'reviewing', precheck: 'implementing', spec: 'implementing', accept: 'implementing', maquette: 'reviewing', fiche: 'reviewing' } as const;
  transition(c, label[kind]);
  w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} (${model})`);

  let brief: string;
  try {
    brief = briefFor(c, kind, local);
  } catch (e) {
    step.status = 'failed';
    step.cause = (e as Error).message;
    return stop(c, 'failed', `brief de ${kind} : ${(e as Error).message}`);
  }
  const mcpConfig = writeMcpConfig(w.store.lotDir(l.project, l.lot), kind, l.visible, l.small, !!l.screen);
  const playwright = !!mcpServersFor(kind, l.visible, '', l.small, !!l.screen).playwright;
  if (playwright) l.uxCaptures = join(dirname(mcpConfig), 'playwright');
  const answerInBrief = l.pendingAnswer; // gardée pour la rendre si la session ne part jamais (créneau abandonné, L332)
  l.pendingAnswer = null; // la réponse est dans le brief : elle ne repart pas avec la session suivante
  const tmpDir = w.store.tmpDir(l.project, l.lot); // TMPDIR de la session, aussi en --add-dir : hors du cwd, un Write y serait refusé en `claude -p`
  // Délai (L298) : l'étape d'écriture est proportionnée à l'estimate et à la fiche du lot, puis prolongée à chaque échéance où elle a commité.
  const delay = write ? workTimeoutMs(c.config.timeouts.work, l.estimate, hasSpecStage(l)) : c.config.timeouts.review;
  let seenHead = before.head;
  const extend = write
    ? {
        progressed: () => {
          const head = (() => {
            try {
              return git(wd(c), 'rev-parse', 'HEAD').trim();
            } catch {
              return seenHead;
            }
          })();
          const moved = head !== seenHead;
          seenHead = head;
          return moved;
        },
        ms: EXTENSION_MS,
        max: MAX_EXTENSIONS,
      }
    : undefined;
  const outcome = await runSession(
    {
      kind,
      sessionId,
      brief,
      model: local ? 'sonnet' : (model as AnyModel),
      effort,
      local,
      schema: schemaFor(kind),
      agent: kind === 'spec' ? 'spec-writer' : kind === 'accept' ? 'acceptance-writer' : kind === 'ux' || kind === 'maquette' ? 'ux-reviewer' : kind === 'precheck' ? 'precheck-reader' : kind === 'fix' && l.docsFix ? 'doc-keeper' : write ? undefined : 'code-reviewer',
      cwd: wd(c),
      wave: w.id,
      lot: lotKey(l.project, l.lot),
      permissionMode: c.config.permissionMode,
      prodAccess: c.config.prodAccess,
      addDirs: [...c.config.addDirs, ...(playwright && write ? [playwrightDir(dirname(mcpConfig))] : []), tmpDir, ...neighbourDirs(l), ...(kind === 'fix' && l.docsFix ? (docsConfig(c).articles ?? []).map((r) => articleRepoDir(l.repo, r)) : [])],
      nodeBin: l.node?.link,
      testWorkers: w.testWorkers,
      toolBin: toolBinOf(w.store.dir),
      tmpDir,
      mcpConfig,
      playwright,
      timeoutMs: delay,
      extend,
    },
    {
      claude: w.claude,
      agents: w.agents,
      onSpawn: (pid) => {
        step.pid = pid;
        save(c);
      },
      // La session neuve de la relance (L256) devient la session de l'étape dès son lancement : un signal pendant qu'elle tourne la tue (killSessions) et compte ses jetons (countInterrupted).
      onRelaunch: (id) => {
        step.sessionId = id;
        save(c);
      },
    },
  ).catch((e: unknown) => {
    if (e instanceof SlotAbandoned) return e;
    throw e;
  });
  if (outcome instanceof SlotAbandoned) {
    // L332 : la demande est arrivée pendant l'attente d'un créneau. Une étape qui n'a pas démarré (aucun pid) n'a pas eu lieu : elle ne figure pas à l'état.
    // Rien de ce que le brief a consommé n'a servi : la réponse du lead (retirée de pendingAnswer avant le lancement) revient, la reprise rejoue l'étape avec elle.
    if (step.pid === undefined) {
      l.steps.pop();
      l.pendingAnswer = answerInBrief;
    } else {
      // Une session de l'étape a déjà tourné (le pid est le sien) et c'est son lancement SUIVANT qui attendait un créneau (relance d'une session coupée, relance de mise en forme) :
      // sa sortie, son identifiant et ses jetons sont gardés, la cause dit ce qui n'a pas eu lieu.
      const dir = w.store.lotDir(l.project, l.lot);
      const base = `${n}-${kind}`;
      const after = outcome.after;
      const spentOf = (sessionId: string): Tokens | null => (w.claudeHome ? (journalTokens(w.claudeHome, wd(c), sessionId)?.tokens ?? null) : null);
      let tokens: Tokens | null = null;
      let cause = outcome.message;
      if (after?.relaunched) {
        const cutRun = after.relaunched;
        tokens = spentOf(cutRun.sessionId);
        step.sessionId = cutRun.sessionId; // la session neuve n'a jamais démarré : l'étape est celle de la session coupée
        writeFileSync(join(dir, `${base}.first.err`), cutRun.stderr);
        cause = `coupée (${cutRun.cause}), relance en session neuve non faite : ${outcome.message}`;
        l.warnings.push(`${kind} coupée (${cutRun.cause}) : sa relance en session neuve n'a pas eu lieu, ${outcome.message}`);
      } else if (after?.formatting) {
        const first = after.formatting;
        tokens = first.tokens ?? (first.sessionId ? spentOf(first.sessionId) : null);
        if (first.sessionId) step.sessionId = first.sessionId;
        writeFileSync(join(dir, `${base}.first.json`), first.stdout);
        writeFileSync(join(dir, `${base}.first.err`), first.stderr);
        cause = `sortie sans structured_output, relance de mise en forme non faite : ${outcome.message}`;
      }
      if (tokens && !local) {
        step.tokens = tokens;
        w.budget.add(tokens);
      }
      step.status = 'failed';
      step.cause = cause;
      step.ended = new Date().toISOString();
      w.saveWave();
    }
    return outcome.reason === DROPPED ? stop(c, 'handed-back', DROPPED + unplayedAnswer(l)) : suspend(c, outcome.reason);
  }
  step.ended = new Date().toISOString();
  const dir = w.store.lotDir(l.project, l.lot);
  const base = `${n}-${kind}`;

  // Jetons de la session coupée (L256) : au budget de la vague ci-dessous, et à l'étape pour que le lot (L78) et le tableau les comptent.
  let cutTokens: Tokens | null = null;
  if (outcome.relaunched) {
    // Étape en lecture coupée (signal, sortie vide) puis relancée en session neuve (L256) : la session coupée a consommé des jetons (son journal), garde sa sortie d'erreur, et la relance est signalée au tableau.
    const cutRun = outcome.relaunched;
    const spent = w.claudeHome ? journalTokens(w.claudeHome, wd(c), cutRun.sessionId) : null;
    if (spent) {
      w.budget.add(spent.tokens);
      cutTokens = spent.tokens;
    }
    writeFileSync(join(dir, `${base}.first.err`), cutRun.stderr);
    const text = `${kind} relancée en session neuve après une coupure (${cutRun.cause})`;
    l.warnings.push(text);
    w.log(`${lotKey(l.project, l.lot)} · session ${n} ${text}`);
    w.saveWave();
  }
  if (outcome.kind !== 'ok' && !local) {
    // Une session en échec, au quota ou tuée au délai a consommé des tokens : ceux de sa sortie, sinon ceux de son journal.
    const spent = outcome.tokens ? { tokens: outcome.tokens, sessionId: outcome.sessionId } : w.claudeHome ? journalTokens(w.claudeHome, wd(c), outcome.sessionId ?? sessionId) : null;
    if (spent) {
      step.tokens = cutTokens ? sumTokens(cutTokens, spent.tokens) : spent.tokens;
      if (spent.sessionId) step.sessionId = spent.sessionId;
      w.budget.add(spent.tokens);
      w.saveWave();
      if (w.claudeHome && spent.sessionId) step.peakContext = peakContext(w.claudeHome, wd(c), spent.sessionId);
    } else if (cutTokens) {
      step.tokens = cutTokens;
    }
  }
  if (local && outcome.kind !== 'ok') {
    // Hors quota Anthropic : rien au budget (ni sortie, ni journal), et jamais d'arrêt du lot — Sonnet reprend le contrôle.
    // Un appel d'outil écrit en texte (`<function=Bash>`) est une sortie sans structured_output : le local n'a pas tenu l'appel d'outils, inutile d'attendre un second tour.
    const textCall = outcome.kind === 'failed' && outcome.stdout.includes('<function=');
    const cause = textCall ? 'appel d\'outil écrit en texte, pas de structured_output' : outcome.kind === 'failed' ? outcome.cause : outcome.message;
    writeFileSync(join(dir, `${base}.json`), outcome.kind === 'failed' ? outcome.stdout : '');
    if (outcome.kind === 'failed') writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.status = 'failed';
    step.cause = cause;
    step.report = `${base}.json`;
    delete step.tokens;
    l.warnings.push(`contrôle préalable : modèle local sans résultat (${cause.slice(0, 200)}), repli sur Sonnet`);
    benchLocal(c, cause);
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
    if (write && outcome.cause === 'délai dépassé') {
      // L298 : le travail laissé par une étape d'écriture coupée au délai est signalé (commits, fichiers, tests), pas un « échec » sec ; L303 : dans les dépôts voisins aussi.
      const repos = [{ rel: '', path: wd(c), before }, ...neighbours.map((r, i) => ({ rel: r.rel, path: r.path, before: beforeOthers[i] }))];
      const files: string[] = [];
      let commits = 0;
      let numstat = '';
      for (const r of repos) {
        const after = await snapshot(r.path);
        files.push(...dirtBetween(r.before, after).map((f) => (r.rel ? `${r.rel}: ${f}` : f)));
        if (r.before.head) commits += readCommits(r.path, { range: `${r.before.head}..HEAD` }).length;
        try {
          numstat += git(r.path, 'diff', '--numstat', 'HEAD');
        } catch {
          // pas de HEAD : aucune ligne comptée
        }
        numstat += '\n';
      }
      const report = cutReport({ minutes: Math.round(delay / 60_000), commits, files, numstat });
      step.cause = report;
      return stop(c, files.length || commits ? 'handed-back' : 'failed', `délai dépassé : ${kind} ${report}`, escalatedSession(c, kind));
    }
    return stop(c, 'failed', outcome.cut ? `coupure : ${kind} ${outcome.cause}` : `échec : ${kind} sans résultat : ${outcome.cause}`, escalatedSession(c, kind));
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
  step.tokens = local ? { ...res.tokens, counted: 0 } : cutTokens ? sumTokens(cutTokens, res.tokens) : res.tokens; // local : hors quota, hors budget
  if (res.formattingRetry) {
    step.formatRetry = true;
    w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} : rapport sans sortie structurée, relance de mise en forme`);
  }
  if (!local) w.budget.add(res.tokens);
  w.saveWave();
  if (w.claudeHome) step.peakContext = peakContext(w.claudeHome, wd(c), res.sessionId);

  const after = await snapshot(wd(c));
  const afterOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const others: Others = neighbours.map((repo, i) => ({ repo, before: beforeOthers[i], after: afterOthers[i] }));
  step.headAfter = after.head ?? undefined;
  // Le dépôt du projet d'abord, puis chaque voisin : mêmes contrôles, l'incident nomme le dépôt voisin.
  const watched = [{ where: '', path: wd(c), repo: c.lot.repo, before, after }, ...others.map((o) => ({ where: ` dans ${o.repo.rel}`, path: o.repo.path, repo: o.repo.path, before: o.before, after: o.after }))];
  // Les incidents d'abord, dans TOUS les dépôts surveillés (projet et voisins) : un push ou un hook de garde supprimé où que ce soit arrête la vague, avant tout traitement d'un HEAD déplacé ou d'un lot rendu (L214).
  for (const { where, repo, before: b, after: a } of watched) {
    const delivered = pushed(b, a) ? leadDelivery(c, repo, b, a) : null;
    if (delivered) w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} : push du lead (livraison ${delivered.length ? `de ${delivered.join(', ')}` : 'du plan'}) toléré${where}`);
    else if (pushed(b, a)) {
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
  }
  for (const { where, path, before: b, after: a } of watched) {
    // Session d'écriture finie sur une autre branche ou en HEAD détaché (L214) : pas un push, mais les contrôles et le lot suivant partiraient d'un HEAD qui n'est plus la branche du lot.
    if (write && b.branch !== a.branch) {
      const was = `${a.branch ? `sur la branche ${a.branch}` : `en HEAD détaché (${(a.head ?? '').slice(0, 7)})`} au lieu de ${b.branch ?? 'HEAD détaché'}`;
      const why = b.branch ? headStranded(path, b, a) : 'le dépôt n\'était pas sur une branche au départ';
      // La remise peut échouer (index.lock, fichier en conflit) : le lot est rendu, l'orchestrateur ne s'arrête pas (L214).
      let failed: string | null = null;
      if (b.branch && why === null) {
        try {
          git(path, 'checkout', '-q', b.branch);
        } catch (e) {
          failed = `HEAD déplacé — remise de la branche ${b.branch} impossible : ${gitFailure(e)}`;
        }
      }
      if (b.branch && why === null && failed === null) {
        Object.assign(a, await snapshot(path));
        if (path === wd(c)) step.headAfter = a.head ?? undefined;
        const text = `${kind} : la session a fini${where} ${was} (arbre propre, rien hors de la branche) — branche ${b.branch} remise`;
        l.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      } else if (!b.branch) {
        const text = `${kind} : la session a fini${where} ${was} — ${why}`;
        l.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      } else {
        step.status = 'failed';
        step.cause = failed ? `${failed}${where}` : `HEAD déplacé${where}`;
        (w.dirtyRepos ??= new Map()).set(path, lotKey(l.project, l.lot));
        (w.movedRepos ??= new Set()).add(path);
        return stop(c, 'handed-back', `incident : HEAD déplacé${where} pendant ${lotKey(l.project, l.lot)} (${kind}) : la session a fini ${was} et ${failed ?? why}`);
      }
    }
    // Étape en lecture seule qui n'a laissé que des fichiers NON SUIVIS (captures d'un script en chemin relatif, L162) : déplacés dans le dossier du lot, avertissement, le verdict est gardé.
    if (!write && b.head === a.head && b.tracked.join() === a.tracked.join() && b.untracked.join() !== a.untracked.join() && b.untracked.every((f) => a.untracked.includes(f))) {
      const fresh = a.untracked.filter((f) => !b.untracked.includes(f)).map(unquotePath);
      const stray = join(dir, 'stray');
      const to = where ? join(stray, relative(wd(c), path).replace(/[\\/]/g, '_')) : stray;
      const moved = moveStray(path, fresh, to);
      if (moved.length) {
        const text = `${kind} : ${moved.length} fichier(s) non suivi(s) laissé(s)${where} par une étape en lecture seule, déplacé(s) dans ${to} : ${moved.join(', ')}`;
        c.lot.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      }
      if (moved.length === fresh.length) continue;
      // Déplacement partiel : l'incident ne nomme que ce qui reste dans le dépôt.
      return handBack(c, kind, res.structured, step, where, path, b, a, fresh.filter((f) => !moved.includes(f)));
    }
    if (!write && (b.head !== a.head || b.tracked.join() !== a.tracked.join() || b.untracked.join() !== a.untracked.join())) {
      return handBack(c, kind, res.structured, step, where, path, b, a);
    }
  }
  const touched = write && c.tree?.active ? planTouched(c, before.head, after) : null;
  if (touched) {
    step.status = 'failed';
    step.cause = touched;
    return stop(c, 'handed-back', `la session a modifié le plan dans son worktree ${touched} : le plan n'est écrit que par le programme ; worktree conservé : ${wd(c)}`);
  }
  step.status = 'ok';
  save(c);
  return { step, report: res.structured, before, after, others };
}

/**
 * Une session d'écriture a-t-elle touché, dans son worktree, le fichier de plan ou un fichier généré avec lui (plan.files, la page Gantt) ? (R21) Le plan n'est
 * écrit que par le programme, dans le dépôt du projet : un commit de plan sur la branche du lot reviendrait en conflit au rebase. Rend « (fichier, commit sha) »
 * ou « (fichier, non commité) », null sinon.
 */
function planTouched(c: LotCtx, headBefore: string | null, after: Snapshot): string | null {
  const files = planFileSet(c.loadPlan(), c.lot.repo);
  if (headBefore && after.head && headBefore !== after.head) {
    for (const sha of git(wd(c), 'log', '--format=%H', `${headBefore}..${after.head}`).split('\n').filter(Boolean)) {
      const hit = changedFiles(wd(c), sha).find((f) => files.has(f));
      if (hit) return `(${hit}, commit ${sha.slice(0, 7)})`;
    }
  }
  const dirty = trackedPaths(after).find((f) => files.has(f));
  return dirty ? `(${dirty}, non commité)` : null;
}

/** Pourquoi la branche de départ ne peut pas être remise sans risque après un HEAD déplacé (L214), null si elle le peut : arbre propre et rien hors de la branche. */
function headStranded(path: string, b: Snapshot, a: Snapshot): string | null {
  if (a.tracked.length || a.untracked.join() !== b.untracked.join()) return 'l\'arbre n\'est pas propre';
  // Le HEAD final, et chaque position prise par HEAD pendant la session (reflog) : un commit fait en chemin puis quitté n'est plus que dans le reflog.
  let seen: string[] = [];
  try {
    seen = git(path, 'reflog', '--format=%H', `-n${Math.max(0, a.reflog - b.reflog)}`, 'HEAD').split('\n').filter(Boolean);
  } catch {
    // reflog illisible : le HEAD final seul juge
  }
  for (const sha of [a.head ?? 'HEAD', ...seen]) {
    try {
      git(path, 'merge-base', '--is-ancestor', sha, `refs/heads/${b.branch}`);
    } catch {
      return `des commits ne sont pas dans la branche ${b.branch}`;
    }
  }
  return null;
}

/**
 * Le push du lead pour livrer un lot prêt de la vague (L352) : `git push origin <sha>:main`, le chemin « livrable jusqu'à <sha> » du skill lead.
 * Toléré quand chaque branche distante qui a bougé avance en avant (ou est créée) vers un sha ancêtre du HEAD du dépôt et que ce sha ne contient aucun
 * commit d'un lot de la vague qui n'est pas prêt (la garde de `deliver --sha`, `blockingLots`) : ne restent que des commits de lots prêts ou du plan.
 * Renvoie les lots prêts livrés (vide : du plan seulement) ; null pour tout autre push, qui reste un incident — dont une branche supprimée, un push
 * forcé, un sha hors de l'histoire de HEAD ou des commits d'un lot en cours ou illisibles.
 */
function leadDelivery(c: LotCtx, repo: string, before: Snapshot, after: Snapshot): string[] | null {
  const moved = remoteAdvances(before, after);
  if (!moved) return null;
  const lots = c.wave.store.lots().filter((x) => lotKey(x.project, x.lot) !== lotKey(c.lot.project, c.lot.lot));
  const here = [c.lot, ...lots].filter((x) => x.repo === repo || (x.repos ?? []).some((r) => r.path === repo));
  const delivered = new Set<string>();
  for (const { from, to } of moved) {
    if (!isAncestor(repo, to, 'HEAD') || (from !== null && !isAncestor(repo, from, to))) return null;
    const { blocking, unreadable } = blockingLots(here, repo, to);
    if (blocking.length > 0 || unreadable.length > 0) return null;
    for (const x of here) {
      if (x.status !== 'ready') continue;
      try {
        if (gitCommitsIn(x, repo).some((k) => isAncestor(repo, k, to) && (from === null || !isAncestor(repo, k, from)))) delivered.add(lotKey(x.project, x.lot));
      } catch {
        return null;
      }
    }
  }
  return [...delivered];
}

/** Incident du LOT (L133) : la revue a laissé des traces (captures, commit), ni push ni garde supprimée — les lots des autres dépôts continuent. */
function handBack(c: LotCtx, kind: SessionKind, report: unknown, step: StepState, where: string, path: string, b: Snapshot, a: Snapshot, left?: string[]): null {
  const l = c.lot;
  const w = c.wave;
  step.status = 'failed';
  step.cause = `le dépôt${where} a changé pendant une revue`;
  const traces = left ?? [...trackedPaths(a).filter((f) => !trackedPaths(b).includes(f)), ...a.untracked.filter((f) => !b.untracked.includes(f))];
  (w.dirtyRepos ??= new Map()).set(path, lotKey(l.project, l.lot));
  const what = traces.length ? ` (${traces.join(', ')})` : b.head !== a.head ? ' (commit)' : '';
  return stop(c, 'handed-back', `incident : ${kind} de ${lotKey(l.project, l.lot)} a modifié le dépôt${where}${what}${lostVerdict(c, kind, report)}`);
}

/** Décode un chemin de `git status --porcelain` : entre guillemets, avec les échappements du C-quoting (`\303\251`, `\"`, `\\`, `\t`…). */
function unquotePath(f: string): string {
  if (!/^".*"$/s.test(f)) return f;
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const body = f.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      const n = body[++i];
      bytes.push(...(n in esc ? [esc[n]] : Buffer.from(n)));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Déplace des fichiers non suivis (chemins relatifs au dépôt, décodés) sous `to`, arborescence gardée ; renvoie ceux qui l'ont été (s'arrête au premier échec). */
function moveStray(repo: string, files: string[], to: string): string[] {
  const moved: string[] = [];
  for (const rel of files) {
    try {
      const from = join(repo, rel);
      let dest = join(to, rel);
      for (let i = 1; existsSync(dest); i++) dest = join(to, `${rel}.${i}`);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        renameSync(from, dest);
      } catch {
        copyFileSync(from, dest); // autre volume
        rmSync(from);
      }
      moved.push(rel);
    } catch {
      break;
    }
  }
  return moved;
}

/** Verdict d'une revue interrompue par un incident du lot : rapporté au lead plutôt que perdu (L133). Rien n'est enregistré dans le plan. */
function lostVerdict(c: LotCtx, kind: SessionKind, report: unknown): string {
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
  const basis = hasSpecStage(l) ? 'estimate et étape spec' : "dérivé de l'estimate";
  const why = reserve ? `budget du lot : ${budgetCount(l)} (${basis}), il ne reste pas de quoi payer la correction et la revue courte qui la suivrait (${REVIEW_RESERVE} réservés)` : `budget du lot atteint (${budgetCount(l)}, ${basis})`;
  // Tests rouges après une écriture : la passe fix refusée aurait suivi, le lot revient sans revue (L145) — la cause le dit.
  const red = l.next === 'fix' && l.constats.some((k) => k.source === 'tests');
  // Passe d'écriture qui vient d'être jouée, nommée d'après le compteur : l.pass - 1 passes de correction l'ont précédée (minorPass reste vrai après la passe des mineurs). Sans passe jouée, un lot repris déjà revu compte ses tests rouges depuis la revue de sa branche ; jamais revu (L315), c'est l'implémentation qui les a laissés.
  const played = l.pass - 1;
  const after = l.minorPass && played === (l.minorPassAt ?? 0) ? 'la passe des mineurs' : played > 0 ? `la passe fix ${played}` : l.resumedFrom && l.resumedReviewed ? 'la dernière revue de la branche reprise' : "l'implémentation";
  const notPlayed = l.next === 'fix' ? 'correction non jouée (budget) : ' : '';
  const prefix = notPlayed + (red ? `tests rouges après ${after}, correction suivante non abordable : ` : '');
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

/**
 * Mots du titre ou du goal qui disent que le lot reprend un constat : le livrable peut déjà exister. Mots entiers (« review » ne
 * se lit pas dans `qa-reviewer` ni `review-small`), au pluriel ou accordés pour « constat ».
 */
const CITES_FINDING = /(?<![\w-])(?:constat\w*|revues?|reviews?|audits?)(?![\w-])/i;

/**
 * Le texte du lot (titre, goal, objectif donné) cite un constat, ou un autre lot dont le travail a pu être fait. Pour un lot
 * `L<n>`, « L12 » compte dans le texte de `L30` (aussi dans « L12-L15 », « L12-bis », « L12.3 ») et non celui de `L12` ni d'un lot postérieur ; tout identifiant du plan qui n'est
 * pas `L<n>` (`Q-CAN5`, `B28.1`, `Q4/qa-expectations`) compte cité en entier (`B28.1` n'est pas `B28.10`), pour un lot `L<n>`
 * comme pour un autre ; un lot d'un autre projet (`cadence:L68`) compte toujours.
 */
function citesPriorWork(text: string, lot: string, ids: string[]): boolean {
  if (CITES_FINDING.test(text)) return true;
  const { ids: cited, foreign } = citedLots(text, lot, ids);
  return foreign || cited.length > 0;
}

/**
 * Les lots que le texte cite (même reconnaissance que `citesPriorWork`, L288/L292) : les identifiants du plan cités, et `foreign` quand il cite un lot d'un autre projet
 * (`cadence:L68`, dont on ne lit pas les commits ici).
 */
function citedLots(text: string, lot: string, ids: string[]): { ids: string[]; foreign: boolean } {
  const foreign = /(?<![\w-])[a-z][\w-]*:L\d+(?!\w)/i.test(text);
  const own = /^L(\d+)$/.exec(lot);
  const cited = (id: string) => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`).test(text);
  return {
    foreign,
    ids: ids.filter((id) => {
      if (id === lot) return false;
      const n = /^L(\d+)$/.exec(id);
      if (own && n) return Number(n[1]) < Number(own[1]) && new RegExp(`(?<![\\w-])${id}(?!\\w)`).test(text);
      return cited(id);
    }),
  };
}

/**
 * Le contrôle préalable ne vaut que pour un lot sans commit (avec des commits, l'implémentation reprend légitimement) dont le
 * titre ou le goal (clé `goal:` du plan, ou `goal` donné au lancement) cite un constat ou un autre lot (L288, L292) : sans cela
 * rien ne laisse croire qu'un autre lot l'a déjà livré, et le contrôle coûtait 7 % des tokens pour 10 « oui » sur 30 mesurés
 * (audit du 24-10). Sur le modèle local (`precheck: local`, L296) le critère tombe : le titre faisait perdre 7 des 17 « oui »
 * réels, et le contrôle ne coûte plus rien au quota (seul un « oui » est confirmé par Sonnet).
 */
export function needsPrecheck(config: { precheck: boolean; precheckLocal?: boolean }, plan: Plan, repo: string, lot: string, repos: LotRepo[] = [], goal?: string): boolean {
  if (!config.precheck || hasWork(plan, repo, { repos, lot })) return false;
  if (config.precheckLocal) return true;
  const l = plan.lot(lot);
  const text = [l.title, l.goal, goal].filter(Boolean).join('\n');
  return citesPriorWork(text, lot, plan.lots().map((x) => x.id));
}

/**
 * Un lot créé après le dernier commit de code du dépôt n'a rien à retrouver (L322) : tout ce que le dépôt contient date d'avant le lot, donc aucun autre lot ne l'a livré.
 * Rend la raison à écrire au journal, ou null quand le contrôle garde un sens. Le lot est daté par le commit qui a ajouté son id au plan, borné par sa clé `created` (une
 * migration ou un déplacement du plan ne rajeunit pas un vieux lot) ; le dernier commit de code est le dernier qui ne touche pas que le plan (`isPlanOnly`). Prudent : lot
 * qui travaille dans des dépôts voisins, id introuvable dans l'historique du plan, dépôt sans commit de code ou instants égaux → le contrôle reste.
 * Le contrôle reste aussi quand le titre ou le goal (ou le goal donné au lancement) cite un lot qui a déjà ses propres commits, ou un lot d'un autre projet : une « suite de revue L<n> » écrite
 * juste après le dernier correctif de L<n> liste des constats que les passes de correction de L<n> ont pu régler avant la création du lot (rejoué depuis le 24-10 : 5 lots sautés à tort,
 * dont 2 avec un vrai « partiel »).
 */
export function precheckNothingToFind(plan: Plan, root: string, lot: string, repos: LotRepo[] = [], goal?: string): string | null {
  if (repos.length) return null;
  try {
    const rel = relative(root, plan.path);
    const idLine = `^\\s*- id: ["']?${lot.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']?\\s*$`;
    // Pas de `--reverse` : avec `--follow`, git 2.43 ne rend rien sur un fichier renommé (`raf migrate`) ; le plus ancien est la dernière ligne.
    const added = git(root, '-c', 'core.quotepath=off', 'log', '--follow', '--format=%ct', '-G', idLine, '--', rel).split('\n').filter(Boolean).pop();
    if (!added) return null;
    const created = plan.lot(lot).created;
    const endOfCreated = created ? Date.parse(`${created}T23:59:59`) / 1000 : Infinity;
    const createdAt = Math.min(Number(added), Number.isNaN(endOfCreated) ? Infinity : endOfCreated);
    const log = git(root, 'log', '--format=%H %ct').split('\n').filter(Boolean);
    const code = log.map((x) => x.split(' ')).find(([sha]) => !isPlanOnly(sha!, plan, root));
    if (!code) return null;
    if (createdAt <= Number(code[1])) return null;
    const l = plan.lot(lot);
    const { ids, foreign } = citedLots([l.title, l.goal, goal].filter(Boolean).join('\n'), lot, plan.lots().map((x) => x.id));
    if (foreign || ids.some((id) => lotWork(plan, root, id).length > 0)) return null;
    return `lot créé après le dernier commit de code du dépôt (${code[0]!.slice(0, 7)}) : rien à retrouver`;
  } catch {
    return null;
  }
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
  if (c.config.precheckLocal && c.wave.localOut) {
    l.warnings.push(`contrôle préalable : modèle local écarté pour la vague (${c.wave.localOut}), Sonnet directement`);
  } else if (c.config.precheckLocal) {
    // Modèle local (L146) : un échec, un rapport illisible ou un « oui » (qui rendrait le lot sans implémentation) rend la main à Sonnet.
    const done = await session(c, 'precheck', true);
    if (!done) return;
    if (done !== LOCAL_FAILED) {
      try {
        rep = checkShape<PrecheckReport>(done.report, PRECHECK_SCHEMA);
      } catch (e) {
        l.warnings.push(`${LOCAL_PRECHECK_UNREADABLE} (${(e as Error).message}), repli sur Sonnet`);
        benchLocal(c, `rapport illisible : ${(e as Error).message}`);
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
      l.warnings.push(`${PRECHECK_UNREADABLE} : ${(e as Error).message}`);
      l.next = firstWrite(c);
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
  l.precheckVerdict = unproven ? 'partiel' : rep.dejaPresent;
  if (unproven) l.warnings.push('contrôle préalable : « oui » sans preuve, traité comme partiel');
  if (rep.dejaPresent === 'oui' && !unproven) {
    stop(c, 'handed-back', `livrable déjà présent : ${rep.resume.trim()}${proofs}`);
    return;
  }
  if (rep.dejaPresent === 'partiel' || unproven) {
    l.precheck = `A pre-check found part of the deliverable already in the repository (do not redo it): ${rep.resume.trim()}${proofs}`;
    l.warnings.push(`contrôle préalable : livrable en partie présent — ${rep.resume.trim()}${proofs}`);
  }
  l.next = firstWrite(c);
  save(c);
}

/** Le lot passe-t-il par le contrôle préalable ? Un lot qui n'a rien à retrouver (L322) saute l'étape, et le journal du lot le dit. */
function precheckOrSkip(c: LotCtx): boolean {
  const plan = c.loadPlan();
  if (!needsPrecheck(c.config, plan, c.lot.repo, c.lot.lot, c.lot.repos, c.lot.goal)) return false;
  const nothing = precheckNothingToFind(histPlan(c), wd(c), c.lot.lot, c.lot.repos, c.lot.goal);
  if (nothing) c.lot.warnings.push(`contrôle préalable sauté : ${nothing}`);
  return !nothing;
}

/** Première session d'écriture d'un lot : la spec quand il déclare `screen:` ou `spec: true` et qu'aucune fiche n'est écrite, sinon l'implémentation. */
function firstWrite(c: LotCtx): SessionKind {
  const l = c.lot;
  if (!hasSpecStage(l) || l.spec) return 'implement';
  const fiche = findFiche(wd(c), c.config.spec.dir, l.lot);
  return fiche && ficheReady(wd(c), fiche, l.lot, partsOf(c, fiche)) ? afterSpec(c, fiche) : 'spec';
}

const NO_TEST_ACCEPT = 'étape accept : orchestrate.test absent, rien ne prouve que les tests rouges sont exclus du lanceur de tests et de la CI (vérifier à la main la config du lanceur avant de livrer)';
const NO_ACCEPT = 'étape accept ignorée : orchestrate.accept absent (commande dédiée aux tests d\'acceptation), le lot passe de spec à implement sans tests rouges';

/**
 * Étape qui suit une spec écrite : la revue UX de la maquette (S4) tant qu'elle n'est pas conforme (`orchestrate.maquette`), sauf si une
 * acceptation conforme est déjà commitée (elle n'a pu être écrite qu'après la revue) ; puis les tests d'acceptation rouges (S5).
 */
function afterSpec(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  // Revue de la fiche back (L188) d'abord, puis celle de la maquette d'un lot mixte ; la même preuve (acceptation scellée, code déjà commité) dispense des deux.
  if (c.config.fiche && partsOf(c, fiche).back && !l.fiche?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'fiche';
  return afterFiche(c, fiche);
}

/** Étape qui suit une fiche relue : la revue UX de la maquette d'un lot à écran (S4), sinon `afterMaquette`. */
function afterFiche(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  if (l.screen && c.config.maquette && !l.maquette?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'maquette';
  return afterMaquette(c, fiche);
}

/** Étape qui suit une maquette relue (ou une fiche, pour un lot sans écran) : les tests d'acceptation rouges (S5) quand le projet déclare sa commande dédiée et qu'aucune acceptation conforme n'est déjà commitée, sinon l'implémentation. */
function afterMaquette(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  // Des constats de la revue de fiche attendent la revue de la maquette (lot mixte) : les deux partent ensemble à la seconde passe `spec`.
  if (l.ficheConstats?.length) return 'spec';
  if (!c.config.accept) {
    if (!l.warnings.includes(NO_ACCEPT)) l.warnings.push(NO_ACCEPT);
    return 'implement';
  }
  const json = lotAcceptation(c, fiche);
  if (acceptationProof(c, fiche)) {
    l.accept = { acceptation: json, rouge: redSha(wd(c), json) ?? '' };
    return 'implement';
  }
  return 'accept';
}

/** Le lot a déjà du code commité après sa fiche : l'implémentation n'a pu partir qu'une fois la maquette relue, la revue n'est pas rejouée (même sans `orchestrate.accept`). */
function codeAfterFiche(c: LotCtx, fiche: string): boolean {
  const l = c.lot;
  let sha: string;
  try {
    // Le point de départ est le commit qui a créé la fiche : un commit plus récent du dossier (capture corrigée) ne doit pas masquer le code commité avant lui.
    sha = git(wd(c), 'log', '--diff-filter=A', '--format=%H', '--', fiche).split('\n').filter(Boolean).pop() ?? git(wd(c), 'log', '-1', '--format=%H', '--', posix.dirname(fiche));
  } catch {
    return false;
  }
  if (!sha) return false;
  const dir = `${posix.dirname(fiche)}/`;
  const after = new Set(readCommits(wd(c), { range: `${sha}..HEAD` }).map((k) => k.sha));
  // Un commit de la session spec elle-même (fiche, maquette, captures) ou de la session accept (tests listés) n'est pas du code.
  const tests = new Set<string>();
  const json = lotAcceptation(c, fiche);
  if (listed(c, json)) {
    const doc = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
    if (typeof doc !== 'string') for (const f of doc.fichiers) tests.add(posix.normalize(f));
  }
  return lotWork(histPlan(c), wd(c), l.lot).some((k) => after.has(k.sha) && changedFiles(wd(c), k.sha).some((f) => !f.startsWith(dir) && !tests.has(f)));
}

/** L'acceptation du lot : celle que git suit déjà pour lui (même un ancien `acceptation.json`), sinon `acceptation-<lot>.json` à côté de la fiche. */
const lotAcceptation = (c: LotCtx, fiche: string): string => findAcceptation(wd(c), c.config.spec.dir, c.lot.lot) ?? acceptationFile(fiche, c.lot.lot);

const listed = (c: LotCtx, json: string): boolean => existsSync(join(wd(c), json));

/** Une acceptation porte-t-elle une empreinte par fichier listé ? Le contenu n'est pas comparé (L233) : `empreintes: {}` ou celles d'un autre fichier ne scellent rien. */
const hasSeals = (doc: Acceptation): boolean => !!doc.empreintes && doc.fichiers.every((f) => !!(doc.empreintes as Record<string, string>)[posix.normalize(f)]);

/**
 * Une acceptation conforme et SCELLÉE par le programme (empreintes posées), rouge ou verte (`vert: true`, lot relancé dans une nouvelle vague ; une verte et scellée vaut
 * preuve même si son scellé ne tient plus, L233) : elle n'a pu être écrite qu'après la revue de la maquette et les tests rouges, qui ne sont donc pas rejoués. Sans `orchestrate.accept`, aucune preuve.
 */
function acceptationProof(c: LotCtx, fiche: string): boolean {
  const l = c.lot;
  const json = lotAcceptation(c, fiche);
  if (!c.config.accept || !listed(c, json)) return false;
  const doc = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
  if (typeof doc === 'string') return false;
  // Un lot déjà vert (L233) n'a plus d'oracle à écrire : le cycle seul a pu poser `vert: true`, après le scellé et les tests rouges. Même une preuve qui ne tient plus
  // (test rescellé ou corrigé depuis, fiche amendée) ne renvoie jamais à accept, qui réécrirait un oracle vert et exigerait des tests rouges : le lot part à implement ou à la revue.
  // Une verte porte une empreinte par fichier listé, sinon elle n'a jamais été scellée (`empreintes: {}` ou celles d'un autre fichier ne prouvent rien).
  if (!hasSeals(doc)) return false;
  if (doc.vert) return true;
  // Le scellé n'est posé que par le programme : chaque fichier listé doit porter l'empreinte git de son contenu actuel (une clé `empreintes` vide ou copiée d'un autre lot ne prouve rien).
  const emp = doc.empreintes ?? {};
  const sealed = doc.fichiers.every((f) => {
    const norm = posix.normalize(f);
    return existsSync(join(wd(c), norm)) && emp[norm] === git(wd(c), 'hash-object', '--', norm).trim();
  });
  if (!sealed) return false;
  return checkAcceptation(wd(c), json, l.lot, fiche).length === 0;
}

/** Chemins salis par une session : suivis modifiés, nouveaux fichiers non suivis, et ceux des dépôts voisins. */
function dirtAfter(done: Done): string[] {
  return [...dirtBetween(done.before, done.after), ...done.others.flatMap((o) => dirtBetween(o.before, o.after).map((f) => `${o.repo.rel}: ${f}`))];
}

/** Chemins salis d'un dépôt entre deux relevés : suivis modifiés, et fichiers non suivis apparus. */
const dirtBetween = (before: Snapshot, after: Snapshot): string[] => [...trackedPaths(after), ...after.untracked.filter((f) => !before.untracked.includes(f))];

/** Suite commune des étapes spec et accept : commits de la session (avertis s'ils ne citent pas le lot), choix reportés, vraies questions (les non-questions deviennent un avertissement). */
function takeReport(c: LotCtx, done: Done, rep: { choix?: string[]; questions: string[] }): string[] {
  const l = c.lot;
  const commits: Commit[] = readCommits(wd(c), { range: done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined });
  done.step.commits = commits.map(short).reverse();
  for (const k of commits) if (!citedRefs(k, c.loadPlan().refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);
  for (const q of rep.questions) if (q.trim() && isNonQuestion(q)) l.warnings.push(`question ignorée (non-question) : « ${q.trim()} »`);
  return rep.questions.filter((q) => !isNonQuestion(q));
}

/**
 * La réponse du lead à une question sur des hypothèses coûteuses de la fiche (L297) : le programme passe lui-même ces règles en `sourcee`
 * (`réponse du lead, <date>, vague <id>`) et commite la fiche AVANT la session spec reprise, qui pourrait être perdue ou ne rien écrire — la fiche est alors
 * conforme quand la revue de fiche la lit. Une réponse qui supprime ou change la règle (`answerAltersRule`) n'en source aucune. Rend vrai quand le lot est rendu (fiche introuvable, commit refusé).
 */
function sourceAnsweredRules(c: LotCtx): boolean {
  const l = c.lot;
  if (!l.pendingAnswer || !l.specAsked?.length || !l.specAskedRules?.length) return false;
  if (answerAltersRule(l.pendingAnswer)) return false; // le lead corrige la règle : la session spec reprise l'applique, sinon la question lui revient (L302)
  const fiche = ficheOf(c);
  if (!fiche) return false; // la session spec reprise l'écrira : l'ancienne consigne s'applique
  try {
    const ids = sourceRules(wd(c), fiche, l.specAskedRules, `${LEAD_SOURCE}, ${c.wave.today}, vague ${c.wave.id}`);
    if (!ids.length) return false;
    git(wd(c), 'add', '--', fiche);
    git(wd(c), 'commit', '-q', '-m', `spec(${l.lot}): ${ids.join(', ')} ${ids.length > 1 ? 'sourcées' : 'sourcée'} par la réponse du lead (orchestrate ${c.wave.id})`, '--', fiche);
    return false;
  } catch (e) {
    stop(c, 'handed-back', `réponse du lead non reportée dans la fiche ${fiche} : ${(e as Error).message.split('\n')[0]}`);
    return true;
  }
}

/** Plafond de sessions `spec` du lot (L230) : les revues de maquette d'un lot à écran, sinon deux. Fiche et maquette partagent `l.specRuns`. */
const specBudget = (c: LotCtx): number => (c.lot.screen && c.config.maquette ? c.config.maquetteReviews : 2);

/**
 * Étape spec (L171, spec etape-spec S3) : la session écrit maquette, captures et fiche dans `<spec.dir>/<écran>/`, le programme
 * en relève les écarts (une seconde passe, puis le lot est rendu), une hypothèse coûteuse à défaire devient une question au lead,
 * et une sortie sous le seuil (le lot ne change aucun écran) rend le lot au chemin actuel.
 */
async function specStep(c: LotCtx): Promise<void> {
  const l = c.lot;
  if (sourceAnsweredRules(c)) return;
  const done = await session(c, 'spec');
  if (!done) return;
  l.specRuns = (l.specRuns ?? 0) + 1;
  let rep: SpecReport;
  try {
    rep = checkShape<SpecReport>(done.report, SPEC_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const questions = takeReport(c, done, rep);
  if (questions.length) {
    l.questions = questions;
    l.specRuns = undefined; // la réponse ouvre un nouveau budget de sessions
    l.specAsked = undefined; // la prochaine réponse porte sur la question de la session, pas sur d'anciennes hypothèses coûteuses
    l.specAskedRules = undefined;
    l.next = 'spec';
    transition(c, 'question', questions[0]);
    return;
  }
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après spec : ${dirt.join(', ')}`);
    return;
  }

  const reason = rep.sousSeuil.trim();
  if (reason) {
    l.spec = { sousSeuil: reason };
    l.specProblems = undefined;
    l.warnings.push(`étape spec : sous le seuil, ${l.screen ? 'aucune maquette' : 'aucune fiche'} — ${reason}`);
    l.next = 'implement';
    save(c);
    return;
  }

  // Le chemin du rapport est ramené relatif au dépôt (absolu, `./…` ou `a/../b` donneraient de faux écarts) ; hors du dépôt, c'est un écart.
  const reported = rep.fiche.trim();
  const asked = reported ? relative(wd(c), resolve(wd(c), reported)) : '';
  const outside = asked === '..' || asked.startsWith('../') || isAbsolute(asked);
  const fiche = outside ? '' : asked || findFiche(wd(c), c.config.spec.dir, l.lot) || '';
  const what = l.screen ? '<écran>' : '<sujet>';
  const inDir = fiche === '' || fiche.startsWith(`${c.config.spec.dir.replace(/\/+$/, '')}/`);
  const problems = !outside && fiche && !inDir ? [`${fiche} : fiche hors de ${c.config.spec.dir} (la spec vit dans ${c.config.spec.dir}/${what}/fiche.yaml, où l'étape la retrouve)`] : outside ? [`${reported} : fiche hors du dépôt (le chemin de « fiche » est relatif au dépôt : ${c.config.spec.dir}/${what}/fiche.yaml)`] : fiche ? checkSpec(wd(c), fiche, l.lot, partsOf(c, fiche)) : [`aucune fiche écrite : ${c.config.spec.dir}/${what}/fiche.yaml est attendue (ou une raison dans « sousSeuil » si le lot ne change ${l.screen ? 'aucun écran' : 'aucun comportement'})`];
  if (problems.length) {
    if ((l.specRuns ?? 0) >= specBudget(c)) {
      stop(c, 'handed-back', `spec non conforme après ${specBudget(c)} passes : ${problems.join(' ; ')}`);
      return;
    }
    l.specProblems = problems;
    l.next = 'spec';
    save(c);
    return;
  }
  l.specProblems = undefined; // les contrôles passent : les écarts de la passe précédente sont corrigés
  const doc = parse(readFileSync(join(wd(c), fiche), 'utf8')) as { regles?: { statut?: unknown }[]; sujet?: { id?: unknown } };
  // Un choix coûteux à défaire n'est pas une hypothèse : la question remonte au lead, la session reprend avec sa réponse.
  const costly = costlyHypotheses(doc);
  if (costly.length) {
    l.questions = costly.map((x) => `${x.id} est posée comme hypothèse mais touche un choix coûteux à défaire (${x.categorie}) : « ${x.siFaux} » — la confirmer, ou la corriger, avant que la fiche serve de référence.`);
    l.specAsked = [...l.questions];
    l.specAskedRules = costly.map((x) => x.id);
    l.specRuns = undefined; // la réponse du lead ouvre un nouveau budget de sessions, comme celle d'une question de la session
    l.next = 'spec';
    transition(c, 'question', l.questions[0]);
    return;
  }
  l.specAsked = undefined;
  l.specAskedRules = undefined;
  l.spec = { fiche, hypotheses: (doc.regles ?? []).filter((r) => r.statut === 'hypothese').length };
  l.specProblems = undefined;
  l.hypotheses = undefined; // la fiche vient d'être (ré)écrite : ses hypothèses se posent une fois la fiche relue, pas avant (settleHypotheses)
  // Les constats de la revue de fiche ont servi à cette passe : sans nouvelle revue de fiche derrière (partie back retirée, preuve d'acceptation), ils ne renvoient pas encore à la spec.
  const kept = l.ficheConstats;
  l.ficheConstats = undefined;
  l.next = afterSpec(c, fiche);
  if (l.next === 'fiche') l.ficheConstats = kept; // la seconde revue de fiche les relit
  save(c);
}

/**
 * Un lot sans écran n'a pas de Nouveauté : les hypothèses de sa fiche vont en notes du lot (une par règle) et au tableau de fin de vague (spec
 * etape-spec-back § 7). Elles se lisent sur la fiche FINALE, juste avant `accept` ou `implement` : après la revue de la fiche et sa seconde passe
 * (une hypothèse changée ou retirée en passe 2 ne laisse pas la note de la passe 1), et aussi pour une fiche déjà présente à la reprise.
 * Rend vrai quand le lot est rendu.
 */
async function settleHypotheses(c: LotCtx): Promise<boolean> {
  const l = c.lot;
  if (l.screen || !l.specLot || l.hypotheses !== undefined || (l.spec && !('fiche' in l.spec))) return false;
  const fiche = ficheOf(c);
  if (!fiche) return false;
  let doc: { sujet?: { id?: unknown } };
  try {
    doc = parse(readFileSync(join(wd(c), fiche), 'utf8')) as typeof doc;
  } catch {
    return false;
  }
  return noteHypotheses(c, hypothesisLines(doc), typeof doc.sujet?.id === 'string' ? doc.sujet.id : posix.basename(posix.dirname(fiche)));
}

/**
 * Pose en note du lot une ligne par hypothèse de la fiche (rien de plus que ce que la note dit déjà : une reprise ne duplique pas) et la commite avec le
 * plan. Un plan tenu par un autre outil (lecture seule) ne reçoit rien : la ligne devient une proposition rendue au lead. Rend vrai quand le lot est rendu.
 */
async function noteHypotheses(c: LotCtx, lines: string[], sujet: string): Promise<boolean> {
  const l = c.lot;
  l.hypotheses = lines;
  if (!lines.length) return false;
  const texts = lines.map((x) => hypothesisNote(sujet, x));
  const dirty = await planWrite(c, async () => {
    const plan = c.loadPlan();
    if (plan.readonly) {
      for (const t of texts) propose(c, `[note à poser] ${t}`);
      return null;
    }
    const have = new Set(plan.lot(l.lot).notes.map((n) => n.text));
    const fresh = texts.filter((t) => !have.has(t));
    if (!fresh.length) return null;
    for (const t of fresh) plan.note(l.lot, t, c.wave.today);
    plan.save();
    return commitPlan(c, `plan: ${l.lot} hypothèses de la fiche ${sujet} notées (orchestrate ${c.wave.id})`);
  });
  if (dirty) {
    handBackPlan(c, `${HYPOTHESES_HANDBACK}${dirty}`);
    return true;
  }
  return false;
}

/**
 * Les mineurs de la revue de la fiche vont en notes du lot (spec etape-spec-back § 4), pas au tableau de fin de vague : une note par constat, sans doublon
 * à la reprise, commitée avec le plan. Un plan en lecture seule ne reçoit rien : la ligne devient une proposition `[note à poser]` rendue au lead.
 * Rend vrai quand le lot est rendu (arbre sale).
 */
async function noteMinors(c: LotCtx, rep: ReviewReport, label: string): Promise<boolean> {
  const texts = rep.constats.filter((k) => k.gravite === 'mineur').map((k) => `Revue de ${label} — mineur : ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);
  if (!texts.length) return false;
  const dirty = await planWrite(c, async () => {
    const plan = c.loadPlan();
    if (plan.readonly) {
      for (const t of texts) propose(c, `[note à poser] ${t}`);
      return null;
    }
    const have = new Set(plan.lot(c.lot.lot).notes.map((n) => n.text));
    const fresh = [...new Set(texts)].filter((t) => !have.has(t));
    if (!fresh.length) return null;
    for (const t of fresh) plan.note(c.lot.lot, t, c.wave.today);
    plan.save();
    return commitPlan(c, `plan: ${c.lot.lot} mineurs de la revue de ${label} notés (orchestrate ${c.wave.id})`);
  });
  if (dirty) {
    handBackPlan(c, `${MINORS_HANDBACK}${label} : ${dirty}`);
    return true;
  }
  return false;
}

/** Ce qui distingue les deux revues de la spec : la fiche back relue par code-reviewer (L188), la maquette relue par ux-reviewer (L172). */
interface SpecReview {
  kind: 'fiche' | 'maquette';
  /** Nom de l'objet relu dans les messages (« la fiche », « la maquette »). */
  label: string;
  source: 'code' | 'ux';
  /** Étape suivante quand la relecture est conforme, ou quand la seconde passe `spec` doit d'abord avoir lieu (constats gardés). */
  after: (c: LotCtx, fiche: string) => SessionKind;
  /** Étape suivante quand des constats renvoient à la spec. */
  retry: (c: LotCtx, fiche: string) => SessionKind;
}

const FICHE_REVIEW: SpecReview = { kind: 'fiche', label: 'fiche', source: 'code', after: afterFiche, retry: afterFiche };
const MAQUETTE_REVIEW: SpecReview = { kind: 'maquette', label: 'maquette', source: 'ux', after: afterMaquette, retry: () => 'spec' };

/**
 * Revue de la spec (fiche ou maquette) : une session de lecture seule. Un bloquant ou un majeur renvoie à la spec (avec les constats ; pour un lot mixte, ceux des deux revues ensemble), puis la spec est relue : deux revues pour la fiche,
 * `orchestrate.maquetteReviews` pour la maquette, dans le plafond de sessions spec du lot (`specBudget`) ; ce qui reste à la dernière revue est rendu au lead.
 * Les mineurs de la fiche vont en notes du lot (ceux de la maquette restent des propositions). Ce verdict n'est pas `raf review` ni `raf ux` : la revue après code garde ce rôle.
 */
async function reviewSpecStep(c: LotCtx, r: SpecReview): Promise<void> {
  const l = c.lot;
  const fiche = ficheOf(c);
  if (!fiche) {
    l.warnings.push(`revue de la ${r.label} ignorée : aucune fiche trouvée pour ce lot`);
    l.next = 'implement';
    save(c);
    return;
  }
  const done = await session(c, r.kind);
  if (!done) return;
  let rep: ReviewReport;
  try {
    rep = checkShape<ReviewReport>(done.report, REVIEW_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const summary = summarize(rep, done.after.head ?? '');
  const passes = (l[r.kind]?.passes ?? 0) + 1;
  // Fiche : les mineurs sont des notes du lot (design § 4). Maquette : inchangé (propositions du tableau final).
  addProposals(c, rep, r.kind, r.kind !== 'fiche');
  // Un lot rendu sur le refus d'écrire ses notes (R26) rejoue cette revue à la reprise : le compte des passes n'est posé qu'une fois les notes écrites.
  if (r.kind === 'fiche' && (await noteMinors(c, rep, `la ${r.label}`))) return;
  l[r.kind] = { passes, conforme: summary.conforme, verdict: summary.verdict };
  const constats = blockingConstats(rep, r.source);
  if (r.kind === 'maquette' && passes >= 2) {
    // Lu sur rep.constats : blockingConstats ne garde pas `inchange`. Seul le booléen vrai est une marque (checkShape ne descend pas dans constats[]).
    for (const k of rep.constats) if ((k.gravite === 'bloquant' || k.gravite === 'majeur') && k.inchange === true) c.wave.log(`${lotKey(l.project, l.lot)} · défaut de revue : maquette, revue ${passes}, majeur sur un point inchangé absent de la revue ${passes - 1} : ${k.texte}`);
  }
  const key = r.kind === 'fiche' ? 'ficheConstats' : 'maquetteConstats';
  if (summary.conforme) {
    l[key] = undefined;
    l.next = r.after(c, fiche);
    save(c);
    return;
  }
  const reviews = r.kind === 'maquette' ? c.config.maquetteReviews : 2;
  if (passes >= reviews) {
    stop(c, 'handed-back', `${r.label} non conforme après ${reviews} revue${reviews > 1 ? 's' : ''} : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
    return;
  }
  // Le budget de sessions spec est épuisé (écarts du programme compris) : un renvoi à la spec serait une session de trop.
  if ((l.specRuns ?? 0) >= specBudget(c)) {
    stop(c, 'handed-back', `${r.label} non conforme et la spec a déjà joué ${specBudget(c)} sessions : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
    return;
  }
  l[key] = constats.length ? constats : [{ source: r.source, gravite: 'majeur', texte: summary.verdict }];
  l.next = r.retry(c, fiche);
  save(c);
}

const ficheStep = (c: LotCtx): Promise<void> => reviewSpecStep(c, FICHE_REVIEW);
const maquetteStep = (c: LotCtx): Promise<void> => reviewSpecStep(c, MAQUETTE_REVIEW);

/** Résultat d'une commande de `orchestrate.accept` lancée pour le lot. */
interface AcceptRun { command: string; code: number; output: string }

/**
 * Commandes dédiées aux tests d'acceptation du lot (une chaîne ou une liste, L189) : `{acceptation}` y est remplacé, `CADENCE_ACCEPTATION` (chemin absolu
 * dans les deux cas) et `CADENCE_ACCEPTATION_ROOT` (sa racine) posés. Une commande sans fichier listé sous sa racine n'est pas lancée ; les fichiers
 * listés sous aucune racine sont rendus (`orphans`) sans rien lancer.
 */
async function runAccept(c: LotCtx, json: string): Promise<{ runs: AcceptRun[]; orphans: string[] }> {
  const abs = join(wd(c), json);
  const doc = parseAcceptation(readFileSync(abs, 'utf8'));
  const plan = planAcceptRuns(acceptCommands(c.config.accept), typeof doc === 'string' ? [] : doc.fichiers, !isAcceptList(c.config.accept));
  if (plan.orphans.length) return { runs: [], orphans: plan.orphans };
  const runs: AcceptRun[] = [];
  for (const r of plan.runs) runs.push({ command: r.command, ...(await sh(c, r.command.replaceAll('{acceptation}', abs), 30 * 60_000, { CADENCE_ACCEPTATION: abs, CADENCE_ACCEPTATION_ROOT: r.root || '.' })) });
  return { runs, orphans: [] };
}

const tail = (output: string, n = 40): string => output.trim().split('\n').slice(-n).join('\n');

/** Écarts des tests d'acceptation écrits par la session (vide = acceptés) : autres lots intacts, acceptation.json conforme, tests rouges, config.test toujours verte. */
async function acceptProblems(c: LotCtx, fiche: string, json: string, headBefore: string | undefined): Promise<string[]> {
  const l = c.lot;
  const out = headBefore ? lockViolations(wd(c), c.config.spec.dir, headBefore, { skip: json }) : [];
  out.push(...checkAcceptation(wd(c), json, l.lot, fiche, l.steps.find((s) => s.kind === 'accept')?.headBefore));
  if (out.length) return out;
  const red = await runAccept(c, json);
  if (red.orphans.length) out.push(`fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept (le dossier de son « cd <dossier> && » initial, sinon le dépôt) : ${red.orphans.join(', ')} — aucun lanceur ne les prendrait`);
  for (const r of red.runs) if (r.code === 0) out.push(`la commande dédiée « ${r.command} » (orchestrate.accept) passe alors que le code n'existe pas : des tests verts avant le code ne prouvent rien — chaque test doit échouer parce que la fonctionnalité manque\n${tail(r.output, 15)}`);
  if (!c.config.test) {
    if (!l.warnings.includes(NO_TEST_ACCEPT)) l.warnings.push(NO_TEST_ACCEPT);
  } else {
    const ordinary = await sh(c, c.config.test);
    if (ordinary.code !== 0) out.push(`orchestrate.test échoue (code ${ordinary.code}) avec les tests rouges commités : les fichiers listés dans ${json} ne sont pas exclus de la config du lanceur (partagée avec la CI) tant que vert est false\n${tail(ordinary.output, 15)}`);
  }
  return out;
}

/**
 * Écart de l'acceptation verte et scellée `json` par rapport à ce qu'elle était à `first` (tête d'avant la première session accept du lot), ou null.
 * Admis : le même contenu, ou un rescellé du lead (`cadence spec reseal`, L200) : `vert` et `empreintes` toujours posés, journal `resceaux` allongé, aucun commit
 * du fichier dans une session de la vague, fichier propre. Tout le reste (vert: false, journal effacé, réécriture commitée par la session) est rendu au lead (L233).
 */
function greenDrift(c: LotCtx, json: string, first: string, before: string, was: Acceptation): string | null {
  const l = c.lot;
  if (!listed(c, json)) return 'acceptation.json supprimé depuis la première session accept (verrou des tests d\'acceptation)';
  const text = readFileSync(join(wd(c), json), 'utf8');
  // `before` vient de git() qui rogne les blancs de fin, le fichier écrit par le programme finit par un saut de ligne : les deux se comparent rognés.
  if (text.trim() === before.trim()) return null;
  const now = parseAcceptation(text);
  const dirty = git(wd(c), 'status', '--porcelain', '--', json).trim() !== '';
  let bySession = false;
  try {
    const mine = waveCommits(c, c.lot.repo);
    bySession = git(wd(c), 'log', '--format=%H', `${first}..HEAD`, '--', json).split('\n').some((sha) => sha && mine(sha));
  } catch {
    bySession = true;
  }
  const journal = (a: Acceptation): number => a.resceaux?.length ?? 0;
  if (typeof now !== 'string' && now.vert && now.empreintes && journal(now) > journal(was) && !bySession && !dirty) return null;
  return 'acceptation verte réécrite depuis la première session accept (vert, empreintes ou resceaux changés ; seul un rescellé du lead, `cadence spec reseal`, est admis) : remettre le fichier comme avant la session, par exemple `git checkout <commit vert> -- <fichier>` puis `--resume`';
}

/**
 * Étape accept (L173, spec etape-spec S5) : une session distincte de l'implémenteur écrit, depuis la fiche et la maquette seules, les tests
 * d'acceptation rouges. Le programme vérifie (acceptation.json conforme, autres lots intacts, commande dédiée rouge, config.test verte),
 * accorde une seconde passe, puis SCELLE le fichier (empreintes) dans un commit du cycle : c'est le commit rouge du verrou.
 */
async function acceptStep(c: LotCtx): Promise<void> {
  const l = c.lot;
  const fiche = ficheOf(c);
  if (!fiche || !c.config.accept) {
    l.next = 'implement';
    save(c);
    return;
  }
  const json = lotAcceptation(c, fiche);
  // Un lot déjà vert et scellé (L233) n'a plus d'oracle à écrire, même quand `next` vaut encore accept (question posée pendant accept, puis réponse du lead) : jamais de session accept.
  // Le fichier est lu tel qu'il était avant la première session accept du lot : la seconde passe voit le fichier écrit par la session, qui ne doit pas être vert (checkAcceptation).
  const first = l.steps.find((s) => s.kind === 'accept')?.headBefore;
  let text: string | null = null;
  try {
    text = first ? git(wd(c), 'show', `${first}:${json}`) : listed(c, json) ? readFileSync(join(wd(c), json), 'utf8') : null;
  } catch {
    text = null;
  }
  const doc = text === null ? null : parseAcceptation(text);
  if (doc && typeof doc !== 'string' && doc.vert && hasSeals(doc)) {
    // Le fichier actuel doit être celui de `first` : une session accept qui a réécrit puis commité l'oracle avant de poser sa question (le verrou ne s'applique pas à l'étape accept, `skip`)
    // ne se fait pas adopter comme nouveau commit rouge. Seul un rescellé du lead (journal `resceaux` allongé, commit hors de toute session, fichier propre) est une différence admise.
    const drift = first ? greenDrift(c, json, first, text as string, doc) : null;
    if (drift) {
      stop(c, 'handed-back', `verrou des tests d'acceptation : ${json} : ${drift}`);
      return;
    }
    l.accept = { acceptation: json, rouge: redSha(wd(c), json) ?? '' };
    l.next = 'implement';
    // Un lot en question n'a plus rien à demander : la réponse du lead (« ne réécris rien ») est prise en compte par ce choix, elle ne repart pas dans le brief d'implement.
    l.pendingAnswer = null;
    transition(c, 'implementing', 'acceptation déjà verte : accept ignoré');
    return;
  }
  const done = await session(c, 'accept');
  if (!done) return;
  let rep: AcceptReport;
  try {
    rep = checkShape<AcceptReport>(done.report, ACCEPT_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const questions = takeReport(c, done, rep);
  if (questions.length) {
    l.questions = questions;
    l.next = 'accept';
    transition(c, 'question', questions[0]);
    return;
  }
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après accept : ${dirt.join(', ')}`);
    return;
  }
  const problems = await acceptProblems(c, fiche, json, done.step.headBefore);
  if (problems.length) {
    if (l.acceptProblems) {
      stop(c, 'handed-back', `accept non conforme après 2 passes : ${problems.join(' ; ')}`);
      return;
    }
    l.acceptProblems = problems;
    l.next = 'accept';
    save(c);
    return;
  }
  l.acceptProblems = undefined;
  sealAcceptation(wd(c), json);
  const dirty = await commitPlan(c, `test(${l.lot}): acceptation scellée, empreintes des tests rouges (orchestrate ${c.wave.id})`, wd(c));
  if (dirty) {
    stop(c, 'handed-back', `scellé de ${json} : ${dirty}`);
    return;
  }
  l.accept = { acceptation: json, rouge: git(wd(c), 'rev-parse', 'HEAD') };
  l.next = 'implement';
  save(c);
}

/**
 * Retour au vert (S5) : à la fin de chaque implement/fix, quand la commande dédiée passe, le CYCLE (jamais une session) pose `vert: true`
 * dans l'acceptation.json du lot et le commite ; les fichiers rejoignent alors config.test et la CI. Rend un constat quand elle échoue.
 */
async function acceptGreen(c: LotCtx): Promise<Constat | null> {
  const l = c.lot;
  if (!c.config.accept) return null;
  const json = l.accept?.acceptation ?? findAcceptation(wd(c), c.config.spec.dir, l.lot);
  if (!json || !existsSync(join(wd(c), json))) return null;
  const a = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
  if (typeof a === 'string' || a.vert) return null;
  const { runs, orphans } = await runAccept(c, json);
  if (orphans.length) return { source: 'tests', gravite: 'bloquant', texte: `fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept : ${orphans.join(', ')}` };
  const failed = runs.filter((r) => r.code !== 0);
  if (failed.length) return { source: 'tests', gravite: 'bloquant', texte: `tests d'acceptation encore rouges (${failed.map((r) => `${r.command}, code ${r.code}`).join(' ; ')}) : à rendre verts sans modifier les fichiers listés dans ${json} :\n${failed.map((r) => (failed.length > 1 ? `$ ${r.command}\n` : '') + tail(r.output)).join('\n')}` };
  setVert(wd(c), json);
  const dirty = await commitPlan(c, `chore(${l.lot}): acceptation verte, vert: true posé par le cycle (orchestrate ${c.wave.id})`, wd(c));
  if (dirty) return { source: 'tests', gravite: 'bloquant', texte: `vert: true de ${json} : ${dirty}` };
  return null;
}

/** Un contrôle lancé par le programme : sa commande, son code, et les tests rouges qui l'étaient déjà au sha de départ (L213). */
type CheckRun = NonNullable<LotState['checks']>['runs'][number];

/**
 * Les contrôles du programme (`orchestrate.build` puis `orchestrate.test`, L333 : les tests e2e lisent le `dist` que seul le build produit), joués dans `wd(c)` : chaque résultat est ajouté à `runs`, chaque rouge NOUVEAU à `red`
 * (un test déjà rouge au sha de départ n'en est pas un, L213). S'arrête au premier rouge : un build rouge rend le lot sans lancer les tests. Après une écriture (work) et, au sommet rebasé, avant l'avance de la branche du dépôt (R7).
 */
async function programChecks(c: LotCtx, red: Constat[], runs: CheckRun[]): Promise<void> {
  const l = c.lot;
  for (const [label, command] of [['build', c.config.build], ['tests', c.config.test]] as const) {
    if (!command) continue;
    const r = await sh(c, command);
    const run: CheckRun = { label, command, code: r.code };
    runs.push(run);
    if (r.code === 0) continue;
    const vs: VsBase = label === 'tests' ? await againstBaseline(c, command, r.output) : { kind: 'unknown' };
    if (vs.kind === 'existing') {
      run.dejaRouges = vs.n;
      const note = `${vs.n} test(s) déjà rouge(s) au sha de départ ${(l.baseline?.sha ?? '').slice(0, 7)}, pas un défaut du lot : listés à part, la revue a lieu`;
      if (!l.warnings.includes(note)) l.warnings.push(note);
      continue;
    }
    // Un rouge absent de la ligne de base est rejoué SEUL avant d'être compté (L350) : sous charge, des tests qui passent seuls rougissent ensemble.
    const named = vs.kind === 'new' ? vs.nouveaux : label === 'tests' && !hasUnnamedFailure(r.output) ? failedTests(r.output) : [];
    const { red: still, unstable } = named.length ? await replayAlone(c, command, named) : { red: [] as string[], unstable: [] as string[] };
    if (unstable.length) noteUnstable(c, unstable);
    if (unstable.length && !still.length) {
      run.instables = unstable;
      if (vs.kind === 'new' && vs.existants) run.dejaRouges = vs.existants;
      else run.code = 0;
      continue;
    }
    const alone = unstable.length ? `\n(${unstable.length} test(s) rouge(s) sous charge, verts rejoués seuls : instables, à ne pas corriger)` : '';
    if (vs.kind === 'new') {
      const left = vs.nouveaux.filter((t) => !unstable.includes(t));
      red.push({ source: 'tests', gravite: 'bloquant', texte: `${command} en échec (code ${r.code}) : ${left.length} test(s) rouge(s) qui ne l'étaient pas au sha de départ :\n${left.map((t) => `- ${t}`).join('\n')}${vs.existants ? `\n(${vs.existants} autre(s) test(s) déjà rouge(s) au sha de départ : à ne pas corriger)` : ''}${alone}` });
      return;
    }
    // Des instables sont écartés : la sortie de la suite entière les montre encore en FAIL, le constat ne nomme que ceux qui restent rouges.
    const shown = unstable.length ? `${still.length} test(s) rouge(s) après rejeu seul :\n${still.map((t) => `- ${t}`).join('\n')}` : r.output.trim().split('\n').slice(-40).join('\n');
    red.push({ source: 'tests', gravite: 'bloquant', texte: `${command} en échec (code ${r.code}) :\n${shown}${alone}` });
    return;
  }
}

/** Sortie d'un lanceur qui n'a trouvé aucun test à rejouer : la ligne de fin du lanceur (vitest « No test files found, exiting with code », jest « No tests found, exiting with code », pytest « no tests ran in »), en début de ligne — pas ces mots cités dans le titre ou la sortie d'un test. */
const NO_TEST_RAN = /^\W*(?:no test files? found, exiting with code|no tests? found, exiting with code|no tests ran in)\b/im;

/** Rejeux d'un test rouge de la porte, seul (L350) : rouge aux deux, il est compté. */
const REPLAYS = 2;

/**
 * Rejoue SEULS (la commande de la porte, suivie des fichiers de ces tests, dans `cwd` : le worktree du lot, ou celui de la ligne de base) les tests rouges d'une suite entière (L350). Le 26-10, vitest à 31 workers par suite sur une machine à 4 sessions rougissait des tests
 * qui passaient seuls : quatre corrections vides (4 à 11 min chacune). Un test vert à un rejeu est `unstable` ; rouge aux `REPLAYS` rejeux, ou sans fichier désignable (rien à rejouer seul), il reste dans `red`.
 */
async function replayAlone(c: LotCtx, command: string, names: string[], cwd = wd(c)): Promise<{ red: string[]; unstable: string[] }> {
  let red = names;
  const unstable: string[] = [];
  for (let i = 0; i < REPLAYS; i++) {
    const files = [...new Set(red.map((n) => replayFile(n)).filter((f): f is string => f !== null))];
    if (!files.length) break;
    const replayable = red.filter((n) => replayFile(n) || isJestTest(n));
    const r = await sh(c, `${command} ${files.map(shellArg).join(' ')}`, undefined, undefined, cwd);
    // Seul un rejeu qui sort en 0 en ayant exécuté des tests vaut vert. Un rejeu en échec ne conclut rien pour un test qu'il ne nomme pas : sur une porte composée (`a && b`) les fichiers n'atteignent que le dernier lanceur, un premier lanceur qui rougit coupe avant lui. Un rejeu sans test exécuté (filtre sans fichier, `passWithNoTests`) sort en 0 sans rien prouver.
    const failing = r.code === 0 && !NO_TEST_RAN.test(r.output) ? [] : replayable;
    const passed = replayable.filter((n) => !failing.includes(n));
    unstable.push(...passed);
    red = red.filter((n) => !passed.includes(n));
  }
  return { red, unstable };
}

/** Trace des tests instables sous charge (L350) : le lot (`instables`, journal et `cadence perf`), un avertissement du lot (tableau de fin de vague) et une ligne du journal de la vague. */
function noteUnstable(c: LotCtx, tests: string[]): void {
  const l = c.lot;
  const fresh = tests.filter((t) => !(l.instables ?? []).includes(t));
  if (!fresh.length) return;
  l.instables = [...(l.instables ?? []), ...fresh];
  const text = `${fresh.length} test(s) instable(s) sous charge (rouge(s) dans la suite, vert(s) rejoué(s) seul(s)), pas de passe de correction : ${fresh.join(' ; ')}`;
  l.warnings.push(text);
  c.wave.log(`${lotKey(l.project, l.lot)} · ${text}`);
  save(c);
}

/**
 * Contrôles du sommet intégré (L328) : un rouge est relancé une fois avant de rendre le lot. Le 25-10, L326 a été rendu pour un rouge de charge (L325 tournait en même
 * temps) alors que le même sommet rejoué seul était vert. Rouge deux fois = rendu, avec le résultat de la seconde passe ; vert à la relance = une alerte sur le lot et une ligne du journal.
 */
async function integratedChecks(c: LotCtx, key: string): Promise<{ red: Constat[]; runs: CheckRun[] }> {
  const first: Constat[] = [];
  let runs: CheckRun[] = [];
  await programChecks(c, first, runs);
  if (!first.length) return { red: first, runs };
  c.wave.log(`${key} tests rouges au sommet intégré, relancés une fois (${first.map(redExcerpt).join(' ; ')})`);
  const red: Constat[] = [];
  runs = [];
  await programChecks(c, red, runs);
  if (!red.length) c.lot.warnings.push(`rouge au sommet intégré, vert à la relance (charge de la machine ?) : ${first.map(redExcerpt).join(' ; ')}`);
  return { red, runs };
}

const EXCERPT_LINES = 10;

/**
 * Le constat rouge d'un contrôle, en une ligne pour le motif d'un refus (L328) : la commande, puis les tests rouges nommés quand le constat les liste (« - nom »),
 * sinon la fin de la sortie. La première ligne seule laissait « npx vitest run en échec (code 1) : » sans un nom de test.
 */
export function redExcerpt(k: Constat): string {
  const [head, ...rest] = k.texte.split('\n');
  const lines = rest.map((x) => x.trim()).filter(Boolean);
  const named = lines.filter((x) => x.startsWith('- '));
  const shown = named.length ? named.slice(0, EXCERPT_LINES) : lines.slice(-EXCERPT_LINES);
  const more = named.length > EXCERPT_LINES ? [`… (+${named.length - EXCERPT_LINES})`] : [];
  return [head.replace(/\s*:$/, ''), ...shown, ...more].join(' ; ');
}

/** Étape d'écriture (implémentation, correction) : contrôles, puis étape suivante décidée. */
async function work(c: LotCtx, kind: 'implement' | 'fix'): Promise<void> {
  const l = c.lot;
  const minorsPass = kind === 'fix' && l.minorFix === true;
  const docsPass = kind === 'fix' && l.docsFix === true;
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
  // Le lot proposé du bibliothécaire (L306, document hors dépôt) est dans son resume : il devient une proposition du lot, donc une ligne du tableau de fin de vague.
  if (docsPass && /^lot propos/i.test(rep.resume.trim())) propose(c, rep.resume.trim());
  // L'écriture a changé le code (L221) : le verdict et les constats de la revue UX d'avant ne valent plus, l'UX est rejouée après la prochaine revue de code conforme.
  if (!l.small) {
    l.ux = undefined;
    l.uxVerdict = null;
    l.constats = l.constats.filter((k) => k.source !== 'ux');
  }
  const plan = histPlan(c);
  const range = done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined;
  const commits: Commit[] = readCommits(wd(c), { range });
  // Commits de la session dans chaque dépôt voisin (L62) : de la tête d'avant la session à la tête d'après.
  const theirs = done.others.map((o) => ({ repo: o.repo, commits: o.before.head ? readCommits(o.repo.path, { range: `${o.before.head}..HEAD` }) : [] }));
  const made = commits.length + theirs.reduce((n, t) => n + t.commits.length, 0);
  done.step.commits = [...commits.map(short).reverse(), ...theirs.flatMap((t) => t.commits.map((k) => `[${t.repo.rel}] ${short(k)}`).reverse())];
  // La liste de git fait foi ; l'écart avec celle du rapport est signalé.
  const real = new Set([...commits, ...theirs.flatMap((t) => t.commits)].map((k) => k.sha));
  for (const a of rep.commits) {
    if ([...real].some((s) => s.startsWith(a.sha) || a.sha.startsWith(s.slice(0, 7)))) continue;
    // Reprise : le rapport cite aussi les commits d'une session précédente du lot, hors de la plage de celle-ci.
    const full = /^[0-9a-f]{4,40}$/i.test(a.sha) ? resolveCommit(wd(c), a.sha) : null;
    if (full && lotCommits(plan, wd(c), l.lot).some((k) => k.sha === full)) continue;
    l.warnings.push(full ? `commit annoncé n'appartient pas à ${l.lot} : ${a.sha} ${a.sujet}` : `commit annoncé absent de git : ${a.sha} ${a.sujet}`);
  }
  for (const k of commits) {
    if (isPlanOnly(k.sha, plan, wd(c))) continue;
    if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  }
  for (const t of theirs) {
    for (const k of t.commits) if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} dans ${t.repo.rel} : ${short(k)}`);
  }
  save(c);

  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);

  // Verrou des tests d'acceptation (L173) : ceux de TOUS les lots du dépôt, pas seulement du lot courant ; une modification est une question au lead. Contrôlé à CHAQUE fin de session, une question comprise (L200) :
  // une session qui remplace un test scellé puis pose une question ne passe pas par la reprise du lead pour se faire adopter.
  const locked = done.step.headBefore ? lockViolations(wd(c), c.config.spec.dir, done.step.headBefore, { rouge: l.accept?.rouge ? { [l.accept.acceptation]: l.accept.rouge } : {}, lot: l.lot, lotBase: l.steps.find((s) => s.headBefore)?.headBefore, lotStart: lotStartHead(wd(c), lotWork(histPlan(c), wd(c), l.lot).map((k) => k.sha)), lotCommits: lotCommits(histPlan(c), wd(c), l.lot).map((k) => k.sha) }) : [];
  if (locked.length) {
    stop(c, 'handed-back', `verrou des tests d'acceptation : ${locked.join(' ; ')}`);
    return;
  }
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
  l.docsFix = false; // la passe du bibliothécaire est jouée (une question la garde : la reprise rejoue son brief) : la suite se décide sur son rapport
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après ${kind} : ${dirt.join(', ')}`);
    return;
  }
  // Reprise : une session précédente de l'étape (correction ordinaire ou passe des mineurs) a pu commiter avant d'être coupée ; la revue d'origine ne vaut alors plus.
  // Référence : le HEAD de départ de la première session coupée de la série qui précède celle-ci (pas la revue, qui peut ne pas exister encore).
  let interruptedAt: string | undefined;
  for (const s of l.steps.slice(0, -1).reverse()) {
    if (s.kind !== 'fix' || s.status !== 'interrupted') break;
    interruptedAt = s.headBefore;
  }
  const headMoved = kind === 'fix' && made === 0 && !!interruptedAt && git(wd(c), 'rev-parse', 'HEAD') !== interruptedAt;
  if (minorsPass && made === 0 && !headMoved) {
    // Rien à corriger (mineurs jugés faux, listés en « choix ») : la revue conforme d'origine vaut, HEAD n'a pas bougé.
    for (const k of l.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine('code', k));
    l.constats = [];
    l.warnings.push('passe des mineurs sans commit : le lot conclut sur la revue conforme d\'origine, mineurs rendus en propositions');
    if (l.code && uxAfterReview(c)) {
      // L221 : l'UX finale suit la dernière revue de code conforme, y compris quand la passe des mineurs n'a rien commité.
      l.next = 'ux';
      save(c);
    } else if (l.code) await conclude(c, l.code, ' sans commit');
    else stop(c, 'handed-back', 'passe des mineurs sans commit, mais aucune revue conforme gardée');
    return;
  }
  // La session peut n'avoir plus rien à commiter (réponse du lead, lot commité avant la vague) : le travail du lot est déjà dans git.
  // Même règle côté fix (L56) : la passe n'avait rien à ajouter, le lot a déjà ses commits de travail → revue neuve ; la passe reste consommée, MAX_PASSES borne la boucle.
  const alreadyDone = hasWork(plan, wd(c), l);
  if (made === 0 && !alreadyDone && !headMoved) {
    stop(c, 'handed-back', `${kind} sans commit`);
    return;
  }
  // L317 : la passe du bibliothécaire qui laisse l'écart ouvert (rien commité, ou autre chose que la documentation) ne passe pas à la revue : le lot ne finirait pas prêt, `raf check` resterait rouge.
  if (docsPass) {
    const open = openDocGap(c);
    if (open) {
      stop(c, 'handed-back', open);
      return;
    }
  }
  if (headMoved) l.warnings.push(`${minorsPass ? 'passe des mineurs' : 'correction'} reprise sans nouveau commit : un commit d'une session précédente est relu par la revue`);
  else if (made === 0) l.warnings.push(kind === 'fix' ? 'fix sans nouveau commit : revue lancée sur les commits du lot' : `${kind} sans nouveau commit : revue lancée sur les commits déjà faits du lot`);

  const red: Constat[] = [];
  // Tests annoncés rouges (L213) : avec orchestrate.test, le programme rejoue et compare à la ligne de base, la session n'est crue que si les tests y sont rouges autrement que par des échecs de départ ; sans, la liste des échecs de base de la session, non vérifiée.
  const claimed: Constat = { source: 'tests', gravite: 'bloquant', texte: `tests annoncés rouges par la session : ${rep.tests.commande} — ${rep.tests.resultat}` };
  let deferred = false;
  const declared = (rep.echecsDeBase ?? []).map((t) => t.trim()).filter(Boolean);
  const newFailures = rep.nouveauxEchecs?.map((t) => t.trim()).filter(Boolean);
  if (!c.config.test && declared.length) {
    l.baseline = { sha: startSha(c) ?? '', failures: declared, verified: false };
    l.warnings.push(`échecs déjà présents au sha de départ selon la session (${declared.length}) : non vérifié par le programme (orchestrate.test absent)`);
  }
  if (!rep.tests.vert) {
    if (c.config.test) deferred = true;
    // Sans orchestrate.test (L215) : champ structuré, pas de lecture de la prose. vert:false + echecsDeBase + nouveauxEchecs présent et vide → pas de correction (non vérifié, signalé à la revue) ; nouveauxEchecs non vide → correction.
    else if (declared.length && newFailures && !newFailures.length) l.warnings.push(`tests annoncés rouges par la session, aucun nouvel échec déclaré (nouveauxEchecs vide) : les échecs sont ceux de la base qu'elle déclare (${declared.length}) ; pas de correction, non vérifié par le programme (orchestrate.test absent)`);
    else if (newFailures?.length) red.push({ ...claimed, texte: `${claimed.texte} — nouveaux échecs déclarés par la session : ${newFailures.join(' ; ')}` });
    else red.push(claimed);
  }
  if (rep.tests.vert && !c.config.test && newFailures?.length) l.warnings.push(`rapport incohérent : tests annoncés verts mais nouveaux échecs déclarés (${newFailures.join(' ; ')}) ; pas de correction, non vérifié par le programme (orchestrate.test absent)`);
  if (!rep.build.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `build annoncé rouge par la session : ${rep.build.commande} — ${rep.build.resultat}` });
  const runs: CheckRun[] = [];
  if (red.length === 0) {
    const green = await acceptGreen(c);
    if (green) red.push(green);
  }
  if (red.length === 0) await programChecks(c, red, runs);
  // La session annonçait des tests rouges et le programme ne les voit pas rouges au départ : l'annonce vaut.
  if (deferred && red.length === 0 && !runs.some((r) => r.label === 'tests' && r.dejaRouges)) red.push(claimed);
  if (red.length) {
    toFix(c, red, 'tests rouges');
    return;
  }
  // Porte « code modifié sans test » (L287) : le diff du lot (son dépôt et ses voisins, fichiers supprimés exclus), toutes sessions comprises, touche du code sans fichier de test → correction directe, sans session de revue. Une seule fois par lot, jamais pendant la passe des mineurs, ni quand la correction prendrait la dernière passe (la revue n'en aurait plus), ni quand le budget du lot ne paie plus la correction (la revue, elle, part toujours).
  const gate = c.config.testGate;
  if (gate && !l.testGate && !minorsPass) {
    // Le diff du lot : son dépôt et ses dépôts voisins (comme hasWork), sans les fichiers que le lot supprime (du code mort supprimé n'a pas de test à écrire).
    const touched = new Set([
      ...filesOf(wd(c), lotWork(plan, wd(c), l.lot), { withoutDeleted: true }),
      ...(l.repos ?? []).flatMap((r) => [...filesOf(r.path, repoWork(plan, r, l.lot), { withoutDeleted: true })]),
    ]);
    const missing = testGateMissing(gate, touched);
    if (missing.length) {
      l.testGate = true;
      if (l.pass >= MAX_PASSES - 1) l.warnings.push(`porte « code sans test » non jouée : ${l.pass} passe(s) de correction déjà faite(s), la correction prendrait la dernière et la revue arriverait sans passe pour ses majeurs (${missing.join(', ')})`);
      else if (!fixAffordable(l)) l.warnings.push(`porte « code sans test » non jouée : budget du lot (${budgetCount(l)}), il ne reste pas de quoi payer la correction et la revue qui la suit (${missing.join(', ')})`);
      else {
        toFix(c, [{ source: 'code', gravite: 'majeur', fichier: missing[0], texte: `code modifié sans test (orchestrate.testGate, vérifié par le programme) : ${missing.join(', ')} — aucun fichier de test touché par les commits du lot. Écris les tests de chaque règle modifiée, nommés d'après la règle (test d'abord), puis commite avec le lot cité.` }], 'code sans test');
        return;
      }
    }
  }
  // Bibliothécaire (L306) : docs.sync signale un document en retard sur les commits du lot → une passe doc-keeper avant la revue, une seule fois par lot, aux mêmes conditions de passe et de budget que la porte ci-dessus. Si elle ne touche pas le document, la revue part et porte l'écart (brief docs.sync, constat majeur).
  if (!l.docsGate && !minorsPass) {
    const { gaps } = docGaps(c);
    if (gaps.length) {
      l.docsGate = true;
      const late = gaps.flatMap((g) => g.touched).join(', ');
      if (l.pass >= MAX_PASSES - 1) l.warnings.push(`bibliothécaire non appelé : ${l.pass} passe(s) de correction déjà faite(s), sa passe prendrait la dernière et la revue arriverait sans passe pour ses majeurs (${late})`);
      else if (!fixAffordable(l)) l.warnings.push(`bibliothécaire non appelé : budget du lot (${budgetCount(l)}), il ne reste pas de quoi payer sa passe et la revue qui la suit (${late})`);
      else {
        l.docsFix = true;
        toFix(c, gaps.map((g) => ({ source: 'code', gravite: 'majeur', fichier: g.touched[0], texte: gapMessage(l.lot, g) })), 'documentation en retard');
        return;
      }
    }
  }
  l.constats = [];
  l.checks = runs.length ? { head: git(wd(c), 'rev-parse', 'HEAD'), runs } : undefined;
  l.next = firstReview(c);
  save(c);
}

/** Mention « sans commit » du verdict quand la passe des mineurs n'a rien commité (l'UX finale conclut alors à la place de la passe). */
const noCommitNote = (l: LotState): string => (l.warnings.some((w) => w.startsWith('passe des mineurs sans commit')) ? ' sans commit' : '');

/** Revue de code qui clôt le cycle : complète, ou courte une fois la passe des mineurs jouée. */
const codeReview = (l: LotState): SessionKind => (l.minorPass ? 'review-small' : 'review');

/**
 * Première étape après un travail d'écriture (L221) : la revue de code, jamais l'UX. La revue UX d'un lot visible est jouée une seule fois,
 * après la dernière revue de code conforme (`uxAfterReview`), sur le code qui sera livré.
 */
function firstReview(c: LotCtx): SessionKind {
  const l = c.lot;
  if (l.small) return l.visible || l.minorPass ? 'review-small' : 'review'; // passe unique code + ergonomie ; sans écran, une revue de code
  if (l.visible && !c.config.ux) l.uxNote = 'UX à faire par le lead (aucune application déclarée : cadence.yaml orchestrate.ux)';
  return codeReview(l);
}

/** La revue de code conforme d'un lot visible non petit est-elle suivie de la revue UX ? Sans `orchestrate.ux`, le lot conclut (note « UX à faire par le lead »). */
const uxAfterReview = (c: LotCtx): boolean => !c.lot.small && c.lot.visible && !!c.config.ux;

/** Une passe de correction de plus, ou la main rendue au lead quand les deux sont faites. */
function toFix(c: LotCtx, constats: Constat[], what: string): void {
  const l = c.lot;
  l.constats = constats;
  // Revue qui converge (L205) : un seul constat bloquant ou majeur reste, après une baisse d'une revue à l'autre → une passe de plus (budget : fixAffordable, à l'entrée de la session).
  const counts = l.reviewCounts ?? [];
  const converging = what === 'revue non conforme' && counts.length >= 2 && counts[counts.length - 1] === 1 && counts[counts.length - 1] < counts[counts.length - 2];
  const cap = converging ? MAX_PASSES_CONVERGING : MAX_PASSES;
  if (l.pass >= cap) {
    const text = `${what} après ${l.pass} passe(s) de correction`;
    const esc = c.config.escalation;
    // Escalade (L337) : une seule fois, pour une revue de code non conforme ou des tests rouges (l'UX garde sa règle) ; déjà engagée, le lot est rendu.
    if (l.escalation) {
      if (!l.escalation.issue) {
        l.escalation.issue = 'rendu';
        c.wave.log(`${lotKey(l.project, l.lot)} · escalade ${l.escalation.model} : lot rendu malgré l'escalade`);
      }
      stop(c, 'handed-back', `${text} ; ${l.escalation.issue === 'conforme' ? `escalade ${l.escalation.model} déjà jouée` : `rendu malgré l'escalade ${l.escalation.model}`}`);
      return;
    }
    if (!esc || (what !== 'revue non conforme' && what !== 'tests rouges')) {
      stop(c, 'handed-back', text);
      return;
    }
    if (!fixAffordable(l, true)) {
      l.escalation = { model: esc.model, stage: 'done', issue: 'non jouée' };
      c.wave.log(`${lotKey(l.project, l.lot)} · escalade ${esc.model} non jouée : budget du lot (${lotSpent(l)} / ${l.budget} tokens comptés)`);
      stop(c, 'handed-back', `${text} ; escalade ${esc.model} non jouée (budget du lot : ${lotSpent(l)} / ${l.budget} tokens comptés, il ne reste pas de quoi payer la correction et la revue)`);
      return;
    }
    l.escalation = { model: esc.model, stage: 'fix' };
    c.wave.log(`${lotKey(l.project, l.lot)} · escalade ${esc.model} : ${what} après ${l.pass} passe(s), une correction puis une revue neuve`);
  }
  l.pass += 1;
  l.next = 'fix';
  save(c);
}

/** Les deux étapes qui voient l'application : la revue UX, et la passe unique d'un petit lot visible. */
const seesApp = (l: LotState, kind: SessionKind) => kind === 'ux' || (kind === 'review-small' && l.small && l.visible);

const appNote = (state: AppState, ux: { url?: string }): string =>
  state.kind === 'busy' ? `UX non vérifiée : port occupé (${ux.url} répond déjà, l'application n'a pas été lancée)` : state.kind === 'unverified' ? `UX non vérifiée : ${state.cause}` : '';

/**
 * Avec `command` ET `url`, le programme lance l'application avant l'étape et la tue après (succès, erreur ou signal) :
 * port occupé ou application muette, la revue UX n'a pas lieu (étape `skipped`, note dans le lot) et le lot conclut
 * sur la dernière revue de code conforme (R6) ; la passe unique d'un petit lot, elle, a lieu sur le code seul.
 */
async function review(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<void> {
  const l = c.lot;
  const ux = c.config.ux;
  // Un état repris, écrit avant L221, peut porter next = ux : l'UX ne part que sur une revue de code conforme du HEAD courant, sinon la revue de code passe d'abord (R9).
  if (kind === 'ux' && !(l.code?.conforme && l.code.head === git(wd(c), 'rev-parse', 'HEAD'))) {
    l.next = codeReview(l);
    if (l.status === 'suspended') l.status = 'reviewing'; // reprise d'un lot suspendu : la boucle de runLot enchaîne sur la revue de code au lieu de rendre la main
    save(c);
    return;
  }
  if (!ux?.command || !ux.url || !seesApp(l, kind)) return (await reviewStep(c, kind))?.();
  // Une seule application à la fois dans le dépôt (L279, R16) : l'étape qui la lance attend celle d'un autre lot du dépôt, sans retenir de créneau de session ; les autres étapes ne passent pas ici.
  const appTurn = (await mutexFor(`app:${gitCommonDir(c.lot.repo)}`).acquire())!;
  const halt = halted(c.wave, l);
  if (halt) {
    appTurn();
    suspend(c, halt); // la session n'aurait pas lieu : l'application ne se lance pas pour rien
    return;
  }
  let skipped = false;
  let conclusion: Conclusion | undefined;
  c.wave.log(`${lotKey(l.project, l.lot)} · lancement de l'application (${ux.url})`);
  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    app = await startApp({ command: ux.command, url: ux.url, cwd: wd(c), nodeBin: l.node?.link, log: join(c.wave.store.lotDir(l.project, l.lot), 'ux-app.log'), timeoutMs: (ux.timeout ?? APP_TIMEOUT_S) * 1000 });
  } catch (e) {
    appTurn();
    throw e;
  }
  try {
    c.app = app.state;
    if (app.state.kind !== 'ready') {
      l.uxNote = appNote(app.state, ux);
      c.wave.log(`${lotKey(l.project, l.lot)} · ${l.uxNote.split('\n')[0]}`);
      if (kind === 'ux') {
        skipped = true; // aucune session : la revue de code conforme suffit, le lot conclut avec la note
        return;
      }
    } else if (l.uxNote?.startsWith('UX non vérifiée')) l.uxNote = undefined;
    conclusion = await reviewStep(c, kind);
  } finally {
    c.app = undefined;
    await app.stop();
    appTurn();
    // La conclusion (l'intégration d'un lot en worktree : verrou, rebase, tests rejoués) vient une fois l'application arrêtée et son tour rendu.
    if (skipped && l.code) await conclude(c, l.code, noCommitNote(l));
  }
  await conclusion?.();
}

/** Ce qu'une étape de revue laisse à faire une fois l'application arrêtée : conclure le lot. */
type Conclusion = () => Promise<void>;

async function reviewStep(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<Conclusion | undefined> {
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
    save(c);
    // L'UX est la dernière étape (L221) : conforme, le lot conclut avec la revue de code ; sinon une correction (jamais une revue de code d'office), la revue de code et l'UX rejouée suivent.
    if (summary.conforme) return () => conclude(c, l.code!, noCommitNote(l));
    toFix(c, l.constats, 'UX non conforme');
    return;
  }
  l.code = summary;
  const w = c.wave;
  if (l.escalation?.stage === 'fix') {
    // La revue neuve de l'escalade (L337) est lue : conforme, le lot reprend sa fin ordinaire ; sinon toFix le rend.
    l.escalation.stage = 'done';
    if (summary.conforme) {
      l.escalation.issue = 'conforme';
      w.log(`${lotKey(l.project, l.lot)} · escalade ${l.escalation.model} : revue conforme`);
    }
  }
  if (l.small && l.visible) {
    // La passe unique d'un petit lot porte aussi l'ergonomie : son verdict vaut pour les deux. Sur un lot non petit, le verdict UX reste celui de l'agent UX.
    l.ux = summary;
    l.uxVerdict = summary.verdict;
  }
  const minors = minorConstats(rep);
  // Revue conforme avec mineurs : une seule passe de correction des mineurs, avant de conclure (rien sous le tapis).
  // Budget épuisé : la passe n'aurait aucune session pour la jouer, les mineurs sont rendus en propositions ; la revue conforme conclut le lot,
  // sauf un lot visible avec orchestrate.ux, qui passe à next = 'ux' puis reste suspendu tant que le budget de la vague l'est.
  const wanted = summary.conforme && !l.minorPass && !l.light && minors.length > 0; // lot léger : les mineurs restent des notes (L108)
  const noBudget = wanted && (w.budget.exhausted || !fixAffordable(l)) && !w.incident && !w.quota.hit;
  const minorPass = wanted && !noBudget;
  if (noBudget) l.warnings.push(`${w.budget.exhausted ? 'budget atteint' : 'budget du lot trop juste pour payer la correction et la revue courte qui la suivrait'} : la passe des mineurs n'a pas eu lieu, mineurs rendus en propositions`);
  // Les mineurs confiés à la passe ont pu être proposés par une revue non conforme antérieure : si la revue qui la suit est
  // conforme, ils sont traités et ne restent pas en propositions (ceux que cette revue signale encore sont ajoutés juste après).
  if (l.minorPass && !minorPass && summary.conforme && l.minorLines?.length) {
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
  if (summary.conforme) (l.reviewCounts ??= []).push(0); // une revue conforme compte pour 0 dans la comparaison de la convergence (L205)
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
  if (summary.conforme) {
    if (uxAfterReview(c)) {
      l.next = 'ux';
      save(c);
    } else return () => conclude(c, summary);
    return;
  }
  const constats = blockingConstats(rep, 'code');
  (l.reviewCounts ??= []).push(constats.length);
  toFix(c, constats, 'revue non conforme');
}

/** Trace d'un verdict reporté après un rebase (R9) : le sha relu, le sha intégré qui le remplace, et le patch-id (le même des deux côtés) qui le garantit. */
export interface Reporte {
  de: string;
  vers: string;
  patchId: string;
}

/**
 * Revue conforme : le verdict est enregistré avec le sha relu, puis le commit du plan. `raf done` reste au lead.
 * Un lot en worktree (L279) n'écrit rien au plan ici : le verdict et la clôture des sous-tâches attendent l'intégration, qui les écrit après l'avance de la branche
 * du dépôt (R22, R23) ; le lot passe alors à l'étape `integrate`, la seule que `--resume --integrate` rejoue (R14, R27).
 */
async function conclude(c: LotCtx, code: ReviewSummary, minorNote = ''): Promise<void> {
  const l = c.lot;
  const plan = histPlan(c);
  // Dépôts voisins du lot (L62) : le sha lu de chacun est enregistré avec le verdict, et dit dans son texte (un plan en lecture seule n'a que le texte).
  const neighbours = l.repos ?? [];
  const shas = repoShas(plan, neighbours, l.lot);
  const read = neighbours.length ? ` ; dépôts relus : ${neighbours.map((r) => `${r.rel}@${shas[r.rel]?.slice(0, 7) ?? 'aucun commit du lot'}`).join(', ')}` : '';
  const verdict = `${code.verdict} — orchestré (vague ${c.wave.id}, ${l.pass} passe(s) de correction${l.minorPass ? ` + passe des mineurs${minorNote}` : ''}${read})`;
  l.verdict = verdict;
  const newer = lotWork(plan, wd(c), l.lot)[0]?.sha ?? null;
  // L317 : la porte du bibliothécaire peut ne pas avoir été jouée (passes ou budget épuisés) ; un écart docs.sync ouvert ne finit jamais prêt.
  const gap = openDocGap(c);
  if (gap) {
    stop(c, 'handed-back', gap);
    return;
  }
  const moved = (code.head && newer !== null && git(wd(c), 'rev-parse', 'HEAD') !== code.head ? [''] : []).concat(
    neighbours.filter((r) => shas[r.rel] !== null && code.repoHeads?.[r.rel] && git(r.path, 'rev-parse', 'HEAD') !== code.repoHeads[r.rel]).map((r) => ` dans ${r.rel}`),
  );
  if (moved.length) {
    stop(c, 'handed-back', `un commit est postérieur à la revue${moved.join(',')} : verdict non enregistré`);
    return;
  }
  l.constats = [];
  if (c.tree?.active) {
    l.next = 'integrate';
    save(c);
    await integrateLot(c);
    return;
  }
  const dirty = await writeVerdict(c, verdict, newer);
  if (dirty) {
    stop(c, 'handed-back', dirty);
    return;
  }
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/**
 * Écrit au plan, dans le dépôt du projet, l'entrée du lot : verdict (au sha `commit`, avec la trace `reporte` d'un verdict reporté), sous-tâches couvertes
 * passées à done, puis le commit du plan seul ; pour un plan en lecture seule, l'outil `orchestrate.verdict` du projet, lancé dans ce dépôt (R21, R23).
 * Rend la cause d'un refus (arbre sale hors plan), null sinon. Un verdict déjà écrit et commité au même sha n'est pas écrit deux fois (reprise de l'intégration, R23).
 */
async function writeVerdict(c: LotCtx, verdict: string, commit: string | null, reporte?: Reporte): Promise<string | null> {
  const l = c.lot;
  const plan = c.loadPlan();
  const neighbours = l.repos ?? [];
  const shas = repoShas(plan, neighbours, l.lot);
  // Sous-tâches ouvertes que des commits du lot citent (L82) : la revue conforme vaut pour elles, sinon `raf done` refuserait le lot.
  const covered = coveredTasks(plan, l.repo, l.lot, neighbours.flatMap((r) => repoWork(plan, r, l.lot)));
  // En worktree, rien n'est écrit (ni plan, ni outil du projet) si le dépôt du lead a déjà un fichier suivi modifié hors plan : le refus ne laisse pas un plan modifié non commité (R26).
  const foreign = c.tree ? foreignDirty(c) : [];
  if (foreign.length) return `arbre du dépôt modifié (${foreign.join(', ')})`;
  // Le commit de plan va sur la branche courante du dépôt : en worktree, elle doit être encore la branche de départ (R24), même si le lead a bougé depuis l'avance.
  if (c.tree) {
    const cur = repoBranch(l.repo);
    if (cur !== c.tree.base) return `dépôt sur ${cur ?? 'HEAD détaché'} et non ${c.tree.base}`;
  }
  if (!plan.readonly) {
    // Déjà écrit et commité au même sha (reprise de l'intégration, R23) : une seule fois.
    if (c.tree && commit !== null && plan.lot(l.lot).review?.commit === commit && !covered.length && !trackedDirty(l.repo).includes(relative(l.repo, plan.path))) return null;
    plan.recordReview(l.lot, verdict, c.wave.today, commit, neighbours.length ? shas : undefined, reporte);
    for (const k of covered) plan.setStatus(`${l.lot}/${k.task}`, 'done', c.wave.today);
    if (covered.length) l.warnings.push(`sous-tâches closes (couvertes par des commits qui les citent, revue conforme) : ${covered.map((k) => `${l.lot}/${k.task} (${k.sha.slice(0, 7)})`).join(', ')}`);
    plan.save();
    const dirty = await commitPlan(c, `plan: ${l.lot} revue de code enregistrée (orchestrate ${c.wave.id})`);
    if (dirty) return dirty;
  } else {
    for (const k of covered) propose(c, `[sous-tâche clore] ${l.lot}/${k.task} — couverte par ${k.sha.slice(0, 7)}, revue conforme : à clore avant raf done`);
  }
  if (plan.readonly && c.config.verdict) {
    // La trace d'un verdict reporté va dans le texte, le seul endroit où l'outil du projet la lit (R23).
    const text = reporte ? `${verdict} ; verdict reporté : ${reporte.de.slice(0, 7)} → ${reporte.vers.slice(0, 7)} (patch-id identique)` : verdict;
    const r = await sh(c, c.config.verdict.replaceAll('{lot}', l.lot).replaceAll('{verdict}', shEscape(text)), undefined, undefined, l.repo);
    if (r.code !== 0) l.warnings.push(`orchestrate.verdict en échec (code ${r.code}) : le lead reporte le verdict`);
    else {
      const dirty = await commitPlan(c, `plan: ${l.lot} revue de code notée (orchestrate ${c.wave.id})`);
      if (dirty) return dirty;
    }
  }
  return null;
}

/**
 * Les fichiers que le cycle a le droit de commiter dans `repo` : le plan, ce qui est tenu avec lui, et les acceptation.json (L173), où il pose le scellé et `vert: true`.
 * Source commune de `commitPlan` et de `foreignDirty`.
 */
function planOwnFile(c: LotCtx, repo: string): (f: string) => boolean {
  const plan = c.loadPlan();
  const own = new Set([relative(repo, plan.path), ...plan.maintained]);
  const specDir = `${c.config.spec.dir.replace(/\/+$/, '')}/`;
  return (f) => own.has(f) || (f.startsWith(specDir) && isAcceptationFile(f));
}

/** Les fichiers suivis modifiés du dépôt du projet qui ne sont ni le plan, ni ce qui est tenu avec lui, ni une acceptation : ce que `commitPlan` refuserait (R26). */
function foreignDirty(c: LotCtx): string[] {
  const ownFile = planOwnFile(c, c.lot.repo);
  return trackedDirty(c.lot.repo).filter((f) => !ownFile(f));
}

/** Pourquoi le dépôt du lead n'est plus celui que l'intégration a vu au départ : branche changée ou HEAD détaché (R24), fichier suivi modifié (R8). Null s'il est intact. */
function leadMoved(repo: string, base: string): string | null {
  const cur = repoBranch(repo);
  if (cur !== base) return `le dépôt est sur ${cur ?? 'HEAD détaché'} et non sur ${base}`;
  const dirty = trackedDirty(repo);
  return dirty.length ? `arbre du dépôt modifié (${dirty.join(', ')})` : null;
}

/** Une écriture de plan du programme (R21, R26) : sous la file et le verrou du dépôt, le dépôt encore sur la branche de départ, aucun fichier suivi modifié hors plan. Rend la cause du refus, null si l'écriture a eu lieu. Hors worktree, rien ne change. */
async function planWrite(c: LotCtx, write: () => Promise<string | null>): Promise<string | null> {
  if (!c.tree) return write();
  const l = c.lot;
  const grant = await takeRepoWrite(l.repo, { wave: c.wave.id }, c.wave.integrate);
  if (!grant.ok) return `écriture du plan refusée : verrou tenu par ${grant.holder.wave} (pid ${grant.holder.pid})`;
  try {
    const cur = repoBranch(l.repo);
    if (cur !== c.tree.base) return `écriture du plan refusée : dépôt sur ${cur ?? 'HEAD détaché'} et non ${c.tree.base}`;
    const foreign = foreignDirty(c);
    if (foreign.length) return `écriture du plan refusée : arbre du dépôt modifié (${foreign.join(', ')})`;
    return await write();
  } finally {
    grant.release();
  }
}

/** Début de la cause d'un lot rendu sur le refus d'écrire les notes d'hypothèses de sa fiche, et des mineurs de la revue de sa fiche (handBackPlan). */
export const HYPOTHESES_HANDBACK = 'notes des hypothèses de la fiche : ';
const MINORS_HANDBACK = 'notes des mineurs de la revue de ';

/**
 * Lot rendu sur une écriture de plan refusée hors intégration (R26) : en worktree il garde l'étape atteinte (`next`), et `--resume --replay` le rejoue à cette étape
 * (décision du lead du 24-10). Aucun champ d'état : la cause rendue le désigne.
 */
export const planNoteHandBack = (l: LotState): boolean => l.status === 'handed-back' && l.next !== null && l.next !== undefined && !!l.outcome && (l.outcome.startsWith(HYPOTHESES_HANDBACK) || l.outcome.startsWith(MINORS_HANDBACK));

/** Une écriture de plan refusée rend le lot au lead ; en worktree, il garde l'étape atteinte pour la reprise (R26), sinon `stop` la vide comme avant. */
function handBackPlan(c: LotCtx, why: string): void {
  if (c.tree) transition(c, 'handed-back', why);
  else stop(c, 'handed-back', why);
}

/** Ce qui sépare le verdict de la revue du lot de celui de sa revue courte du diff rebasé (R17). */
const SHORT_REVIEW_TRACE = ' ; revue courte du diff rebasé (patch-id différent) : ';

const minutesText = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} s`);

/**
 * Intégration d'un lot en worktree à la branche du dépôt (L279, C2), AVANT sa transition à ready (R22). Sous le verrou d'intégration : branche du dépôt encore
 * celle de départ (R24), aucun fichier suivi modifié (R8), rebase sur le sommet courant (conflit : abandonné, rendu au lead, R6), contrôles rejoués au sommet
 * rebasé (R7), report du verdict si le patch-id est le même (R9) ou revue courte du diff rebasé sinon (R17), avance en fast-forward, puis écriture du plan dans le
 * dépôt du projet (R23). Tout rendu garde `next: integrate` et le worktree : seul `--resume --integrate` le rejoue (R14, R27).
 */
async function integrateLot(c: LotCtx): Promise<void> {
  const l = c.lot;
  const key = lotKey(l.project, l.lot);
  const refuse = (why: string): void => {
    l.next = 'integrate';
    transition(c, 'handed-back', why);
  };
  // Un lot repris à l'intégration dont le worktree a été retiré entre-temps (`--remove-worktree`) n'a plus rien à intégrer.
  if (!c.tree?.active) {
    // Une branche encore là mais sans sa clé `branch.<nom>.cadence-base` (supprimée à la main, config perdue) n'est pas une branche retirée : elle n'est pas rejouée, et rien n'est dit « abandonné ».
    const br = lotBranch(c.wave.id, l.project, l.lot);
    if (branchExists(l.repo, br)) return refuse(`intégration impossible : la branche ${br} existe mais n'est plus marquée comme worktree de cadence (branch.${br}.cadence-base absente) : rien n'est intégré ni retiré, à vérifier à la main`);
    return refuse("intégration impossible : le worktree du lot n'existe plus (retiré par --remove-worktree ?) : commits abandonnés, sa branche n'est plus là pour être intégrée");
  }
  const t = c.tree;
  const kept = `worktree conservé : ${t.dir}`;
  const waitMs = c.wave.integrate?.waitMs ?? INTEGRATE_WAIT_MS;
  const grant = await takeRepoWrite(l.repo, { wave: c.wave.id }, c.wave.integrate);
  if (!grant.ok) return refuse(`intégration refusée : verrou d'intégration tenu par ${grant.holder.wave} (pid ${grant.holder.pid}) depuis plus de ${minutesText(waitMs)} ; ${kept}`);
  // Un refus tardif garde `l.verdict` avec la trace de la revue courte déjà jouée : reprise, elle est rejouée et remplace l'ancienne trace au lieu de s'y ajouter.
  let verdict = (l.verdict ?? '').split(SHORT_REVIEW_TRACE)[0];
  let reporte: Reporte | undefined;
  let start = '';
  try {
    const moved = leadMoved(l.repo, t.base);
    if (moved) return refuse(`intégration refusée : ${moved} ; branche conservée : ${t.branch}`);
    start = git(l.repo, 'rev-parse', `refs/heads/${t.base}`);
    // Une branche déjà contenue dans celle du dépôt (arrêt entre l'avance et l'écriture du verdict) : ni rebase ni avance, seul le plan reste à écrire (R23).
    if (!integrated(l.repo, t.branch, t.base)) {
      const reviewed = l.code?.head ?? git(t.dir, 'rev-parse', 'HEAD');
      const rebased = rebaseOnto(t.dir, t.base);
      if (rebased.kind === 'conflict') {
        return refuse(`intégration impossible : conflit en rebasant ${t.branch} sur ${t.base}${rebased.files.length ? ` (fichiers : ${rebased.files.join(', ')})` : ` (${rebased.detail})`} ; ${kept}`);
      }
      if (rebased.kind === 'rebased' && rebased.changelog > 0) c.wave.log(`${key} CHANGELOG.md : conflit d'ajout pur résolu par union sous [Unreleased] (${rebased.changelog} commit(s))`);
      const tip = git(t.dir, 'rev-parse', 'HEAD');
      if (tip !== reviewed) {
        // Le rebase a changé les commits : tests et build rejoués au sommet rebasé, avant que la branche du dépôt ne bouge (R7).
        const { red, runs } = await integratedChecks(c, key);
        l.checks = runs.length ? { head: tip, runs } : undefined;
        save(c);
        if (red.length) return refuse(`intégration refusée : tests rouges au sommet intégré (${red.map(redExcerpt).join(' ; ')}) ; branche du dépôt inchangée, ${kept}`);
        const before = patchId(t.dir, mergeBase(t.dir, reviewed, t.base), reviewed);
        const after = patchId(t.dir, t.base, 'HEAD');
        if (before !== '' && before === after) {
          const vers = lotWork(histPlan(c), t.dir, l.lot)[0]?.sha ?? tip;
          reporte = { de: reviewed, vers, patchId: before };
        } else {
          // Le diff du lot n'est plus celui qui a été relu (contexte modifié, conflit résolu) : une revue courte du diff rebasé avant l'avance (R17).
          const short = await shortReview(c);
          if (short === null) return;
          if (short.refused) return refuse(`intégration refusée : revue courte du diff rebasé : ${short.refused} ; branche du dépôt inchangée, ${kept}`);
          verdict = `${verdict}${SHORT_REVIEW_TRACE}${short.verdict}`;
          l.verdict = verdict;
        }
      }
      // Les contrôles rejoués et la revue courte ont pu durer : le lead a pu changer de branche ou salir son arbre depuis le contrôle du départ (R24, R8).
      const late = leadMoved(l.repo, t.base);
      if (late) return refuse(`intégration refusée : ${late} ; branche du dépôt inchangée, ${kept}`);
      advance(l.repo, t.branch);
    }
    const end = git(l.repo, 'rev-parse', `refs/heads/${t.base}`);
    if (end !== start) c.wave.log(`${key} intégré : ${start.slice(0, 7)}..${end.slice(0, 7)}`);
    if (reporte) c.wave.log(`${key} verdict reporté : ${reporte.de.slice(0, 7)} → ${reporte.vers.slice(0, 7)} (patch-id identique)`);
    // Le plan, sous le même verrou, après l'avance : un commit de plan seul au sommet de la branche du dépôt, `commit` = dernier commit de travail intégré (R23).
    const commit = lotWork(c.loadPlan(), l.repo, l.lot)[0]?.sha ?? null;
    // Aucun commit de travail au sommet : il n'y a rien d'intégré, donc rien qu'un verdict conforme puisse couvrir.
    if (commit === null) return refuse(`intégration impossible : aucun commit du lot dans ${t.base} (commits abandonnés ?) ; ${kept}`);
    const refusal = await writeVerdict(c, verdict, commit, reporte);
    if (refusal) return refuse(`écriture du plan refusée : ${refusal}`);
  } catch (e) {
    return refuse(`intégration impossible : ${gitFailure(e)} ; ${kept}`);
  } finally {
    grant.release();
  }
  // Intégré : le worktree et la branche, propres et fusionnés, sont retirés (R12) ; sinon ils restent et le journal le dit.
  const removed = removeTree({ repo: l.repo, dir: t.dir, branch: t.branch, base: t.base });
  if (!removed.ok) c.wave.log(`orchestrate : ${key} : worktree conservé : ${t.dir} (branche ${t.branch})`);
  else t.active = false;
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/**
 * Revue courte (`review-small`) du diff rebasé (R17), jouée sous le verrou d'intégration. `refused` : le nombre de constats bloquants ou majeurs, dit en clair ;
 * `null` : la session n'a pas eu lieu (budget, quota, arrêt) et le lot est suspendu ou rendu par `session`.
 */
async function shortReview(c: LotCtx): Promise<{ verdict: string; refused?: undefined } | { refused: string; verdict?: undefined } | null> {
  c.integration = { base: c.tree!.base };
  try {
    const done = await session(c, 'review-small');
    if (!done) return null;
    const rep = checkShape<ReviewReport>(done.report, REVIEW_SCHEMA);
    const n = rep.bloquants + rep.majeurs;
    if (n > 0) return { refused: `${n} constat(s) bloquant(s) ou majeur(s)` };
    return { verdict: rep.verdict };
  } catch (e) {
    return { refused: `rapport illisible (${(e as Error).message})` };
  } finally {
    c.integration = undefined;
  }
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

/**
 * Prédicat « ce commit est l'œuvre d'une session de la vague » (L200) : les commits connus des étapes de TOUS les lots de la vague
 * (`steps[].commits`) et ceux de `headBefore..headAfter` de chaque session terminée. Un rescellé du lead se fait entre deux sessions, hors de ces plages.
 */
function waveCommits(c: LotCtx, repo: string): (sha: string) => boolean {
  const known = new Set<string>();
  const prefixes: string[] = [];
  for (const l of [c.lot, ...c.wave.store.lots().filter((x) => lotKey(x.project, x.lot) !== lotKey(c.lot.project, c.lot.lot))]) {
    for (const s of l.steps) {
      for (const k of s.commits ?? []) if (/^[0-9a-f]{7,40}\b/i.test(k)) prefixes.push(k.split(' ')[0]!.toLowerCase());
      if (!s.headBefore || !s.headAfter || l.repo !== repo) continue;
      try {
        for (const sha of git(repo, 'rev-list', `${s.headBefore}..${s.headAfter}`).split('\n')) if (sha) known.add(sha);
      } catch {
        // plage illisible (historique réécrit) : les commits connus de l'étape restent comptés
      }
    }
  }
  return (sha) => known.has(sha) || prefixes.some((p) => sha.startsWith(p));
}

/** Crée le worktree du lot à la prise de son créneau, ou le retrouve à la reprise (R3, R11). Faux quand il est impossible : le lot seul est rendu avec la cause git, les autres continuent (R5). */
async function ensureTree(c: LotCtx): Promise<boolean> {
  const t = c.tree;
  if (!t || t.active) return true;
  const l = c.lot;
  const key = lotKey(l.project, l.lot);
  const made = prepareTree({ repo: l.repo, dir: t.dir, branch: t.branch, base: t.base, lot: key });
  if (!made.ok) {
    c.wave.log(`orchestrate : ${key} : worktree impossible : ${made.cause}`);
    stop(c, 'handed-back', `worktree impossible : ${made.cause}`);
    return false;
  }
  t.active = true;
  c.wave.log(`${key} · worktree ${made.reused ? 'retrouvé' : 'créé'} : ${t.dir} (branche ${t.branch})`);
  return true;
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
    // Un lot déjà commencé retrouve son worktree (R11) ; un lot neuf n'en a un qu'une fois son raf start fait, dans le dépôt du projet (R21).
    if ((l.next !== null || l.steps.length > 0) && !(await ensureTree(c))) return;
    // Un test rescellé par le lead pendant la question (L200) a déplacé le commit rouge : l'ancre suit, le verrou garde le reste.
    if (l.status === 'question' && l.accept?.rouge) l.accept.rouge = resealedRouge(wd(c), l.accept.acceptation, l.accept.rouge, waveCommits(c, l.repo)) ?? l.accept.rouge;
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
      // Le raf start et son commit de plan sont une écriture du dépôt du projet : sous le verrou du dépôt quand le lot a un worktree (R21, R26).
      const why = await planWrite(c, async () => {
        const before = await snapshot(l.repo, { remote: false });
        if (before.tracked.length) return `dépôt sale avant le lot : ${trackedPaths(before).join(', ')}`;
        return startLot(c);
      });
      if (why) {
        stop(c, 'handed-back', why);
        return;
      }
      if (!(await ensureTree(c))) return;
      l.startedSha = (await snapshot(wd(c), { remote: false })).head ?? undefined;
      // Un lot repris de sa branche conservée (L311) n'a rien à faire contrôler : ses commits sont les siens. Il repart à la correction des constats de sa dernière revue, à la revue s'il en a passé une sans constat, à l'écriture s'il n'a jamais été revu.
      // La correction de départ est une passe comme les autres (toFix : l.pass, verdict, tableau, MAX_PASSES bornent le total, reprise comprise).
      if (l.resumedFrom && l.constats.length) toFix(c, l.constats, 'reprise de la branche');
      else {
        l.next = l.resumedFrom ? (l.resumedReviewed ? firstReview(c) : firstWrite(c)) : precheckOrSkip(c) ? 'precheck' : firstWrite(c);
        save(c);
      }
    }
    while (l.next && !TERMINAL.has(l.status)) {
      const kind = l.next;
      if ((kind === 'accept' || kind === 'implement') && (await settleHypotheses(c))) return;
      if (kind === 'precheck') await precheck(c);
      else if (kind === 'spec') await specStep(c);
      else if (kind === 'fiche') await ficheStep(c);
      else if (kind === 'maquette') await maquetteStep(c);
      else if (kind === 'accept') await acceptStep(c);
      else if (kind === 'implement' || kind === 'fix') await work(c, kind);
      else if (kind === 'integrate') await integrateLot(c);
      else await review(c, kind);
      if (l.status === 'suspended' || l.status === 'question') return;
    }
  } catch (e) {
    l.next = null;
    transition(c, 'failed', `erreur : ${(e as Error).message}`);
  } finally {
    // TMPDIR court des sessions (L243) : jetable, retiré à la fin de chaque passage du lot ; la session suivante (reprise, réponse) le recrée.
    try {
      c.wave.store.removeTmpDir(l.project, l.lot);
    } catch {
      // nettoyage de confort : jamais une cause d'échec du lot
    }
    // Sorties du MCP Playwright qu'une session a écrites dans le dépôt (L50) : jetables, retirées à la fin de chaque passage du lot.
    try {
      cleanPlaywrightOutput(wd(c));
    } catch {
      // nettoyage de confort : jamais une cause d'échec du lot
    }
  }
}
