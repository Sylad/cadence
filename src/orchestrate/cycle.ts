import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { toolBinOf, withoutLaunchVars } from './snapshot.js';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coveredTasks, lotCommits, lotWork } from '../audit.js';
import { planLoader } from '../config.js';
import { PLAN_ACTIONS, leadAnswerMessage } from '../plan-commit.js';
import { filesOf, gapMessage } from '../docsync.js';
import { testGateMissing } from '../testgate.js';
import { citesPriorWork, keepPrecheckReading, localYesNote, precheckNothingToFind } from './precheck.js';
import { PROBE_RESERVE, probeStep, scheduleProbe, type ProbeIo } from './probe.js';
import { changedFiles, gitCommonDir, readCommits, resolveCommit, tryGit, type Commit } from '../git.js';
import { citedRefs } from '../link.js';
import { repoShas, repoWork, type LotRepo } from '../repos.js';
import { isOpen, RafError, type Plan } from '../plan.js';
import { isPlanOnly } from '../audit.js';
import { compareBaseline, failedTests } from './baseline.js';
import { noteTight, noteUnstable } from './gate-notes.js';
import { TEST_WORKERS_ENV, type TightTest } from './workers.js';
import { baselineCandidates, gateLabel, gateReplayable, gateUnnamed, redAloneGate, redCandidates, replayGate, runGate, type GateRan, type GateTest } from './gate-parts.js';
import { withPlace, type Place } from './gate-place.js';
import { APP_TIMEOUT_S, startApp, type AppState } from './app.js';
import { trackGroup, type SessionKind } from './launch.js';
import { cleanPlaywrightOutput, snapshot } from './guard.js';
import { ACCEPT_SCHEMA, checkShape, PRECHECK_SCHEMA, REVIEW_SCHEMA, SPEC_SCHEMA, summarize, WORK_SCHEMA, type AcceptReport, type PrecheckReport, type ReviewReport, type SpecReport, type WorkReport } from './schemas.js';
import { type Acceptation, acceptationFile, acceptCommands, isAcceptList, checkAcceptation, findAcceptation, lockViolations, lotStartHead, parseAcceptation, planAcceptRuns, redSha, resealedRouge, sealAcceptation, setVert } from './accept.js';
import { bulletLines } from './maquette.js';
import { checkSpec, costlyHypotheses, ficheReady, findFiche, hypothesisLines, answerAltersRule, lightLot, LEAD_SOURCE, sourceRules } from './spec.js';
import { handBackWithoutFinding } from './no-finding.js';
import { LOCAL_PRECHECK_UNREADABLE, PRECHECK_UNREADABLE, expressSummary, lotKey, type Constat, type LotState, type ReviewSummary } from './state.js';
import { advance, baseMoved, INTEGRATE_WAIT_MS, MAX_REPLAYS, mergeBase, patchId, rebaseNotes, rebaseOnto, repoBranch, takeRepoWrite } from './integrate.js';
import { mutexFor } from './mutex.js';
import { branchExists, git, gitFailure, integrated, linkIgnored, lotBranch, prepareTree, removeTree, trackedDirty } from './worktree.js';
import { MAX_PASSES, MAX_PASSES_CONVERGING, type LotCtx, workDir as wd, histPlan, short, save, transition, stop, startSha, hasSpecStage, propose } from './cycle/ctx.js';
import { lotSpent, budgetCount, fixAffordable, dropped, DROPPED, halted, suspend } from './cycle/budget.js';
import { trackedPaths, planTemplate, planMessage, planBefore, commitPlan, noteHypotheses, noteMinors, foreignDirty, leadMoved, planWrite } from './cycle/plan-writes.js';
import { session, badReport, benchLocal, dirtBetween, LOCAL_FAILED, type Done } from './cycle/session.js';
import { docGaps, openDocGap, partsOf, ficheOf, specBudget } from './cycle/brief.js';

/** Façade (C1a, L490 ; C1b, L491) : le contexte, le budget, le brief, les écritures du plan et la session vivent dans `cycle/` ; les noms publics restent exportés d'ici. */
export { MAX_PASSES, MAX_PASSES_CONVERGING, Budget, countInterrupted, workDir } from './cycle/ctx.js';
export type { WaveCtx, LotTree, LotCtx } from './cycle/ctx.js';
export { lotSpent, ESCALATION_RESERVE, heldForEscalation, REVIEW_RESERVE, budgetStep, STOP_REQUESTED, DROPPED } from './cycle/budget.js';
export { HYPOTHESES_HANDBACK, planNoteHandBack, leadReviewedHandBack } from './cycle/plan-writes.js';
export { briefName } from './cycle/brief.js';

const TERMINAL = new Set(['ready', 'handed-back', 'failed']);

/**
 * Échecs des tests au sha de départ du lot (L213) : la commande est rejouée dans un worktree jetable de ce sha, hors du dépôt,
 * avec des liens vers les dossiers ignorés de tout niveau (node_modules, .venv… ; `dist` et les autres sorties de build exclus, une commande
 * de tests qui y écrit toucherait le build du lot) pour que les dépendances s'y trouvent. Les `node_modules` sont recréés entrée par entrée
 * pour que les paquets de workspace résolvent dans le worktree (`mirrorNodeModules`). Avec `orchestrate.testReplay`, un rouge nommé y est rejoué seul (L354) avant d'être retenu.
 * Null quand le worktree ne peut être monté : l'appelant garde alors les tests pour rouges.
 */
async function baselineFailures(c: LotCtx, test: GateTest): Promise<string[] | null> {
  const l = c.lot;
  const sha = startSha(c);
  const command = gateLabel(test); // clé de cache ; pour des parties (L512) le libellé « dir : run ; … », stable d'une lecture à l'autre
  if (!sha) return null;
  if (l.baseline?.verified && l.baseline.sha === sha && l.baseline.command === command) return l.baseline.failures;
  return atStartSha(c, sha, async (place) => {
    const r = await runGate(place.run, test);
    // Ligne de base comprise (L354) : un rouge du sha de départ est rejoué seul dans le même worktree avant d'être retenu. Sous charge, un test
    // qui passe seul au départ rougirait ici et excuserait une vraie régression du lot (« déjà rouge au départ »). Un échec sans nom reste tel quel ; en parties (L512), partie par partie.
    const found = r.code === 0 ? [] : failedTests(r.output);
    const named = gateReplayable(test, c.config.testReplay) && found.length ? baselineCandidates(r) : [];
    const { red: failures, unstable } = named.length ? await replayGate(place.run, c.config.testReplay, named, r) : { red: found, unstable: [] as string[] };
    if (unstable.length) c.wave.log(`${lotKey(l.project, l.lot)} · ligne de base ${sha.slice(0, 7)} : ${unstable.length} test(s) rouge(s) sous charge, vert(s) rejoué(s) seul(s), non retenu(s) comme déjà rouge(s) : ${unstable.join(' ; ')}`);
    l.baseline = { sha, command, failures, verified: true };
    save(c);
    return failures;
  });
}

/** Parmi les tests rouges `names` du lot, ceux rouges SEULS aussi au sha de départ (L510) : la suite entière du départ a pu les voir verts (ordre, charge), ils n'en sont pas moins déjà rouges avant le lot. Vide sans `testReplay`, sans sha de départ, build du départ rouge ou worktree non monté. */
async function redAtStart(c: LotCtx, names: string[], ran: GateRan): Promise<string[]> {
  const sha = startSha(c);
  return !sha || !gateReplayable(c.config.test, c.config.testReplay) || !names.length ? [] : (await atStartSha(c, sha, (place) => redAloneGate(place.run, c.config.testReplay, names, ran))) ?? [];
}

/** Joue `fn` dans un worktree jetable du sha de départ (ligne de base L213, rouges au départ L510), liens vers les dossiers ignorés posés puis retirés avec lui. Null si le worktree ne se monte pas, si le build du départ est rouge ou si `fn` lève. */
async function atStartSha<T>(c: LotCtx, sha: string, fn: (place: Place) => Promise<T | null>): Promise<T | null> {
  const l = c.lot;
  const dir = mkdtempSync(join(tmpdir(), 'cadence-baseline-'));
  const links: string[] = [];
  try {
    git(l.repo, 'worktree', 'add', '--detach', '-f', dir, sha);
    links.push(...linkIgnored(l.repo, dir));
    // Sur l'hôte `gate.host` quand il y en a un (L403) ; le worktree local reste le lieu du rejeu si la connexion tombe.
    return await withPlace({ config: c.config, repo: l.repo, sha, dir, needClean: false, label: `porte du lot ${l.lot}`, detail: `(ligne de base ${sha.slice(0, 7)})`, local: (cmd) => sh(c, cmd, 30 * 60_000, {}, dir), say: (line) => c.wave.log(`${lotKey(l.project, l.lot)} · ${line}`) }, async (place) => {
      // Le build d'abord, comme dans la porte (L333) : les tests lisent ce qu'il produit (`dist`), le départ sans lui rougirait tout. Un build rouge au départ
      // ne dit rien des tests : rien à rendre, l'appelant garde les tests pour rouges.
      if (c.config.build && (await place.run(c.config.build)).code !== 0) return null;
      return fn(place);
    });
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
async function againstBaseline(c: LotCtx, command: GateTest, ran: GateRan): Promise<VsBase> {
  const now = failedTests(ran.output);
  // Un échec sans test nommé (en chaîne, ou dans une partie rouge, L512) : rien n'est comparable ni excusable, les tests restent rouges.
  if (!now.length || gateUnnamed(ran)) return { kind: 'unknown' };
  const base = await baselineFailures(c, command);
  if (!base?.length) return { kind: 'unknown' };
  const { nouveaux, existants } = compareBaseline(now, base);
  return nouveaux.length ? { kind: 'new', nouveaux, existants: existants.length } : { kind: 'existing', n: existants.length };
}

const shEscape = (s: string) => s.replace(/\s+/g, ' ').replace(/[\\"$`]/g, '\\$&');

/** Commande du projet, asynchrone : la boucle d'événements reste libre (délai de l'autre créneau, signaux). Son groupe est tué au délai et au signal. */
/**
 * PATH des commandes que le programme lance lui-même (porte, ligne de base, démarrage, acceptation, verdict) : le même que celui des sessions,
 * le lien `node-bin/<version>` du .nvmrc du lot en tête (L351). Sans .nvmrc, rien : le PATH hérité reste tel quel.
 */
function nodePath(c: LotCtx): { PATH?: string } {
  const link = c.lot.node?.link;
  return link ? { PATH: [toolBinOf(c.wave.store.dir), link, process.env.PATH ?? ''].filter(Boolean).join(delimiter) } : {};
}

function sh(c: LotCtx, command: string, timeoutMs = 30 * 60_000, env: Record<string, string> = {}, cwd = wd(c)): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...withoutLaunchVars(process.env), ...nodePath(c), ...(c.wave.testWorkers ? { [TEST_WORKERS_ENV]: String(c.wave.testWorkers) } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    const dirty = await commitPlan(c, planMessage(c, PLAN_ACTIONS.started));
    if (dirty) return dirty;
  }
  return null;
}

/** Le lot a déjà du travail (commits citant le lot) dans son dépôt ou dans un dépôt voisin. */
function hasWork(plan: Plan, root: string, l: Pick<LotState, 'repos' | 'lot'>): boolean {
  return lotWork(plan, root, l.lot).length > 0 || (l.repos ?? []).some((r) => repoWork(plan, r, l.lot).length > 0);
}



const minorLine = (source: string, k: { fichier?: string; ligne?: number; texte: string }) => `[mineur ${source}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`;

const withoutLine = (line: string) => line.replace(/^(\[mineur \w+\] .*?):\d+ — /, '$1 — ');

function addProposals(c: LotCtx, rep: ReviewReport, source: string, head: string, withMinors = true): void {
  if (withMinors) for (const k of rep.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine(source, k));
  // La première revue qui émet la proposition en garde la date : une revue suivante qui la redit ne la rajeunit pas.
  for (const t of rep.sousTaches.map((t) => `[sous-tâche ${source}] ${t}`)) propose(c, t, head);
}

function minorConstats(rep: ReviewReport): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'mineur').map((k) => ({ source: 'code', gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

function blockingConstats(rep: ReviewReport, source: 'code' | 'ux'): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'bloquant' || k.gravite === 'majeur').map((k) => ({ source, gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
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

export { precheckNothingToFind };

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
      } else if (rep) rep.lu = undefined; // « non » ou « partiel » du local, accepté sans relecture par Sonnet : sa lecture n'est pas gardée (L523)
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
  if (localYes) l.warnings.push(localYesNote(rep.dejaPresent));
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
  keepPrecheckReading(l, rep.lu);
  l.next = firstWrite(c);
  save(c);
}

/** Le lot passe-t-il par le contrôle préalable ? Un lot qui n'a rien à retrouver (L322) saute l'étape, et le journal du lot le dit. */
function precheckOrSkip(c: LotCtx): boolean {
  const plan = c.loadPlan();
  if (c.lot.express || !needsPrecheck(c.config, plan, c.lot.repo, c.lot.lot, c.lot.repos, c.lot.goal)) return false;
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
  // Une maquette légère n'a pas de règles de comportement à verrouiller : pas d'accept, même si orchestrate.accept est déclaré.
  if (lightLot(l, c.loadPlan().lot(l.lot), c.config.maquette, wd(c), c.config.spec.dir)) return 'implement';
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
  return checkAcceptation(wd(c), json, l.lot, fiche, undefined, { dir: c.config.spec.dir, refsOf: c.loadPlan().refs }).length === 0;
}

/** Chemins salis par une session : suivis modifiés, nouveaux fichiers non suivis, et ceux des dépôts voisins. */
function dirtAfter(done: Done): string[] {
  return [...dirtBetween(done.before, done.after), ...done.others.flatMap((o) => dirtBetween(o.before, o.after).map((f) => `${o.repo.rel}: ${f}`))];
}

/** Suite commune des étapes spec et accept : commits de la session (avertis s'ils ne citent pas le lot), choix reportés, vraies questions (les non-questions deviennent un avertissement). */
function takeReport(c: LotCtx, done: Pick<Done, 'step'>, rep: { choix?: string[]; questions: string[] }): string[] {
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
    git(wd(c), 'commit', '-q', '-m', leadAnswerMessage(planTemplate(c), l.lot, ids, c.wave.id), '--', fiche);
    return false;
  } catch (e) {
    stop(c, 'handed-back', `réponse du lead non reportée dans la fiche ${fiche} : ${(e as Error).message.split('\n')[0]}`);
    return true;
  }
}

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
  addProposals(c, rep, r.kind, summary.head, r.kind !== 'fiche');
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
  out.push(...checkAcceptation(wd(c), json, l.lot, fiche, l.steps.find((s) => s.kind === 'accept')?.headBefore, { dir: c.config.spec.dir, refsOf: c.loadPlan().refs }));
  if (out.length) return out;
  const red = await runAccept(c, json);
  if (red.orphans.length) out.push(`fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept (le dossier de son « cd <dossier> && » initial, sinon le dépôt) : ${red.orphans.join(', ')} — aucun lanceur ne les prendrait`);
  for (const r of red.runs) if (r.code === 0) out.push(`la commande dédiée « ${r.command} » (orchestrate.accept) passe alors que le code n'existe pas : des tests verts avant le code ne prouvent rien — chaque test doit échouer parce que la fonctionnalité manque\n${tail(r.output, 15)}`);
  if (!c.config.test) {
    if (!l.warnings.includes(NO_TEST_ACCEPT)) l.warnings.push(NO_TEST_ACCEPT);
  } else {
    const ordinary = await runGate((cmd) => sh(c, cmd), c.config.test); // porte en parties (L512) : chaque partie dans son dossier, sortie fusionnée
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
  try {
    // Sur l'hôte `gate.host` (L403) quand il y en a un : le HEAD du worktree du lot, s'il est propre ; sinon, ou sans hôte, en local.
    await withPlace({ config: c.config, repo: c.lot.repo, sha: tryGit(wd(c), ['rev-parse', 'HEAD']), dir: wd(c), needClean: true, label: `porte du lot ${c.lot.lot}`, local: (cmd) => sh(c, cmd), say: (line) => c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · ${line}`) }, (place) => runChecks(c, red, runs, place));
  } finally {
    // L395 : la porte se lit dans l'état du lot tant qu'une commande (ou le rejeu qui la suit) tourne, jamais après.
    c.lot.gate = undefined;
    save(c);
  }
}

async function runChecks(c: LotCtx, red: Constat[], runs: CheckRun[], place: Place): Promise<void> {
  const l = c.lot;
  for (const [label, command] of [['build', c.config.build], ['tests', c.config.test]] as const) {
    if (!command) continue;
    l.gate = { label, started: new Date().toISOString() };
    if (label === 'tests') l.suiteRuns = (l.suiteRuns ?? 0) + 1;
    save(c);
    const r = await runGate(place.run, command); // porte en parties (L512) : toutes jouées, chacune dans son dossier ; le CheckRun porte le libellé « dir : run ; … »
    const run: CheckRun = { label, command: gateLabel(command), code: r.code, ...place.stamp() };
    runs.push(run);
    if (r.code === 0) continue;
    const vs: VsBase = label === 'tests' ? await againstBaseline(c, command, r) : { kind: 'unknown' };
    const onlyExisting = (n: number): void => {
      run.dejaRouges = n;
      const note = `${n} test(s) déjà rouge(s) au sha de départ ${(l.baseline?.sha ?? '').slice(0, 7)}, pas un défaut du lot : listés à part, la revue a lieu`;
      if (!l.warnings.includes(note)) l.warnings.push(note);
    };
    if (vs.kind === 'existing') {
      onlyExisting(vs.n);
      continue;
    }
    // Un rouge absent de la ligne de base est rejoué SEUL avant d'être compté (L354) : sous charge, des tests qui passent seuls rougissent ensemble.
    // Sans `orchestrate.testReplay` rien n'est rejoué : le rouge est compté tel quel et rien n'est tenu pour instable (L354).
    const named = label !== 'tests' || !gateReplayable(c.config.test, c.config.testReplay) ? [] : vs.kind === 'new' ? vs.nouveaux : redCandidates(r);
    const { red: still, unstable, tight } = named.length ? await replayGate(place.run, c.config.testReplay, named, r) : { red: [] as string[], unstable: [] as string[], tight: [] as TightTest[] };
    if (unstable.length) {
      noteUnstable(c, unstable.filter((t) => !tight.some((k) => k.test === t)));
      noteTight(c, tight);
      run.instables = unstable;
    }
    if (unstable.length && !still.length) {
      if (vs.kind === 'new' && vs.existants) run.dejaRouges = vs.existants;
      else run.code = 0;
      continue;
    }
    // L510 : un rouge qui reste rouge seul dans le lot mais que la suite entière du départ avait vu vert (ordre, charge) peut être rouge seul au départ aussi : déjà rouge, ni correction ni escalade.
    const atStart = still.length ? await redAtStart(c, still, r) : [];
    if (atStart.length) {
      const note = `${atStart.length} test(s) déjà rouge(s) au sha de départ ${startSha(c)?.slice(0, 7)} (rouge(s) seuls aussi, absent(s) de la ligne de base), pas un défaut du lot : ${atStart.join(' ; ')}`;
      if (!l.warnings.includes(note)) l.warnings.push(note);
      if (atStart.length === still.length) {
        run.dejaRouges = atStart.length + (vs.kind === 'new' ? vs.existants : 0);
        continue;
      }
    }
    const fresh = still.filter((t) => !atStart.includes(t));
    const alone = unstable.length ? `\n(${unstable.length} test(s) rouge(s) sous charge, verts rejoués seuls : instables, à ne pas corriger)` : '';
    if (vs.kind === 'new') {
      const left = vs.nouveaux.filter((t) => !unstable.includes(t) && !atStart.includes(t));
      red.push({ source: 'tests', gravite: 'bloquant', texte: `${run.command} en échec (code ${r.code}) : ${left.length} test(s) rouge(s) qui ne l'étaient pas au sha de départ :\n${left.map((t) => `- ${t}`).join('\n')}${vs.existants ? `\n(${vs.existants} autre(s) test(s) déjà rouge(s) au sha de départ : à ne pas corriger)` : ''}${alone}` });
      return;
    }
    // Des instables sont écartés : la sortie de la suite entière les montre encore en FAIL, le constat ne nomme que ceux qui restent rouges.
    const shown = unstable.length || atStart.length ? `${fresh.length} test(s) rouge(s) après rejeu seul :\n${fresh.map((t) => `- ${t}`).join('\n')}` : r.output.trim().split('\n').slice(-40).join('\n');
    red.push({ source: 'tests', gravite: 'bloquant', texte: `${run.command} en échec (code ${r.code}) :\n${shown}${alone}` });
    return;
  }
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

/** Violations du verrou des tests d'acceptation (L173) par les commits faits depuis `head` ; aucune sans HEAD de départ. */
const sealedViolations = (c: LotCtx, head: string | undefined): string[] => (head ? lockViolations(wd(c), c.config.spec.dir, head, { rouge: c.lot.accept?.rouge ? { [c.lot.accept.acceptation]: c.lot.accept.rouge } : {}, lot: c.lot.lot, lotBase: c.lot.steps.find((s) => s.headBefore)?.headBefore, lotStart: lotStartHead(wd(c), lotWork(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha)), lotCommits: lotCommits(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha) }) : []);

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
  const locked = sealedViolations(c, done.step.headBefore);
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
  // Même règle côté fix (L56) : la passe n'avait rien à ajouter, le lot a déjà ses commits de travail → revue neuve, à condition que la session donne sa raison (L406, plus bas) ; la passe reste consommée, MAX_PASSES borne la boucle.
  const alreadyDone = hasWork(plan, wd(c), l);
  if (made === 0 && !alreadyDone && !headMoved) {
    stop(c, 'handed-back', `${kind} sans commit`);
    return;
  }
  // L406 : une correction qui ne commite rien doit dire pourquoi (« choix », lu par la revue). Sans raison, la revue relirait les mêmes commits et rendrait les mêmes constats : la passe ne compte pas (toFix l'avait comptée), le lot est rendu.
  const reason = (rep.choix ?? []).some((x) => x.trim()) || !!done.step.answered; // la réponse du lead, que la session a lue dans son brief, vaut raison
  if (kind === 'fix' && made === 0 && !headMoved && !docsPass && !reason) {
    l.pass = Math.max(0, l.pass - 1);
    stop(c, 'handed-back', 'fix sans commit ni raison (choix vide) : la revue aurait relu les mêmes commits');
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
  else if (made === 0) l.warnings.push(kind === 'fix' ? 'fix sans nouveau commit : revue lancée sur les commits du lot, avec la raison de la session (choix)' : `${kind} sans nouveau commit : revue lancée sur les commits déjà faits du lot`);

  const red: Constat[] = [];
  // Tests annoncés rouges (L213) : avec orchestrate.test, le programme rejoue et compare à la ligne de base, la session n'est crue que si les tests y sont rouges autrement que par des échecs de départ, et jamais quand sa porte est verte (L522, quels que soient echecsDeBase et nouveauxEchecs) ; sans, la liste des échecs de base de la session, non vérifiée.
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
  if (deferred && red.length === 0 && runs.some((r) => r.label === 'tests' && r.code === 0 && !r.instables?.length)) l.warnings.push(`tests annoncés rouges par la session, mais la porte du programme verte (${gateLabel(c.config.test ?? '')}, code 0) : l'annonce n'est pas crue, pas de correction`);
  else if (deferred && red.length === 0 && !runs.some((r) => r.label === 'tests' && (r.dejaRouges || r.instables?.length))) red.push(claimed);
  if (red.length) {
    toFix(c, red, 'tests rouges');
    return;
  }
  // Porte « code modifié sans test » (L287) : le diff du lot (son dépôt et ses voisins, fichiers supprimés exclus), toutes sessions comprises, touche du code sans fichier de test → correction directe, sans session de revue. Une seule fois par lot, jamais pendant la passe des mineurs, ni quand la correction prendrait la dernière passe (la revue n'en aurait plus), ni quand le budget du lot ne paie plus la correction (la revue, elle, part toujours).
  const gate = c.config.testGate;
  if (gate && !l.testGate && !minorsPass && !l.express) {
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
  // Sonde de cas limites (L497) : une fois par lot, après la porte « code sans test », avant le bibliothécaire et la revue.
  if (scheduleProbe(c.config, l, { skip: minorsPass || !alreadyDone, late: l.pass >= MAX_PASSES - 1, pays: fixAffordable(l, false, PROBE_RESERVE), count: budgetCount(l) })) {
    // Les contrôles de la porte restent au lot pendant la sonde : sans nouveau commit de sa part, la revue les reprend pour ce HEAD.
    l.checks = runs.length ? { head: git(wd(c), 'rev-parse', 'HEAD'), tree: git(wd(c), 'rev-parse', 'HEAD^{tree}'), runs } : undefined;
    return save(c);
  }
  await toReview(c, runs, minorsPass);
}

/** Fin d'une écriture dont les portes sont passées : le bibliothécaire (L306), puis la première revue. Aussi la suite d'une sonde (L497) qui n'a rien à corriger. */
async function toReview(c: LotCtx, runs: CheckRun[], minorsPass: boolean): Promise<void> {
  const l = c.lot;
  // Bibliothécaire (L306) : docs.sync signale un document en retard sur les commits du lot → une passe doc-keeper avant la revue, une seule fois par lot, aux mêmes conditions de passe et de budget que la porte « code sans test ». Si elle ne touche pas le document, la revue part et porte l'écart (brief docs.sync, constat majeur).
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
  // Voie express (L519) : pas de revue séparée, le lead lit le diff ; le lot conclut sur le HEAD que la porte du programme vient de jouer.
  if (l.express) return conclude(c, expressSummary(git(wd(c), 'rev-parse', 'HEAD')));
  l.checks = runs.length ? { head: git(wd(c), 'rev-parse', 'HEAD'), tree: git(wd(c), 'rev-parse', 'HEAD^{tree}'), runs } : undefined;
  l.next = firstReview(c);
  save(c);
}

/** Ce que la sonde (probe.ts) emprunte au cycle. */
const probeIo = (c: LotCtx): ProbeIo<Done> => ({
  lot: c.lot, config: c.config, cwd: wd(c), play: () => session(c, 'probe'), take: (step, rep) => takeReport(c, { step }, rep), sealed: (head) => sealedViolations(c, head), dirt: dirtAfter, gate: (red, runs) => programChecks(c, red, runs),
  fix: (constats) => toFix(c, constats, 'sonde de cas limites'), review: (runs) => toReview(c, runs, false), handBack: (why) => void stop(c, 'handed-back', why), pays: () => fixAffordable(c.lot), head: () => git(wd(c), 'rev-parse', 'HEAD').trim(),
});

/** Mention « sans commit » du verdict quand la passe des mineurs n'a rien commité (l'UX finale conclut alors à la place de la passe). */
const noCommitNote = (l: LotState): string => (l.warnings.some((w) => w.startsWith('passe des mineurs sans commit')) ? ' sans commit' : '');

/** Revue de code qui clôt le cycle : complète, ou courte une fois la passe des mineurs jouée. */
const codeReview = (l: LotState): SessionKind => (l.minorPass ? 'review-small' : 'review');

/** Note d'un lot que sa session a rendu `visible` après le lancement de la vague (L454) : son verdict UX n'existe pas encore, le lead le sait. */
const VISIBLE_ADDED = 'visible ajouté en cours de vague, étape UX à jouer';

/**
 * Relit `visible` dans le plan du worktree après une session d'écriture (L454) : un lot que sa session a rendu visible (warhammer L37 et L43,
 * 30-10) est lancé non visible, et sortait « prêt » sans étape UX. Il le devient dans l'état du lot, donc l'UX est jouée (`uxAfterReview`, ou la
 * revue courte d'un petit lot) ; sans application déclarée, il est rendu avec la note. Un plan illisible, ou un lot qui n'est plus visible
 * dans le plan, laisse l'état tel quel (retirer `visible` en cours de vague n'est pas traité).
 */
function addedVisible(c: LotCtx): void {
  const l = c.lot;
  if (l.visible) return;
  let now: boolean;
  try {
    now = (wd(c) === l.repo ? c.loadPlan() : planLoader(wd(c))()).lot(l.lot).visible;
  } catch {
    return;
  }
  if (!now) return;
  l.visible = true;
  if (!c.config.ux) l.uxNote = `${VISIBLE_ADDED} (aucune application déclarée : cadence.yaml orchestrate.ux)`;
  c.wave.log(`${lotKey(l.project, l.lot)} · ${VISIBLE_ADDED}`);
}

/**
 * Première étape après un travail d'écriture (L221) : la revue de code, jamais l'UX. La revue UX d'un lot visible est jouée une seule fois,
 * après la dernière revue de code conforme (`uxAfterReview`), sur le code qui sera livré.
 */
function firstReview(c: LotCtx): SessionKind {
  const l = c.lot;
  addedVisible(c);
  if (l.small) return l.visible || l.minorPass ? 'review-small' : 'review'; // passe unique code + ergonomie ; sans écran, une revue de code
  if (l.visible && !c.config.ux && !l.uxNote?.startsWith(VISIBLE_ADDED)) l.uxNote = 'UX à faire par le lead (aucune application déclarée : cadence.yaml orchestrate.ux)';
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
    addProposals(c, rep, 'ux', summary.head);
    l.uxVerdict = summary.verdict;
    l.constats = blockingConstats(rep, 'ux');
    save(c);
    // L'UX est la dernière étape (L221) : conforme, le lot conclut avec la revue de code ; sinon une correction (jamais une revue de code d'office), la revue de code et l'UX rejouée suivent.
    if (summary.conforme) return () => conclude(c, l.code!, noCommitNote(l));
    if (handBackWithoutFinding(c, l.constats, summary, stop)) return;
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
  addProposals(c, rep, 'code', summary.head, !minorPass);
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
  if (handBackWithoutFinding(c, constats, summary, stop)) return;
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
    const before = planBefore(c);
    plan.recordReview(l.lot, verdict, c.wave.today, commit, neighbours.length ? shas : undefined, reporte);
    for (const k of covered) plan.setStatus(`${l.lot}/${k.task}`, 'done', c.wave.today);
    if (covered.length) l.warnings.push(`sous-tâches closes (couvertes par des commits qui les citent, revue conforme) : ${covered.map((k) => `${l.lot}/${k.task} (${k.sha.slice(0, 7)})`).join(', ')}`);
    try {
      plan.save();
    } catch (e) {
      if (e instanceof RafError) return e.message;
      throw e;
    }
    const dirty = await commitPlan(c, planMessage(c, PLAN_ACTIONS.reviewRecorded), l.repo, before);
    if (dirty) return dirty;
  } else {
    for (const k of covered) propose(c, `[sous-tâche clore] ${l.lot}/${k.task} — couverte par ${k.sha.slice(0, 7)}, revue conforme : à clore avant raf done`);
  }
  if (plan.readonly && c.config.verdict) {
    // La trace d'un verdict reporté va dans le texte, le seul endroit où l'outil du projet la lit (R23).
    const text = reporte ? `${verdict} ; verdict reporté : ${reporte.de.slice(0, 7)} → ${reporte.vers.slice(0, 7)} (patch-id identique)` : verdict;
    const before = planBefore(c);
    const r = await sh(c, c.config.verdict.replaceAll('{lot}', l.lot).replaceAll('{verdict}', shEscape(text)), undefined, undefined, l.repo);
    if (r.code !== 0) l.warnings.push(`orchestrate.verdict en échec (code ${r.code}) : le lead reporte le verdict`);
    else {
      const dirty = await commitPlan(c, planMessage(c, PLAN_ACTIONS.reviewNoted), l.repo, before);
      if (dirty) return dirty;
    }
  }
  return null;
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
      // Le verdict de départ et le commit relu servent à chaque tour : un rebase rejoué repart d'eux, pas des traces ni du sommet du tour précédent.
      const opening = verdict;
      const reviewed = l.code?.head ?? git(t.dir, 'rev-parse', 'HEAD');
      for (let replays = 0; ; replays++) {
        verdict = opening;
        reporte = undefined;
        const rebased = rebaseOnto(t.dir, t.base);
        if (rebased.kind === 'conflict') {
          return refuse(`intégration impossible : conflit en rebasant ${t.branch} sur ${t.base}${rebased.files.length ? ` (fichiers : ${rebased.files.join(', ')})` : ` (${rebased.detail})`} ; ${kept}`);
        }
        if (rebased.kind === 'rebased') rebaseNotes(rebased, key).forEach((note) => c.wave.log(note));
        const tip = git(t.dir, 'rev-parse', 'HEAD');
        if (tip !== reviewed) {
          // Le rebase a changé les commits : tests et build rejoués au sommet rebasé, avant que la branche du dépôt ne bouge (R7).
          const { red, runs } = await integratedChecks(c, key);
          l.checks = runs.length ? { head: tip, tree: git(t.dir, 'rev-parse', 'HEAD^{tree}'), runs } : undefined;
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
        try {
          advance(l.repo, t.branch);
          break;
        } catch (e) {
          // L364 : un commit est tombé sur la branche du dépôt pendant le rebase, les contrôles ou la revue courte (plan du lead, autre lot) : l'avance n'est plus une avance rapide.
          if (!baseMoved(l.repo, t.branch, t.base)) throw e;
          if (replays >= MAX_REPLAYS) return refuse(`intégration refusée : ${t.base} a encore avancé après ${MAX_REPLAYS} rebases rejoués ; branche du dépôt inchangée par le lot, ${kept}`);
          c.wave.log(`${key} ${t.base} a avancé pendant l'intégration, rebase rejoué (${replays + 1}/${MAX_REPLAYS})`);
        }
      }
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
      else if (kind === 'probe') await probeStep(probeIo(c));
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
