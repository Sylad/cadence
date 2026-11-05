import { type LotCtx, stop, workDir as wd, save, transition } from './cycle/ctx.js';
import { isOpen } from '../plan.js';
import { sh } from './cycle/sh.js';
import { commitPlan, planMessage, planWrite, trackedPaths } from './cycle/plan-writes.js';
import { PLAN_ACTIONS } from '../plan-commit.js';
import { lotKey } from './state.js';
import { prepareTree } from './worktree.js';
import { dropped, DROPPED, halted, suspend } from './cycle/budget.js';
import { resealedRouge } from './accept.js';
import { waveCommits } from './cycle/shared.js';
import { snapshot, cleanPlaywrightOutput } from './guard.js';
import { toFix, firstReview, review } from './cycle/review.js';
import { firstWrite, settleHypotheses, specStep, ficheStep, maquetteStep } from './cycle/spec-steps.js';
import { precheckOrSkip, precheck } from './cycle/precheck-step.js';
import { notePartage } from './cycle/partage-step.js';
import { noteMaquetteSautee } from './cycle/retreci.js';
import { acceptStep } from './cycle/accept-step.js';
import { work, probeIo } from './cycle/work.js';
import { probeStep } from './probe.js';
import { integrateLot } from './cycle/integrate-lot.js';

/** Façade (C1a, L490 ; C1b, L491 ; C1c, L492) : le contexte, le budget, le brief, les écritures du plan, la session et les étapes vivent dans `cycle/` ; les noms publics restent exportés d'ici. */
export { MAX_PASSES, MAX_PASSES_CONVERGING, Budget, countInterrupted, workDir } from './cycle/ctx.js';
export type { WaveCtx, LotTree, LotCtx } from './cycle/ctx.js';
export { lotSpent, ESCALATION_RESERVE, heldForEscalation, REVIEW_RESERVE, budgetStep, STOP_REQUESTED, DROPPED } from './cycle/budget.js';
export { HYPOTHESES_HANDBACK, planNoteHandBack, leadReviewedHandBack } from './cycle/plan-writes.js';
export { briefName } from './cycle/brief.js';
export { precheckNothingToFind } from './precheck.js';
export { needsPrecheck } from './cycle/precheck-step.js';
export { redExcerpt } from './cycle/checks.js';
export type { Reporte } from './cycle/integrate-lot.js';
export { isNonQuestion, handBackDroppedQuestions } from './cycle/questions.js';

const TERMINAL = new Set(['ready', 'handed-back', 'failed']);

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
        notePartage(c);
        noteMaquetteSautee(c);
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