import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import { lotWork } from '../audit.js';
import type { OrchestrateConfig } from '../config.js';
import type { Day } from '../dates.js';
import { readCommits, type Commit } from '../git.js';
import { citedRefs } from '../link.js';
import { isOpen, type Plan } from '../plan.js';
import { isPlanOnly } from '../audit.js';
import { objective, renderBrief, type BriefVars } from './briefs.js';
import { journalTokens, peakContext, runSession, trackGroup, type AgentDef, type ClaudeFn, type Model, type StepKind } from './launch.js';
import { pushed, snapshot, type Snapshot } from './guard.js';
import type { Tokens } from './result.js';
import { checkShape, REVIEW_SCHEMA, schemaFor, WORK_SCHEMA, type ReviewReport, type WorkReport } from './schemas.js';
import type { Constat, LotState, ReviewSummary, RunStore, StepState } from './state.js';
import { lotKey } from './state.js';

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

export interface WaveCtx {
  id: string;
  store: RunStore;
  budget: Budget;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  today: Day;
  /** ~/.claude : pour relire le pic de contexte des sessions. */
  claudeHome?: string;
  templatesDir?: string;
  quota: { hit: boolean; message?: string };
  /** Push ou revue qui a modifié le dépôt : la vague s'arrête. */
  incident: string | null;
  log: (line: string) => void;
  saveWave: () => void;
}

export interface LotCtx {
  wave: WaveCtx;
  lot: LotState;
  config: OrchestrateConfig;
  loadPlan: () => Plan;
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
function commitPlan(c: LotCtx, message: string): string | null {
  const repo = c.lot.repo;
  const plan = c.loadPlan();
  const own = new Set([relative(repo, plan.path), ...plan.files]);
  const dirty = trackedPaths(snapshot(repo, { remote: false }));
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
    const child = spawn('sh', ['-c', command], { cwd: c.lot.repo, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    const dirty = commitPlan(c, `plan: ${c.lot.lot} démarré (orchestrate ${c.wave.id})`);
    if (dirty) return dirty;
  }
  return null;
}

function lotCommitLines(c: LotCtx): string {
  const plan = c.loadPlan();
  return lotWork(plan, c.lot.repo, c.lot.lot).reverse().map((k) => `- ${short(k)}`).join('\n');
}

function constatLines(constats: Constat[]): string {
  return constats
    .map((k) => `- [${k.gravite}${k.source === 'code' ? '' : ` / ${k.source}`}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`)
    .join('\n');
}

function uxText(c: LotCtx): string {
  const ux = c.config.ux;
  if (!ux) {
    return 'No way to run the app is declared (cadence.yaml: orchestrate.ux): review the interface from the code, and list under "nonVerifie" what you could not see.';
  }
  return [
    ux.url ? `The running app is at ${ux.url}.` : '',
    ux.command ? `Start the app with: ${ux.command} (from the repository root), and stop it when you are done.` : '',
    'Take screenshots at 1440 and 390 px width (into the shared tmp folder, never in the repository).',
  ]
    .filter(Boolean)
    .join(' ');
}

function briefFor(c: LotCtx, kind: StepKind): string {
  const plan = c.loadPlan();
  const l = c.lot;
  const lot = plan.lot(l.lot);
  const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: lot.title, objectif: objective(lot), commits: '', reponse: '', constats: '', ux: uxText(c) };
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
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  return renderBrief(kind, vars, c.wave.templatesDir);
}

type Done = { step: StepState; report: unknown; before: Snapshot; after: Snapshot };

/** Pourquoi plus aucune session ne doit partir (incident, quota, budget), sinon null. */
function halted(w: WaveCtx): string | null {
  if (w.incident) return `vague arrêtée : ${w.incident}`;
  if (w.quota.hit) return 'quota atteint';
  if (w.budget.exhausted) return 'budget atteint';
  return null;
}

/** Une session : budget et quota vérifiés avant, état écrit avant et après, journal gardé, contrôles du dépôt après. */
async function session(c: LotCtx, kind: StepKind): Promise<Done | null> {
  const w = c.wave;
  const l = c.lot;
  const halt = halted(w);
  if (halt) return suspend(c, halt);

  const write = kind === 'implement' || kind === 'fix';
  const model: Model = write ? l.model : 'opus';
  const before = snapshot(l.repo);
  const n = l.steps.length + 1;
  const sessionId = randomUUID();
  const step: StepState = { n, kind, model, status: 'running', sessionId, started: new Date().toISOString(), headBefore: before.head ?? undefined };
  l.steps.push(step);
  const label = { implement: 'implementing', fix: 'fixing', review: 'reviewing', ux: 'reviewing', 'review-small': 'reviewing' } as const;
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
  l.pendingAnswer = null; // la réponse est dans le brief : elle ne repart pas avec la session suivante
  const outcome = await runSession(
    {
      kind,
      sessionId,
      brief,
      model,
      schema: schemaFor(kind),
      agent: kind === 'ux' ? 'ux-reviewer' : write ? undefined : 'code-reviewer',
      cwd: l.repo,
      wave: w.id,
      permissionMode: c.config.permissionMode,
      addDirs: c.config.addDirs,
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

  if (outcome.kind !== 'ok') {
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
  if (outcome.kind === 'failed') {
    writeFileSync(join(dir, `${base}.json`), outcome.stdout);
    writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.report = `${base}.json`;
    step.status = 'failed';
    step.cause = outcome.cause;
    return stop(c, 'failed', `${kind} sans résultat : ${outcome.cause}`);
  }
  if (outcome.kind === 'quota') {
    step.status = 'interrupted';
    step.cause = outcome.message;
    w.quota = { hit: true, message: outcome.message };
    w.saveWave();
    c.lot.next = kind;
    transition(c, 'suspended', 'quota atteint');
    return null;
  }

  const res = outcome.result;
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({ ...res, structured: res.structured }, null, 2));
  step.report = `${base}.json`;
  step.sessionId = res.sessionId;
  step.tokens = res.tokens;
  w.budget.add(res.tokens);
  w.saveWave();
  if (w.claudeHome) step.peakContext = peakContext(w.claudeHome, l.repo, res.sessionId);

  const after = snapshot(l.repo);
  step.headAfter = after.head ?? undefined;
  if (pushed(before, after)) {
    step.status = 'failed';
    step.cause = 'push détecté';
    w.incident = `push détecté pendant ${lotKey(l.project, l.lot)} (${kind})`;
    w.saveWave();
    return stop(c, 'failed', `incident : ${w.incident}`);
  }
  if (before.guard && !after.guard) {
    step.status = 'failed';
    step.cause = 'le hook pre-push de garde a disparu';
    w.incident = `le hook pre-push de garde a été supprimé pendant ${lotKey(l.project, l.lot)} (${kind})`;
    w.saveWave();
    return stop(c, 'failed', `incident : ${w.incident}`);
  }
  if (!write && (before.head !== after.head || before.tracked.join() !== after.tracked.join() || before.untracked.join() !== after.untracked.join())) {
    step.status = 'failed';
    step.cause = 'le dépôt a changé pendant une revue';
    w.incident = `${kind} de ${lotKey(l.project, l.lot)} a modifié le dépôt`;
    w.saveWave();
    return stop(c, 'failed', `incident : ${w.incident}`);
  }
  step.status = 'ok';
  save(c);
  return { step, report: res.structured, before, after };
}

function suspend(c: LotCtx, why: string): null {
  transition(c, 'suspended', why);
  return null;
}

function summarize(rep: ReviewReport, head: string): ReviewSummary {
  // Rien d'un rapport n'est cru sur parole : un constat de gravité majeure compte même si les totaux annoncés disent 0.
  const count = (g: string) => rep.constats.filter((k) => k.gravite === g).length;
  const bloquants = Math.max(rep.bloquants, count('bloquant'));
  const majeurs = Math.max(rep.majeurs, count('majeur'));
  return { conforme: bloquants === 0 && majeurs === 0, bloquants, majeurs, mineurs: Math.max(rep.mineurs, count('mineur')), verdict: rep.verdict.trim(), sousTaches: rep.sousTaches, nonVerifie: rep.nonVerifie, head };
}

function addProposals(c: LotCtx, rep: ReviewReport, source: string): void {
  const add = (t: string) => {
    if (!c.lot.proposals.includes(t)) c.lot.proposals.push(t);
  };
  for (const k of rep.constats.filter((k) => k.gravite === 'mineur')) add(`[mineur ${source}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);
  for (const t of rep.sousTaches) add(`[sous-tâche ${source}] ${t}`);
}

function blockingConstats(rep: ReviewReport, source: 'code' | 'ux'): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'bloquant' || k.gravite === 'majeur').map((k) => ({ source, gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

function badReport(c: LotCtx, step: StepState, e: unknown): null {
  step.status = 'failed';
  step.cause = (e as Error).message;
  return stop(c, 'failed', `${step.kind} : ${(e as Error).message}`);
}

/** Étape d'écriture (implémentation, correction) : contrôles, puis étape suivante décidée. */
async function work(c: LotCtx, kind: 'implement' | 'fix'): Promise<void> {
  const l = c.lot;
  const done = await session(c, kind);
  if (!done) return;
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
  done.step.commits = commits.map(short).reverse();
  // La liste de git fait foi ; l'écart avec celle du rapport est signalé.
  const real = new Set(commits.map((k) => k.sha));
  for (const a of rep.commits) {
    if (![...real].some((s) => s.startsWith(a.sha) || a.sha.startsWith(s.slice(0, 7)))) l.warnings.push(`commit annoncé absent de git : ${a.sha} ${a.sujet}`);
  }
  for (const k of commits) {
    if (isPlanOnly(k.sha, plan, l.repo)) continue;
    if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  }
  save(c);

  if (rep.questions.length) {
    l.questions = rep.questions;
    l.next = kind;
    transition(c, 'question', rep.questions[0]);
    return;
  }
  const dirt = [...trackedPaths(done.after), ...done.after.untracked.filter((f) => !done.before.untracked.includes(f))];
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après ${kind} : ${dirt.join(', ')}`);
    return;
  }
  if (commits.length === 0) {
    stop(c, 'handed-back', `${kind} sans commit`);
    return;
  }

  const red: Constat[] = [];
  if (!rep.tests.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `tests annoncés rouges par la session : ${rep.tests.commande} — ${rep.tests.resultat}` });
  if (!rep.build.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `build annoncé rouge par la session : ${rep.build.commande} — ${rep.build.resultat}` });
  if (red.length === 0 && c.config.test) {
    const r = await sh(c, c.config.test);
    if (r.code !== 0) red.push({ source: 'tests', gravite: 'bloquant', texte: `${c.config.test} en échec (code ${r.code}) :\n${r.output.trim().split('\n').slice(-40).join('\n')}` });
  }
  if (red.length) {
    toFix(c, red, 'tests rouges');
    return;
  }
  l.constats = [];
  l.next = firstReview(c);
  save(c);
}

function firstReview(c: LotCtx): StepKind {
  const l = c.lot;
  if (l.small) return 'review-small';
  if (l.visible) {
    if (!c.config.ux) {
      l.uxNote = 'UX à faire par le lead (aucune application déclarée : cadence.yaml orchestrate.ux)';
      return 'review';
    }
    if (!l.ux || !l.ux.conforme) return 'ux';
  }
  return 'review';
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

async function review(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<void> {
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
  const summary = summarize(rep, done.after.head ?? '');
  if (kind === 'ux') {
    l.ux = summary;
    addProposals(c, rep, 'ux');
    l.uxVerdict = summary.verdict;
    l.constats = blockingConstats(rep, 'ux');
    l.next = 'review'; // la revue de code clôt toujours le cycle
    save(c);
    return;
  }
  l.code = summary;
  addProposals(c, rep, 'code');
  if (kind === 'review-small' && l.visible) {
    // La passe unique porte aussi l'ergonomie : son verdict vaut pour les deux.
    l.ux = summary;
    l.uxVerdict = summary.verdict;
  }
  const uxOk = kind === 'review-small' || !l.ux || l.ux.conforme;
  if (summary.conforme && uxOk) {
    await conclude(c, summary);
    return;
  }
  const constats = [...blockingConstats(rep, 'code'), ...(kind === 'review' && l.ux && !l.ux.conforme ? uxConstatsKept(c) : [])];
  toFix(c, constats, 'revue non conforme');
}

/** Constats UX de la dernière revue UX, gardés dans l'état par la revue elle-même (l.constats avant la revue de code). */
function uxConstatsKept(c: LotCtx): Constat[] {
  return c.lot.constats.filter((k) => k.source === 'ux');
}

/** Revue conforme : le verdict est enregistré avec le sha relu, puis le commit du plan. `raf done` reste au lead. */
async function conclude(c: LotCtx, code: ReviewSummary): Promise<void> {
  const l = c.lot;
  const plan = c.loadPlan();
  const verdict = `${code.verdict} — orchestré (vague ${c.wave.id}, ${l.pass} passe(s) de correction)`;
  l.verdict = verdict;
  const newer = lotWork(plan, l.repo, l.lot)[0]?.sha ?? null;
  if (code.head && newer !== null && git(l.repo, 'rev-parse', 'HEAD') !== code.head) {
    stop(c, 'handed-back', 'un commit est postérieur à la revue : verdict non enregistré');
    return;
  }
  l.constats = [];
  if (!plan.readonly) {
    plan.recordReview(l.lot, verdict, c.wave.today, newer);
    plan.save();
    const dirty = commitPlan(c, `plan: ${l.lot} revue de code enregistrée (orchestrate ${c.wave.id})`);
    if (dirty) {
      stop(c, 'handed-back', dirty);
      return;
    }
  } else if (c.config.verdict) {
    const r = await sh(c, c.config.verdict.replaceAll('{lot}', l.lot).replaceAll('{verdict}', shEscape(verdict)));
    if (r.code !== 0) l.warnings.push(`orchestrate.verdict en échec (code ${r.code}) : le lead reporte le verdict`);
    else {
      const dirty = commitPlan(c, `plan: ${l.lot} revue de code notée (orchestrate ${c.wave.id})`);
      if (dirty) {
        stop(c, 'handed-back', dirty);
        return;
      }
    }
  }
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/** Joue le cycle d'un lot jusqu'à son terme, ou jusqu'à l'arrêt (question, budget, quota). Ne lève jamais. */
export async function runLot(c: LotCtx): Promise<void> {
  const l = c.lot;
  try {
    if (TERMINAL.has(l.status)) return;
    if (l.status === 'question' && !l.pendingAnswer) return;
    if (l.next === null && l.steps.length === 0) {
      // Pas de raf start ni de commit du plan pour un lot qu'aucune session ne suivrait.
      const halt = halted(c.wave);
      if (halt) {
        suspend(c, halt);
        return;
      }
      const before = snapshot(l.repo, { remote: false });
      if (before.tracked.length) {
        stop(c, 'handed-back', `dépôt sale avant le lot : ${trackedPaths(before).join(', ')}`);
        return;
      }
      const why = await startLot(c);
      if (why) {
        stop(c, 'handed-back', why);
        return;
      }
      l.startedSha = snapshot(l.repo, { remote: false }).head ?? undefined;
      l.next = 'implement';
      save(c);
    }
    while (l.next && !TERMINAL.has(l.status)) {
      const kind = l.next;
      if (kind === 'implement' || kind === 'fix') await work(c, kind);
      else await review(c, kind);
      if (l.status === 'suspended' || l.status === 'question') return;
    }
  } catch (e) {
    l.next = null;
    transition(c, 'failed', `erreur : ${(e as Error).message}`);
  }
}
