import { type LotState, lotKey, type Constat } from '../state.js';
import { type SessionKind } from '../launch.js';
import { type LotCtx, workDir as wd, MAX_PASSES_CONVERGING, MAX_PASSES, stop, save, propose } from './ctx.js';
import { planLoader } from '../../config.js';
import { fixAffordable, lotSpent, halted, suspend } from './budget.js';
import { type AppState, startApp, APP_TIMEOUT_S } from '../app.js';
import { git } from '../worktree.js';
import { mutexFor } from '../mutex.js';
import { gitCommonDir } from '../../git.js';
import { join } from 'node:path';
import { conclude } from './integrate-lot.js';
import { session, badReport } from './session.js';
import { type ReviewReport, checkShape, REVIEW_SCHEMA } from '../schemas.js';
import { addProposals, blockingConstats, minorConstats, minorLine } from './shared.js';
import { settleMinorProposals } from './minor-proposals.js';
import { countReview, wallReason } from './converge.js';
import { readShrunk } from './retreci.js';
import { handBackWithoutFinding } from '../no-finding.js';
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
export function firstReview(c: LotCtx): SessionKind {
  const l = c.lot;
  addedVisible(c);
  if (l.small) return l.visible || l.minorPass ? 'review-small' : 'review'; // passe unique code + ergonomie ; sans écran, une revue de code
  if (l.visible && !c.config.ux && !l.uxNote?.startsWith(VISIBLE_ADDED)) l.uxNote = 'UX à faire par le lead (aucune application déclarée : cadence.yaml orchestrate.ux)';
  return codeReview(l);
}

/** La revue de code conforme d'un lot visible non petit est-elle suivie de la revue UX ? Sans `orchestrate.ux`, le lot conclut (note « UX à faire par le lead »). */
export const uxAfterReview = (c: LotCtx): boolean => !c.lot.small && c.lot.visible && !!c.config.ux;

/** Les passes que déclenche un contrôle du programme, sans revue : elles ne font pas passer la revue d'un lot léger à Opus (L565). */
const PROGRAM_FIXES: ReadonlySet<string> = new Set(['tests rouges', 'code sans test', 'documentation en retard', 'sonde de cas limites']);

const countProgramFix = (l: LotState, what: string): void => {
  if (PROGRAM_FIXES.has(what)) l.programFixes = (l.programFixes ?? 0) + 1;
};

/**
 * LISTE BLANCHE des rendus que le lead peut reprendre par `--add` après un correctif (L563) : les six `what` de `toFix` au plafond de passes. `finDeCycleOutcome` écrit l'outcome
 * avec elle, `addableHandBack` (geste.ts) la lit : la liste de l'écrivain et celle du lecteur sont la même. Un outcome qui n'en commence pas par l'un n'est jamais ajoutable.
 */
export const FIN_DE_CYCLE_WHATS = ['revue non conforme', 'tests rouges', 'code sans test', 'documentation en retard', 'sonde de cas limites', 'UX non conforme'] as const;

/** Le début de l'outcome d'un lot rendu au plafond de passes (`<what> après <N> passe(s) de correction`) : `toFix` l'écrit, `addableHandBack` le reconnaît par `<what> après `. */
export const finDeCycleOutcome = (what: string, pass: number): string => `${what} après ${pass} passe(s) de correction`;

/**
 * Lot rendu alors que l'escalade est engagée (plafond de passes, ou plafond de mur L622) : la revue neuve a jugé, l'issue « rendu » et sa ligne de journal sont
 * posées une fois, comme sans plafond — `table.ts` et `perf.ts` les lisent (sinon « le modèle ne l'a pas jugé » alors qu'il a jugé). Une escalade déjà conforme garde son issue.
 */
function handBackEscalated(c: LotCtx, text: string): void {
  const l = c.lot;
  const e = l.escalation!;
  if (!e.issue) {
    e.issue = 'rendu';
    c.wave.log(`${lotKey(l.project, l.lot)} · escalade ${e.model} : lot rendu malgré l'escalade`);
  }
  stop(c, 'handed-back', `${text} ; ${e.issue === 'conforme' ? `escalade ${e.model} déjà jouée` : `rendu malgré l'escalade ${e.model}`}`);
}

/** Une passe de correction de plus, ou la main rendue au lead quand les deux sont faites. */
export function toFix(c: LotCtx, constats: Constat[], what: string): void {
  const l = c.lot;
  l.constats = constats;
  // Revue qui converge (L205) : un seul constat bloquant ou majeur reste, après une baisse d'une revue à l'autre → une passe de plus (budget : fixAffordable, à l'entrée de la session).
  const counts = l.reviewCounts ?? [];
  const converging = what === 'revue non conforme' && counts.length >= 2 && counts[counts.length - 1] === 1 && counts[counts.length - 1] < counts[counts.length - 2];
  const cap = converging ? MAX_PASSES_CONVERGING : MAX_PASSES;
  // Plafond de mur (L622) : deux fois la durée attendue de l'estimate ; au-delà, le lot est rendu avec ses constats (l.constats, posés plus haut), même pour un bloquant.
  const overWall = wallReason(c, Date.now());
  if (overWall || l.pass >= cap) {
    const text = overWall ? `${finDeCycleOutcome(what, l.pass)} ; ${overWall}` : finDeCycleOutcome(what, l.pass);
    const esc = c.config.escalation;
    // Escalade (L337) : une seule fois, pour une revue de code non conforme ou des tests rouges (l'UX garde sa règle) ; déjà engagée, le lot est rendu — au plafond de mur aussi.
    if (l.escalation) return handBackEscalated(c, text);
    if (overWall || !esc || (what !== 'revue non conforme' && what !== 'tests rouges')) {
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
  countProgramFix(l, what);
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
export async function review(c: LotCtx, kind: 'ux' | 'review' | 'review-small'): Promise<void> {
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
  // Revue de code de rang 2 ou plus (L622) : un majeur marqué `inchange: true` va en suite pour le lead et ne compte plus ; un bloquant compte toujours. Le rang est celui de la revue de code (l'UX n'a pas de marque).
  const { counted, summary, aside, decisions } = countReview(rep, kind, l, done.after.head ?? '', { repoHeads: done.others.length ? Object.fromEntries(done.others.map((o) => [o.repo.rel, o.after.head ?? ''])) : undefined, shrunk: kind === 'ux' ? undefined : readShrunk(c) });
  done.step.constatsRevue = decisions; // L638 : texte, rang et décision L622 de chaque constat, relus par `cadence perf` (écrit par les `save` qui suivent)
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
  // Les constats de cette revue (sans les majeurs mis de côté) attendent la revue de code suivante (L622) : son brief les montre, et une marque `inchange` sur l'un d'eux est fausse.
  l.codeConstats = [...blockingConstats(counted, 'code'), ...minorConstats(counted)];
  for (const a of aside) propose(c, a.line);
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
  // Les mineurs comptés (`counted`) : un mineur qui reprend une attente hors règle de la sonde n'ouvre pas la passe des mineurs (L625).
  const minors = minorConstats(counted);
  // Revue conforme avec mineurs : une seule passe de correction des mineurs, avant de conclure (rien sous le tapis).
  // Budget épuisé : la passe n'aurait aucune session pour la jouer, les mineurs sont rendus en propositions ; la revue conforme conclut le lot,
  // sauf un lot visible avec orchestrate.ux, qui passe à next = 'ux' puis reste suspendu tant que le budget de la vague l'est.
  const wanted = summary.conforme && !l.minorPass && !l.light && minors.length > 0; // lot léger : les mineurs restent des notes (L108)
  const noBudget = wanted && (w.budget.exhausted || !fixAffordable(l)) && !w.incident && !w.quota.hit;
  const minorPass = wanted && !noBudget;
  if (noBudget) l.warnings.push(`${w.budget.exhausted ? 'budget atteint' : 'budget du lot trop juste pour payer la correction et la revue courte qui la suivrait'} : la passe des mineurs n'a pas eu lieu, mineurs rendus en propositions`);
  settleMinorProposals(l, minorPass, summary.conforme);
  addProposals(c, counted, 'code', summary.head, !minorPass);
  if (summary.conforme) (l.reviewCounts ??= []).push(0); // une revue conforme compte pour 0 dans la comparaison de la convergence (L205)
  if (minorPass) {
    l.minorPass = true;
    l.minorPassAt = l.pass;
    l.minorLines = counted.constats.filter((k) => k.gravite === 'mineur').map((k) => minorLine('code', k));
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
  const constats = blockingConstats(counted, 'code');
  if (handBackWithoutFinding(c, constats, summary, stop)) return;
  (l.reviewCounts ??= []).push(constats.length);
  toFix(c, constats, 'revue non conforme');
}