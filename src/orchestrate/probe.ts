// Sonde de cas limites (L497, `orchestrate.probe`) : entre l'écriture du lot et sa revue, une session Sonnet neuve cherche à casser le diff par des tests aux bornes.
// Le cycle (cycle.ts) lui prête ses mécanismes par `ProbeIo` : budget, session, porte du programme, passe de correction, revue.
import type { OrchestrateConfig } from '../config.js';
import { docSyncSet, filesOf } from '../docsync.js';
import { DEFAULT_TEST_PATTERNS } from '../testgate.js';
import { readCommits } from '../git.js';
import type { BriefVars } from './briefs.js';
import { checkShape, PROBE_SCHEMA, type ProbeReport } from './schemas.js';
import type { Constat, LotState, StepState } from './state.js';

/** Rendu par la session de la sonde quand elle n'a rien donné (échec, coupure, délai) : la sonde ne bloque jamais le lot, un warning et la revue part. */
export const PROBE_FAILED = Symbol('probe-failed');

/**
 * Coût réservé à la sonde en plus de la correction et de la revue qui la suit : une session Sonnet d'écriture. ESTIMATION, aucune mesure (la sonde n'a pas encore joué) :
 * le p90 d'une passe fix Sonnet, 65 k tokens comptés (mesure du 2026-10-15, voir REVIEW_RESERVE). À remesurer sur les premières sondes (`cadence perf`, étape probe).
 */
export const PROBE_RESERVE = 65_000;

/** Préfixe du texte d'un constat de la sonde : il distingue, dans le journal, la passe de correction qu'elle déclenche. */
const PROBE_FINDING = 'sonde de cas limites : ';

/** Ce que le cycle sait du moment : la sonde ne joue pas pendant la passe des mineurs ni sans commit (`skip`), ni quand une passe est déjà faite (`late`) ou que le budget ne paie pas la suite (`pays`). */
interface ProbeMoment {
  skip: boolean;
  late: boolean;
  pays: boolean;
  count: string;
}

/**
 * Décide la sonde d'un lot (R3, R6) : vrai quand elle est la prochaine étape. Décidée une seule fois par lot (`l.probe`), jouée ou écartée avec un warning qui dit pourquoi.
 * Sans la clé `orchestrate.probe`, rien : ni champ ni warning.
 */
export function scheduleProbe(config: Pick<OrchestrateConfig, 'probe'>, l: LotState, o: ProbeMoment): boolean {
  if (!config.probe || l.probe || o.skip || l.express) return false;
  l.probe = true;
  if (!o.late && o.pays) {
    l.next = 'probe';
    return true;
  }
  l.warnings.push(`sonde de cas limites non jouée : ${l.pass} passe(s) de correction déjà faite(s) ou budget du lot (${o.count}) insuffisant`);
  return false;
}

/** Les variables du brief de la sonde : la fiche du lot quand il en a une, ses commits, et la commande du diff (jamais le diff collé). */
export function probeVars(fiche: string | null, commits: string, from: string | undefined, lot: string): Pick<BriefVars, 'fiche' | 'commits' | 'diff'> {
  return {
    fiche: fiche ? `The lot has a spec sheet: \`${fiche}\`. Read it first: each of its rules (Rn) states a behaviour to attack, and its contracts give the exact errors the code must raise.` : '',
    commits,
    diff: from ? `git diff ${from}..HEAD` : `git log -p --reverse --grep=${lot}`,
  };
}

/** Ce que la session de la sonde a rendu au cycle. */
interface ProbeDone {
  step: StepState;
  report: unknown;
}

/** Un contrôle du programme (commande et code de sortie), tel que le lot le garde pour la revue. */
type CheckRun = NonNullable<LotState['checks']>['runs'][number];

export interface ProbeIo<D extends ProbeDone> {
  lot: LotState;
  config: Pick<OrchestrateConfig, 'test' | 'testGate'>;
  /** Dossier de travail du lot. */
  cwd: string;
  /** La session : `null` quand le lot est suspendu ou rendu, `PROBE_FAILED` quand elle n'a rien donné. */
  play(): Promise<D | null | typeof PROBE_FAILED>;
  /** Commits de la session au journal, choix repris, questions : rend les vraies questions. */
  take(step: StepState, rep: { choix?: string[]; questions: string[] }): string[];
  /** Violations du verrou des tests d'acceptation depuis `head`. */
  sealed(head: string | undefined): string[];
  /** Fichiers laissés sales par la session. */
  dirt(done: D): string[];
  /** La porte du programme (build puis tests) : ajoute les rouges nouveaux à `red` et chaque contrôle à `runs`. */
  gate(red: Constat[], runs: CheckRun[]): Promise<void>;
  /** La passe de correction ordinaire, avec ces constats. */
  fix(constats: Constat[]): void;
  /** La suite du cycle quand rien ne reste à corriger : bibliothécaire, puis revue. */
  review(runs: CheckRun[]): Promise<void>;
  handBack(why: string): void;
  /** Le budget paie-t-il la correction et la revue qui la suit ? */
  pays(): boolean;
  head(): string;
}

const unplayed = (l: LotState, why: string): number => l.warnings.push(`sonde de cas limites non jouée : ${why}`);

/** Le rapport de la session, ou un warning « non jouée » quand il est illisible (la revue part quand même). */
function readReport(l: LotState, report: unknown): ProbeReport | undefined {
  try {
    return checkShape<ProbeReport>(report, PROBE_SCHEMA);
  } catch (e) {
    unplayed(l, (e as Error).message);
    return undefined;
  }
}

/** Les fichiers commités par la sonde qui ne sont pas des tests (R8) : un warning les nomme, rien n'est retiré. Sans `testGate.tests` déclaré, rien ne distingue un test d'un autre ; un fichier de test à toute profondeur (`DEFAULT_TEST_PATTERNS` : `*.test.*`, `tests/`, `__tests__/`) en est un même si la porte ne le déclare pas (sous-paquet). */
function warnOutsideTests(io: ProbeIo<ProbeDone>, headBefore: string | undefined): void {
  const tests = io.config.testGate?.tests;
  if (!tests) return;
  const isTest = docSyncSet([...tests, ...DEFAULT_TEST_PATTERNS]);
  const outside = [...filesOf(io.cwd, readCommits(io.cwd, { range: headBefore ? `${headBefore}..HEAD` : undefined }))].filter((f) => !isTest(f)).sort();
  if (outside.length) io.lot.warnings.push(`sonde de cas limites : la session a modifié du code hors tests (${outside.join(', ')})`);
}

/** Les contrôles faits après une session qui a commité, avec ou sans rapport : verrou, dépôt propre (`dirt`), fichiers hors tests. Vrai quand le lot est rendu. */
function handedBack<D extends ProbeDone>(io: ProbeIo<D>, dirt: string[], headBefore: string | undefined): boolean {
  const locked = io.sealed(headBefore);
  const why = locked.length ? `verrou des tests d'acceptation : ${locked.join(' ; ')}` : dirt.length ? `dépôt sale après probe : ${dirt.join(', ')}` : '';
  if (why) io.handBack(why);
  else warnOutsideTests(io, headBefore);
  return !!why;
}

/**
 * Les constats de la sonde (R4, R5) : les rouges NOUVEAUX de la porte du programme (jamais un échec déjà rouge au départ), en gravité majeure, avec ce que la session annonce
 * (« test — borne — attendu ») pour que la correction voie la borne. Sans `orchestrate.test`, les échecs annoncés tels quels, dits non vérifiés par le programme.
 */
function findings(l: LotState, red: Constat[], claimed: string[], gated: boolean): Constat[] {
  const said = claimed.length ? `\nLa sonde annonce : ${claimed.join(' ; ')}` : '';
  const out = red.map((k): Constat => ({ ...k, gravite: 'majeur', texte: `${PROBE_FINDING}${k.texte}${said}` }));
  if (gated || !claimed.length) return out;
  l.warnings.push('sonde de cas limites : échecs annoncés par la session, non vérifié par le programme (orchestrate.test absent)');
  return [...out, ...claimed.map((e): Constat => ({ source: 'tests', gravite: 'majeur', texte: `${PROBE_FINDING}${e}` }))];
}

/**
 * Joue la sonde (R3 à R9). Elle ne bloque jamais le lot : échec, coupure, délai ou rapport illisible sont un warning et la revue part. Seuls un quota (suspension : la reprise rejoue la sonde),
 * un verrou d'acceptation violé ou un dépôt sale le rendent, comme après toute session d'écriture. Un test rouge nouveau repart en correction ; sinon le cycle reprend (bibliothécaire, revue).
 */
export async function probeStep<D extends ProbeDone>(io: ProbeIo<D>): Promise<void> {
  const l = io.lot;
  const done = await io.play();
  if (!done) return;
  const step = l.steps[l.steps.length - 1]!;
  const rep = done === PROBE_FAILED ? cutSession(io, step) : readSession(io, done, step);
  if (rep === 'rendu') return;
  // La porte du programme après la sonde comme après toute écriture, mais seulement si elle a commité : sans nouveau commit il n'y a rien de neuf à rejouer.
  const red: Constat[] = [];
  const runs: CheckRun[] = [];
  const moved = !!step.headBefore && io.head() !== step.headBefore;
  if (moved) await io.gate(red, runs);
  const found = moved ? findings(l, red, (rep?.echecs ?? []).map((e) => e.trim()).filter(Boolean), !!io.config.test) : [];
  if (found.length) {
    // Une correction que le budget ne paie plus n'est pas sautée : l'étape fix refuse et le lot revient au lead sans revue, tests rouges (L145, cycle.ts overBudget).
    if (io.pays()) l.warnings.push(`${PROBE_FINDING}${found.length} constat(s), passe de correction avant la revue`);
    step.constats = found.map((k) => k.texte);
    io.fix(found);
    return;
  }
  // Sans nouveau commit, les contrôles de la porte jouée après l'écriture valent toujours pour ce HEAD : la revue les garde (sinon elle relance la suite et le build).
  await io.review(moved ? runs : [...(l.checks?.runs ?? [])]);
}

/** La session n'a rien donné (échec, coupure, délai) : un warning, pas de rapport. Ce qu'elle a commité avant d'être coupée passe les mêmes contrôles qu'après un rapport (commits au journal, verrou, fichiers hors tests) ; le dépôt a déjà été remis propre. */
function cutSession<D extends ProbeDone>(io: ProbeIo<D>, step: StepState): undefined | 'rendu' {
  unplayed(io.lot, step.cause ?? 'échec');
  if (!step.headBefore || io.head() === step.headBefore) return undefined;
  io.take(step, { questions: [] });
  return handedBack(io, [], step.headBefore) ? 'rendu' : undefined;
}

/** Le rapport d'une session qui a répondu : questions notées, verrou et dépôt contrôlés. `'rendu'` quand le lot est rendu. */
function readSession<D extends ProbeDone>(io: ProbeIo<D>, done: D, step: StepState): ProbeReport | undefined | 'rendu' {
  const rep = readReport(io.lot, done.report);
  for (const q of io.take(step, rep ?? { questions: [] })) io.lot.warnings.push(`sonde de cas limites : question sans réponse (la sonde ne bloque pas le lot) : « ${q.trim()} »`);
  return handedBack(io, io.dirt(done), step.headBefore) ? 'rendu' : rep;
}
