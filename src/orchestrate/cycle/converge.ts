import { type LotState } from '../state.js';
import { type SessionKind } from '../launch.js';
import { type ReviewReport, summarize } from '../schemas.js';
import { type LotCtx } from './ctx.js';
import { asideVerdict, setAsideUnchanged } from './shared.js';
import { lotWallMs, wallCapMs } from '../wall-cap.js';
import { hasSpecStage } from './ctx.js';

/**
 * Consigne `{{converge}}` (L622, issue #41) d'une revue de code de rang 2 ou plus : le relecteur marque `inchange: true` un majeur qui n'était pas dans la revue précédente
 * et qui sort de l'objectif du lot et des lignes qu'il change ; le programme le met en suite pour le lead. Un bloquant (perte de données, sécurité, suite rouge) bloque toujours, marqué ou non.
 */
const CONVERGE_BRIEF =
  'This is not the first code review of the lot: the author fixed the points of the previous one. Check them first. Then report a finding that the previous review did not raise ONLY if it is about the goal of the lot or about lines the lot changes. Mark `inchange: true` on every major finding that the previous review had not raised AND that is outside the goal of the lot and the lines it changes: a major marked `inchange: true` does not block the lot (the program sends it to the lead as a follow-up item and buys no correction pass). A blocking finding (data loss, security, red test suite) always blocks and always buys a correction pass, marked or not.';

/** Rang de la revue qui se joue : 1 + les revues de code déjà lues du lot (une revue conforme compte, `reviewCounts` en garde un 0). L'UX n'a pas de marque : rang 1. */
const reviewRank = (kind: SessionKind, l: LotState): number => (kind === 'ux' ? 1 : (l.reviewCounts?.length ?? 0) + 1);

/** `{{converge}}` d'une revue de code de rang 2 ou plus ; vide en revue 1 et pour les autres sessions. */
export const convergeBrief = (kind: SessionKind, l: LotState): string => ((kind === 'review' || kind === 'review-small') && reviewRank(kind, l) > 1 ? CONVERGE_BRIEF : '');

/** Ce que la revue de code compte : le rapport sans les majeurs mis de côté (L622), son résumé (verdict suivi des suites quand il est conforme) et les lignes `[suite code]` à proposer. */
export function countReview(rep: ReviewReport, kind: SessionKind, l: LotState, head: string, repoHeads?: Record<string, string>) {
  const { rep: counted, aside } = setAsideUnchanged(rep, reviewRank(kind, l), 'code');
  const counting = summarize(counted, head, repoHeads);
  const summary = counting.conforme ? { ...counting, verdict: asideVerdict(counting.verdict, aside) } : counting;
  return { counted, summary, aside };
}

/** Plafond de mur (L622) : la raison du refus d'une passe de plus quand le mur du lot passe deux fois sa durée attendue, sinon undefined. */
export function wallReason(c: LotCtx, now: number): string | undefined {
  const wall = lotWallMs(c.lot.steps, now);
  const cap = wallCapMs(c.config.timeouts.work, c.lot.estimate, hasSpecStage(c.lot));
  return wall > cap ? `plafond de mur : ${Math.round(wall / 60_000)} min sur ${Math.round(cap / 60_000)} (2 × la durée attendue de l'estimate), le lot est rendu avec ses constats au lieu d'une passe de plus` : undefined;
}
