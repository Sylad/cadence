import { execFileSync, spawn } from 'node:child_process';
import { parse } from 'yaml';
import { toolBinOf, withoutLaunchVars } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coveredTasks, lotCommits, lotWork } from '../audit.js';
import { readDocsConfig, type OrchestrateConfig } from '../config.js';
import { docSyncBrief, docSyncGaps, filesOf } from '../docsync.js';
import type { Day } from '../dates.js';
import { changedFiles, readCommits, resolveCommit, type Commit } from '../git.js';
import { citedRefs } from '../link.js';
import { repoShas, repoWork, type LotRepo } from '../repos.js';
import { isOpen, type Plan } from '../plan.js';
import { isPlanOnly } from '../audit.js';
import { compareBaseline, failedTests, hasUnnamedFailure } from './baseline.js';
import { APP_TIMEOUT_S, startApp, type AppState } from './app.js';
import { capturesText, newsText, objective, renderBrief, reposText, TEMPLATES_DIR, type BriefName, type BriefVars, type Templates } from './briefs.js';
import { journalTokens, peakContext, mcpServersFor, playwrightDir, runSession, trackGroup, writeMcpConfig, type AgentDef, type ClaudeFn, type Model, type StepKind, type StepModel } from './launch.js';
import { cleanPlaywrightOutput, pushed, snapshot, type Snapshot } from './guard.js';
import type { Tokens } from './result.js';
import { ACCEPT_SCHEMA, checkShape, PRECHECK_SCHEMA, REVIEW_SCHEMA, schemaFor, SPEC_SCHEMA, WORK_SCHEMA, type AcceptReport, type PrecheckReport, type ReviewReport, type SpecReport, type WorkReport } from './schemas.js';
import { acceptationFile, acceptCommands, isAcceptList, acceptText, checkAcceptation, findAcceptation, isAcceptationFile, lockViolations, lotStartHead, parseAcceptation, planAcceptRuns, redSha, resealedRouge, sealAcceptation, setVert } from './accept.js';
import { avalFicheText, ficheContracts, ficheRules, hasScreenPart } from './aval.js';
import { ficheReviewText, reviewedSheetText } from './fiche.js';
import { bulletLines, maquetteText, reviewedText } from './maquette.js';
import { answeredText, checkSpec, costlyHypotheses, ficheHasBack, ficheReady, findFiche, hypothesisLines, hypothesisNote, specText, type FicheParts } from './spec.js';
import type { Constat, LotState, ReviewSummary, RunStore, StepState } from './state.js';
import { lotKey, lotRepoPaths, neighbourDirs } from './state.js';

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
  // Les acceptation.json (L173) rejoignent les fichiers que le cycle a le droit de commiter : il y pose le scellé et `vert: true`.
  const specDir = `${c.config.spec.dir.replace(/\/+$/, '')}/`;
  const ownFile = (f: string) => own.has(f) || (f.startsWith(specDir) && isAcceptationFile(f));
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
const startSha = (c: LotCtx): string | undefined => lotStartHead(c.lot.repo, lotWork(c.loadPlan(), c.lot.repo, c.lot.lot).map((k) => k.sha)) ?? c.lot.steps.find((s) => s.headBefore)?.headBefore;

/** Dossiers ignorés de sortie de build : jamais liés dans le worktree jetable, une commande de tests qui y écrit toucherait le build du lot. */
const OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.output', '.angular', '.turbo', '.svelte-kit', '.parcel-cache']);

/**
 * Échecs des tests au sha de départ du lot (L213) : la commande est rejouée dans un worktree jetable de ce sha, hors du dépôt,
 * avec des liens vers les dossiers ignorés de la racine (node_modules, dist…) pour que les dépendances s'y trouvent. Null quand
 * le worktree ne peut être monté : l'appelant garde alors les tests pour rouges.
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
    // Tous niveaux : en monorepo les dépendances vivent dans packages/*/node_modules. `--directory` ne descend pas dans un dossier ignoré, donc
    // chaque entrée est le dossier ou fichier ignoré le plus haut ; son parent doit exister au sha de départ (sinon rien où le relier).
    const ignored = git(l.repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory').split('\n').map((f) => f.replace(/\/$/, '')).filter((f) => f && !f.startsWith('.cadence') && !f.split('/').some((p) => OUTPUT_DIRS.has(p)));
    for (const name of ignored) {
      const to = join(dir, name);
      if (existsSync(to) || !existsSync(dirname(to))) continue;
      symlinkSync(join(l.repo, name), to);
      links.push(to);
    }
    const r = await sh(c, command, 30 * 60_000, {}, dir);
    const failures = r.code === 0 ? [] : failedTests(r.output);
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
function sh(c: LotCtx, command: string, timeoutMs = 30 * 60_000, env: Record<string, string> = {}, cwd = c.lot.repo): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...withoutLaunchVars(process.env), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  const b = c.lot.baseline;
  // Sans orchestrate.test aucun run : la base annoncée par la session (non vérifiée) est la seule trace des échecs de départ.
  if (b && !b.verified && b.failures.length) {
    return `The author reports ${b.failures.length} test(s) already red at the start sha${b.sha ? ` ${b.sha.slice(0, 7)}` : ''}, before this lot (not verified by the program):\n${b.failures.map((t) => `- ${t}`).join('\n')}\nThey are not defects of this lot, do not report them as findings; a failing test outside this list is still a finding.`;
  }
  const k = c.lot.checks;
  if (!k?.runs.length || k.head !== git(c.lot.repo, 'rev-parse', 'HEAD')) return '';
  const runs = k.runs.map((r) => `- \`${r.command}\` (${r.label}): ${r.code === 0 ? 'green' : r.dejaRouges ? `RED, exit code ${r.code}, but every failing test (${r.dejaRouges}) was already red at the start sha${c.lot.baseline?.sha ? ` ${c.lot.baseline.sha.slice(0, 7)}` : ''}: not a defect of this lot, do not report them as findings` : `RED, exit code ${r.code}`}`);
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
export function briefName(l: LotState, kind: StepKind): BriefName {
  if (l.specLot && !l.screen && (kind === 'spec' || kind === 'accept')) return `${kind}-back`;
  if (kind === 'fix' && l.minorFix) return 'fix-minors';
  if (kind === 'review-small' && l.minorPass && !(l.small && l.visible)) return 'review-recheck';
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
const partsOf = (l: LotState, fiche?: string | null): FicheParts => ({ screen: !!l.screen, back: !!l.specLot || (!!l.screen && !!fiche && ficheHasBack(l.repo, fiche)) });

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
  return l.spec && 'fiche' in l.spec ? l.spec.fiche : findFiche(l.repo, c.config.spec.dir, l.lot);
}

/**
 * Consigne de la fiche pour les étapes en aval d'un lot qui en a une (L174) : implement, fix, revue de code, UX de conformité.
 * Vide quand le lot n'a pas de fiche (sous le seuil, ou pas encore écrite) ou qu'elle est illisible.
 */
function avalOf(c: LotCtx, kind: StepKind): string {
  const l = c.lot;
  const step = kind === 'implement' || kind === 'fix' || kind === 'ux' ? kind : kind === 'review' || kind === 'review-small' ? 'review' : null;
  const fiche = step ? ficheOf(c) : null;
  if (!step || !fiche) return '';
  let rules: string[];
  let contracts: string[];
  let screen: boolean;
  try {
    const doc = parse(readFileSync(join(l.repo, fiche), 'utf8'));
    rules = ficheRules(doc);
    contracts = ficheContracts(doc);
    screen = hasScreenPart(doc);
  } catch {
    return '';
  }
  if (!rules.length || (step === 'ux' && !screen)) return '';
  const acceptation = l.accept?.acceptation ?? findAcceptation(l.repo, c.config.spec.dir, l.lot) ?? undefined;
  const o = { fiche, rules, acceptation, rouge: l.accept?.rouge, contracts, screen };
  const text = avalFicheText(step, o);
  // la revue courte d'un petit lot visible est sa seule passe : elle porte aussi la conformité à la maquette
  return kind === 'review-small' && l.small && l.visible && screen ? `${text}\n${avalFicheText('ux', o)}` : text;
}

function briefFor(c: LotCtx, kind: StepKind): string {
  const plan = c.loadPlan();
  const l = c.lot;
  const lot = plan.lot(l.lot);
  const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: lot.title, objectif: objective(lot), commits: '', reponse: '', constats: '', spec: '', ux: uxText(c), choix: choixText(c.lot.choix ?? []), checks: kind === 'review' || kind === 'review-small' ? checksText(c) : '', docs: kind === 'review' || kind === 'review-small' ? docsText(c) : '', news: '', captures: '', repos: reposText(kind === 'implement' || kind === 'fix' ? 'write' : 'read', l.lot, l.repos ?? []) };
  if (l.visible) {
    const pwDir = playwrightDir(c.wave.store.lotDir(l.project, l.lot));
    vars.news = newsText(l.lot, pwDir);
    vars.captures = capturesText(pwDir);
  }
  vars.fiche = hasSpecStage(l) ? avalOf(c, kind) : '';
  if (kind === 'spec') {
    const reviewed = [...(l.ficheConstats ?? []), ...(l.maquetteConstats ?? [])];
    const written = ficheOf(c);
    const back = partsOf(l, written).back;
    vars.spec = specText({
      dir: c.config.spec.dir,
      render: c.config.spec.render,
      screen: l.screen,
      back,
      problems: l.specProblems,
      review: !reviewed.length ? undefined : back ? reviewedSheetText(reviewed, !!l.screen) : reviewedText(reviewed),
      template: l.screen ? ficheTemplate() : undefined,
      templateBack: back || l.screen ? ficheBackTemplate() : undefined,
    });
    const mine = lotCommitLines(c);
    if (mine) vars.commits = `Commits of the lot already present (do not redo them; fix or complete the spec from them):\n${mine}`;
    if (l.pendingAnswer) vars.reponse = l.specAsked?.length ? answeredText(l.specAsked, l.pendingAnswer) : `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  if (kind === 'fiche') {
    vars.fiche = ficheReviewText({ fiche: ficheOf(c) ?? '', passes: l.fiche?.passes ?? 0, previous: l.ficheConstats });
    vars.reponse = '';
  }
  if (kind === 'maquette') {
    vars.maquette = maquetteText({ fiche: ficheOf(c) ?? '', passes: l.maquette?.passes ?? 0, previous: l.maquetteConstats });
    vars.reponse = '';
  }
  if (kind === 'accept') {
    const fiche = ficheOf(c) ?? '';
    const folder = posix.dirname(fiche);
    vars.accept = acceptText({ fiche, maquette: `${folder}/maquette.html`, screen: !!l.screen, back: !!l.screen && partsOf(l, fiche).back, acceptation: acceptationFile(fiche, l.lot), command: c.config.accept ?? '', test: c.config.test, runner: acceptRunner(), problems: l.acceptProblems });
    vars.objectif = ''; // l'oracle est écrit depuis la fiche et la maquette seules, pas depuis le texte du lot
    vars.commits = '';
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
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
  const write = kind === 'implement' || kind === 'fix' || kind === 'spec' || kind === 'accept';
  // Le budget du lot borne l'écriture, jamais la revue (L145) : une revue est jouée dès que le code est à relire (sauf tests rouges après une écriture, cf. REVIEW_RESERVE), la passe fix réserve son coût.
  if (write && (lotOver(l) || (kind === 'fix' && !fixAffordable(l)))) return overBudget(c, kind === 'fix' && !lotOver(l));

  const model: StepModel = kind === 'spec' || kind === 'accept' || kind === 'fiche' ? 'sonnet' : write ? l.model : local ? 'local' : kind === 'precheck' ? 'sonnet' : reviewModel(c, kind); // le contrôle préalable ne fait que lire : pas d'Opus
  const effort = c.config.effort[kind === 'review-small' ? 'review' : kind];
  const before = await snapshot(l.repo);
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
    brief = briefFor(c, kind);
  } catch (e) {
    step.status = 'failed';
    step.cause = (e as Error).message;
    return stop(c, 'failed', `brief de ${kind} : ${(e as Error).message}`);
  }
  const mcpConfig = writeMcpConfig(w.store.lotDir(l.project, l.lot), kind, l.visible, l.small, !!l.screen);
  const playwright = !!mcpServersFor(kind, l.visible, '', l.small, !!l.screen).playwright;
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
      agent: kind === 'spec' ? 'spec-writer' : kind === 'accept' ? 'acceptance-writer' : kind === 'ux' || kind === 'maquette' ? 'ux-reviewer' : kind === 'precheck' ? 'precheck-reader' : write ? undefined : 'code-reviewer',
      cwd: l.repo,
      wave: w.id,
      lot: lotKey(l.project, l.lot),
      permissionMode: c.config.permissionMode,
      prodAccess: c.config.prodAccess,
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
    // Étape en lecture seule qui n'a laissé que des fichiers NON SUIVIS (captures d'un script en chemin relatif, L162) : déplacés dans le dossier du lot, avertissement, le verdict est gardé.
    if (!write && b.head === a.head && b.tracked.join() === a.tracked.join() && b.untracked.join() !== a.untracked.join() && b.untracked.every((f) => a.untracked.includes(f))) {
      const fresh = a.untracked.filter((f) => !b.untracked.includes(f)).map(unquotePath);
      const stray = join(dir, 'stray');
      const to = where ? join(stray, relative(l.repo, path).replace(/[\\/]/g, '_')) : stray;
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
  step.status = 'ok';
  save(c);
  return { step, report: res.structured, before, after, others };
}

/** Incident du LOT (L133) : la revue a laissé des traces (captures, commit), ni push ni garde supprimée — les lots des autres dépôts continuent. */
function handBack(c: LotCtx, kind: StepKind, report: unknown, step: StepState, where: string, path: string, b: Snapshot, a: Snapshot, left?: string[]): null {
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
  const basis = hasSpecStage(l) ? 'estimate et étape spec' : "dérivé de l'estimate";
  const why = reserve ? `budget du lot : ${lotSpent(l)} / ${l.budget} tokens comptés (${basis}), il ne reste pas de quoi payer la revue qui suivrait la correction (${REVIEW_RESERVE} réservés)` : `budget du lot atteint (${lotSpent(l)} / ${l.budget} tokens comptés, ${basis})`;
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

/** Première session d'écriture d'un lot : la spec quand il déclare `screen:` ou `spec: true` et qu'aucune fiche n'est écrite, sinon l'implémentation. */
function firstWrite(c: LotCtx): StepKind {
  const l = c.lot;
  if (!hasSpecStage(l) || l.spec) return 'implement';
  const fiche = findFiche(l.repo, c.config.spec.dir, l.lot);
  return fiche && ficheReady(l.repo, fiche, l.lot, partsOf(l, fiche)) ? afterSpec(c, fiche) : 'spec';
}

const NO_TEST_ACCEPT = 'étape accept : orchestrate.test absent, rien ne prouve que les tests rouges sont exclus du lanceur de tests et de la CI (vérifier à la main la config du lanceur avant de livrer)';
const NO_ACCEPT = 'étape accept ignorée : orchestrate.accept absent (commande dédiée aux tests d\'acceptation), le lot passe de spec à implement sans tests rouges';

/**
 * Étape qui suit une spec écrite : la revue UX de la maquette (S4) tant qu'elle n'est pas conforme (`orchestrate.maquette`), sauf si une
 * acceptation conforme est déjà commitée (elle n'a pu être écrite qu'après la revue) ; puis les tests d'acceptation rouges (S5).
 */
function afterSpec(c: LotCtx, fiche: string): StepKind {
  const l = c.lot;
  // Revue de la fiche back (L188) d'abord, puis celle de la maquette d'un lot mixte ; la même preuve (acceptation scellée, code déjà commité) dispense des deux.
  if (c.config.fiche && partsOf(l, fiche).back && !l.fiche?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'fiche';
  return afterFiche(c, fiche);
}

/** Étape qui suit une fiche relue : la revue UX de la maquette d'un lot à écran (S4), sinon `afterMaquette`. */
function afterFiche(c: LotCtx, fiche: string): StepKind {
  const l = c.lot;
  if (l.screen && c.config.maquette && !l.maquette?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'maquette';
  return afterMaquette(c, fiche);
}

/** Étape qui suit une maquette relue (ou une fiche, pour un lot sans écran) : les tests d'acceptation rouges (S5) quand le projet déclare sa commande dédiée et qu'aucune acceptation conforme n'est déjà commitée, sinon l'implémentation. */
function afterMaquette(c: LotCtx, fiche: string): StepKind {
  const l = c.lot;
  // Des constats de la revue de fiche attendent la revue de la maquette (lot mixte) : les deux partent ensemble à la seconde passe `spec`.
  if (l.ficheConstats?.length) return 'spec';
  if (!c.config.accept) {
    if (!l.warnings.includes(NO_ACCEPT)) l.warnings.push(NO_ACCEPT);
    return 'implement';
  }
  const json = lotAcceptation(c, fiche);
  if (acceptationProof(c, fiche)) {
    l.accept = { acceptation: json, rouge: redSha(l.repo, json) ?? '' };
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
    sha = git(l.repo, 'log', '--diff-filter=A', '--format=%H', '--', fiche).split('\n').filter(Boolean).pop() ?? git(l.repo, 'log', '-1', '--format=%H', '--', posix.dirname(fiche));
  } catch {
    return false;
  }
  if (!sha) return false;
  const dir = `${posix.dirname(fiche)}/`;
  const after = new Set(readCommits(l.repo, { range: `${sha}..HEAD` }).map((k) => k.sha));
  // Un commit de la session spec elle-même (fiche, maquette, captures) ou de la session accept (tests listés) n'est pas du code.
  const tests = new Set<string>();
  const json = lotAcceptation(c, fiche);
  if (listed(c, json)) {
    const doc = parseAcceptation(readFileSync(join(l.repo, json), 'utf8'));
    if (typeof doc !== 'string') for (const f of doc.fichiers) tests.add(posix.normalize(f));
  }
  return lotWork(c.loadPlan(), l.repo, l.lot).some((k) => after.has(k.sha) && changedFiles(l.repo, k.sha).some((f) => !f.startsWith(dir) && !tests.has(f)));
}

/** L'acceptation du lot : celle que git suit déjà pour lui (même un ancien `acceptation.json`), sinon `acceptation-<lot>.json` à côté de la fiche. */
const lotAcceptation = (c: LotCtx, fiche: string): string => findAcceptation(c.lot.repo, c.config.spec.dir, c.lot.lot) ?? acceptationFile(fiche, c.lot.lot);

const listed = (c: LotCtx, json: string): boolean => existsSync(join(c.lot.repo, json));

/**
 * Une acceptation conforme et SCELLÉE par le programme (empreintes posées), rouge ou verte (`vert: true`, lot relancé dans une nouvelle vague) :
 * elle n'a pu être écrite qu'après la revue de la maquette et les tests rouges, qui ne sont donc pas rejoués. Sans `orchestrate.accept`, aucune preuve.
 */
function acceptationProof(c: LotCtx, fiche: string): boolean {
  const l = c.lot;
  const json = lotAcceptation(c, fiche);
  if (!c.config.accept || !listed(c, json)) return false;
  const doc = parseAcceptation(readFileSync(join(l.repo, json), 'utf8'));
  if (typeof doc === 'string' || !doc.empreintes) return false;
  // Le scellé n'est posé que par le programme : chaque fichier listé doit porter l'empreinte git de son contenu actuel (une clé `empreintes` vide ou copiée d'un autre lot ne prouve rien).
  const emp = doc.empreintes;
  const sealed = doc.fichiers.every((f) => {
    const norm = posix.normalize(f);
    return existsSync(join(l.repo, norm)) && emp[norm] === git(l.repo, 'hash-object', '--', norm).trim();
  });
  if (!sealed) return false;
  const vertMsg = checkAcceptation(l.repo, json, l.lot, fiche).filter((p) => !(doc.vert && p.includes('vert: true à l\'écriture')));
  return vertMsg.length === 0;
}

/** Chemins salis par une session : suivis modifiés, nouveaux fichiers non suivis, et ceux des dépôts voisins. */
function dirtAfter(done: Done): string[] {
  return [
    ...trackedPaths(done.after),
    ...done.after.untracked.filter((f) => !done.before.untracked.includes(f)),
    ...done.others.flatMap((o) => [...trackedPaths(o.after), ...o.after.untracked.filter((f) => !o.before.untracked.includes(f))].map((f) => `${o.repo.rel}: ${f}`)),
  ];
}

/** Suite commune des étapes spec et accept : commits de la session (avertis s'ils ne citent pas le lot), choix reportés, vraies questions (les non-questions deviennent un avertissement). */
function takeReport(c: LotCtx, done: Done, rep: { choix?: string[]; questions: string[] }): string[] {
  const l = c.lot;
  const commits: Commit[] = readCommits(l.repo, { range: done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined });
  done.step.commits = commits.map(short).reverse();
  for (const k of commits) if (!citedRefs(k, c.loadPlan().refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);
  for (const q of rep.questions) if (q.trim() && isNonQuestion(q)) l.warnings.push(`question ignorée (non-question) : « ${q.trim()} »`);
  return rep.questions.filter((q) => !isNonQuestion(q));
}

/**
 * Étape spec (L171, spec etape-spec S3) : la session écrit maquette, captures et fiche dans `<spec.dir>/<écran>/`, le programme
 * en relève les écarts (une seconde passe, puis le lot est rendu), une hypothèse coûteuse à défaire devient une question au lead,
 * et une sortie sous le seuil (le lot ne change aucun écran) rend le lot au chemin actuel.
 */
async function specStep(c: LotCtx): Promise<void> {
  const l = c.lot;
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
    l.specRuns = undefined; // la réponse ouvre un nouveau budget de deux sessions
    l.specAsked = undefined; // la prochaine réponse porte sur la question de la session, pas sur d'anciennes hypothèses coûteuses
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
  const asked = reported ? relative(l.repo, resolve(l.repo, reported)) : '';
  const outside = asked === '..' || asked.startsWith('../') || isAbsolute(asked);
  const fiche = outside ? '' : asked || findFiche(l.repo, c.config.spec.dir, l.lot) || '';
  const what = l.screen ? '<écran>' : '<sujet>';
  const inDir = fiche === '' || fiche.startsWith(`${c.config.spec.dir.replace(/\/+$/, '')}/`);
  const problems = !outside && fiche && !inDir ? [`${fiche} : fiche hors de ${c.config.spec.dir} (la spec vit dans ${c.config.spec.dir}/${what}/fiche.yaml, où l'étape la retrouve)`] : outside ? [`${reported} : fiche hors du dépôt (le chemin de « fiche » est relatif au dépôt : ${c.config.spec.dir}/${what}/fiche.yaml)`] : fiche ? checkSpec(l.repo, fiche, l.lot, partsOf(l, fiche)) : [`aucune fiche écrite : ${c.config.spec.dir}/${what}/fiche.yaml est attendue (ou une raison dans « sousSeuil » si le lot ne change ${l.screen ? 'aucun écran' : 'aucun comportement'})`];
  if (problems.length) {
    if ((l.specRuns ?? 0) >= 2) {
      stop(c, 'handed-back', `spec non conforme après 2 passes : ${problems.join(' ; ')}`);
      return;
    }
    l.specProblems = problems;
    l.next = 'spec';
    save(c);
    return;
  }
  l.specProblems = undefined; // les contrôles passent : les écarts de la passe précédente sont corrigés
  const doc = parse(readFileSync(join(l.repo, fiche), 'utf8')) as { regles?: { statut?: unknown }[]; sujet?: { id?: unknown } };
  // Un choix coûteux à défaire n'est pas une hypothèse : la question remonte au lead, la session reprend avec sa réponse.
  const costly = costlyHypotheses(doc);
  if (costly.length) {
    l.questions = costly.map((x) => `${x.id} est posée comme hypothèse mais touche un choix coûteux à défaire (${x.categorie}) : « ${x.siFaux} » — la confirmer, ou la corriger, avant que la fiche serve de référence.`);
    l.specAsked = [...l.questions];
    l.specRuns = undefined; // la réponse du lead ouvre un nouveau budget de deux sessions, comme celle d'une question de la session
    l.next = 'spec';
    transition(c, 'question', l.questions[0]);
    return;
  }
  l.specAsked = undefined;
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
    doc = parse(readFileSync(join(l.repo, fiche), 'utf8')) as typeof doc;
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
  const plan = c.loadPlan();
  const texts = lines.map((x) => hypothesisNote(sujet, x));
  if (plan.readonly) {
    for (const t of texts) propose(c, `[note à poser] ${t}`);
    return false;
  }
  const have = new Set(plan.lot(l.lot).notes.map((n) => n.text));
  const fresh = texts.filter((t) => !have.has(t));
  if (!fresh.length) return false;
  for (const t of fresh) plan.note(l.lot, t, c.wave.today);
  plan.save();
  const dirty = await commitPlan(c, `plan: ${l.lot} hypothèses de la fiche ${sujet} notées (orchestrate ${c.wave.id})`);
  if (dirty) {
    stop(c, 'handed-back', `notes des hypothèses de la fiche : ${dirty}`);
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
  const plan = c.loadPlan();
  if (plan.readonly) {
    for (const t of texts) propose(c, `[note à poser] ${t}`);
    return false;
  }
  const have = new Set(plan.lot(c.lot.lot).notes.map((n) => n.text));
  const fresh = [...new Set(texts)].filter((t) => !have.has(t));
  if (!fresh.length) return false;
  for (const t of fresh) plan.note(c.lot.lot, t, c.wave.today);
  plan.save();
  const dirty = await commitPlan(c, `plan: ${c.lot.lot} mineurs de la revue de ${label} notés (orchestrate ${c.wave.id})`);
  if (dirty) {
    stop(c, 'handed-back', `notes des mineurs de la revue de ${label} : ${dirty}`);
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
  after: (c: LotCtx, fiche: string) => StepKind;
  /** Étape suivante quand des constats renvoient à la spec. */
  retry: (c: LotCtx, fiche: string) => StepKind;
}

const FICHE_REVIEW: SpecReview = { kind: 'fiche', label: 'fiche', source: 'code', after: afterFiche, retry: afterFiche };
const MAQUETTE_REVIEW: SpecReview = { kind: 'maquette', label: 'maquette', source: 'ux', after: afterMaquette, retry: () => 'spec' };

/**
 * Revue de la spec (fiche ou maquette) : une session de lecture seule. Un bloquant ou un majeur renvoie à la spec (une seule seconde passe, avec
 * les constats ; pour un lot mixte, ceux des deux revues ensemble), puis la spec est relue ; ce qui reste après la seconde revue est rendu au lead.
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
  l[r.kind] = { passes, conforme: summary.conforme, verdict: summary.verdict };
  // Fiche : les mineurs sont des notes du lot (design § 4). Maquette : inchangé (propositions du tableau final).
  addProposals(c, rep, r.kind, r.kind !== 'fiche');
  if (r.kind === 'fiche' && (await noteMinors(c, rep, `la ${r.label}`))) return;
  const constats = blockingConstats(rep, r.source);
  const key = r.kind === 'fiche' ? 'ficheConstats' : 'maquetteConstats';
  if (summary.conforme) {
    l[key] = undefined;
    l.next = r.after(c, fiche);
    save(c);
    return;
  }
  if (passes >= 2) {
    stop(c, 'handed-back', `${r.label} non conforme après 2 revues : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
    return;
  }
  // Le budget de deux sessions spec est épuisé (écarts du programme compris) : un renvoi à la spec serait une 3ᵉ session.
  if ((l.specRuns ?? 0) >= 2) {
    stop(c, 'handed-back', `${r.label} non conforme et la spec a déjà joué 2 sessions : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
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
  const abs = join(c.lot.repo, json);
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
  const out = headBefore ? lockViolations(l.repo, c.config.spec.dir, headBefore, { skip: json }) : [];
  out.push(...checkAcceptation(l.repo, json, l.lot, fiche, l.steps.find((s) => s.kind === 'accept')?.headBefore));
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
  sealAcceptation(l.repo, json);
  const dirty = await commitPlan(c, `test(${l.lot}): acceptation scellée, empreintes des tests rouges (orchestrate ${c.wave.id})`);
  if (dirty) {
    stop(c, 'handed-back', `scellé de ${json} : ${dirty}`);
    return;
  }
  l.accept = { acceptation: json, rouge: git(l.repo, 'rev-parse', 'HEAD') };
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
  const json = l.accept?.acceptation ?? findAcceptation(l.repo, c.config.spec.dir, l.lot);
  if (!json || !existsSync(join(l.repo, json))) return null;
  const a = parseAcceptation(readFileSync(join(l.repo, json), 'utf8'));
  if (typeof a === 'string' || a.vert) return null;
  const { runs, orphans } = await runAccept(c, json);
  if (orphans.length) return { source: 'tests', gravite: 'bloquant', texte: `fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept : ${orphans.join(', ')}` };
  const failed = runs.filter((r) => r.code !== 0);
  if (failed.length) return { source: 'tests', gravite: 'bloquant', texte: `tests d'acceptation encore rouges (${failed.map((r) => `${r.command}, code ${r.code}`).join(' ; ')}) : à rendre verts sans modifier les fichiers listés dans ${json} :\n${failed.map((r) => (failed.length > 1 ? `$ ${r.command}\n` : '') + tail(r.output)).join('\n')}` };
  setVert(l.repo, json);
  const dirty = await commitPlan(c, `chore(${l.lot}): acceptation verte, vert: true posé par le cycle (orchestrate ${c.wave.id})`);
  if (dirty) return { source: 'tests', gravite: 'bloquant', texte: `vert: true de ${json} : ${dirty}` };
  return null;
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

  // Verrou des tests d'acceptation (L173) : ceux de TOUS les lots du dépôt, pas seulement du lot courant ; une modification est une question au lead. Contrôlé à CHAQUE fin de session, une question comprise (L200) :
  // une session qui remplace un test scellé puis pose une question ne passe pas par la reprise du lead pour se faire adopter.
  const locked = done.step.headBefore ? lockViolations(l.repo, c.config.spec.dir, done.step.headBefore, { rouge: l.accept?.rouge ? { [l.accept.acceptation]: l.accept.rouge } : {}, lot: l.lot, lotBase: l.steps.find((s) => s.headBefore)?.headBefore, lotStart: lotStartHead(l.repo, lotWork(c.loadPlan(), l.repo, l.lot).map((k) => k.sha)), lotCommits: lotCommits(c.loadPlan(), l.repo, l.lot).map((k) => k.sha) }) : [];
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
  const dirt = dirtAfter(done);
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
  // Tests annoncés rouges (L213) : avec orchestrate.test, le programme rejoue et compare à la ligne de base, la session n'est crue que si les tests y sont rouges autrement que par des échecs de départ ; sans, la liste des échecs de base de la session, non vérifiée.
  const claimed: Constat = { source: 'tests', gravite: 'bloquant', texte: `tests annoncés rouges par la session : ${rep.tests.commande} — ${rep.tests.resultat}` };
  let deferred = false;
  const declared = (rep.echecsDeBase ?? []).map((t) => t.trim()).filter(Boolean);
  if (!c.config.test && declared.length) {
    l.baseline = { sha: startSha(c) ?? '', failures: declared, verified: false };
    l.warnings.push(`échecs déjà présents au sha de départ selon la session (${declared.length}) : non vérifié par le programme (orchestrate.test absent)`);
  }
  if (!rep.tests.vert) {
    if (c.config.test) deferred = true;
    else red.push(claimed); // le brief demande de ne pas annoncer rouge pour les seuls échecs de base : rouge + base = de nouveaux échecs
  }
  if (!rep.build.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `build annoncé rouge par la session : ${rep.build.commande} — ${rep.build.resultat}` });
  const runs: NonNullable<LotState['checks']>['runs'] = [];
  if (red.length === 0) {
    const green = await acceptGreen(c);
    if (green) red.push(green);
  }
  if (red.length === 0) {
    for (const [label, command] of [['tests', c.config.test], ['build', c.config.build]] as const) {
      if (!command) continue;
      const r = await sh(c, command);
      const run: (typeof runs)[number] = { label, command, code: r.code };
      runs.push(run);
      if (r.code === 0) continue;
      const vs: VsBase = label === 'tests' ? await againstBaseline(c, command, r.output) : { kind: 'unknown' };
      if (vs.kind === 'existing') {
        run.dejaRouges = vs.n;
        const note = `${vs.n} test(s) déjà rouge(s) au sha de départ ${(l.baseline?.sha ?? '').slice(0, 7)}, pas un défaut du lot : listés à part, la revue a lieu`;
        if (!l.warnings.includes(note)) l.warnings.push(note);
        continue;
      }
      if (vs.kind === 'new') {
        red.push({ source: 'tests', gravite: 'bloquant', texte: `${command} en échec (code ${r.code}) : ${vs.nouveaux.length} test(s) rouge(s) qui ne l'étaient pas au sha de départ :\n${vs.nouveaux.map((t) => `- ${t}`).join('\n')}${vs.existants ? `\n(${vs.existants} autre(s) test(s) déjà rouge(s) au sha de départ : à ne pas corriger)` : ''}` });
        break;
      }
      red.push({ source: 'tests', gravite: 'bloquant', texte: `${command} en échec (code ${r.code}) :\n${r.output.trim().split('\n').slice(-40).join('\n')}` });
      break;
    }
  }
  // La session annonçait des tests rouges et le programme ne les voit pas rouges au départ : l'annonce vaut.
  if (deferred && red.length === 0 && !runs.some((r) => r.label === 'tests' && r.dejaRouges)) red.push(claimed);
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
  // Revue qui converge (L205) : un seul constat bloquant ou majeur reste, après une baisse d'une revue à l'autre → une passe de plus (budget : fixAffordable, à l'entrée de la session).
  const counts = l.reviewCounts ?? [];
  const converging = what === 'revue non conforme' && counts.length >= 2 && counts[counts.length - 1] === 1 && counts[counts.length - 1] < counts[counts.length - 2];
  const cap = converging ? MAX_PASSES_CONVERGING : MAX_PASSES;
  if (l.pass >= cap) {
    stop(c, 'handed-back', `${what} après ${l.pass} passe(s) de correction`);
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
  if (summary.conforme && uxOk) (l.reviewCounts ??= []).push(0); // une revue conforme compte pour 0 dans la comparaison de la convergence (L205)
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
  (l.reviewCounts ??= []).push(constats.length);
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
    // Un test rescellé par le lead pendant la question (L200) a déplacé le commit rouge : l'ancre suit, le verrou garde le reste.
    if (l.status === 'question' && l.accept?.rouge) l.accept.rouge = resealedRouge(l.repo, l.accept.acceptation, l.accept.rouge, waveCommits(c, l.repo)) ?? l.accept.rouge;
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
      l.next = needsPrecheck(c.config, c.loadPlan(), l.repo, l.lot, l.repos) ? 'precheck' : firstWrite(c);
      save(c);
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
