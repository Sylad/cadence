import { type LotState, type Constat } from '../state.js';
import { type SessionKind } from '../launch.js';
import { type ReviewReport, summarize } from '../schemas.js';
import { type LotCtx } from './ctx.js';
import { asideNote, asideVerdict, setAsideUnchanged } from './shared.js';
import { lotWallMs, wallCapMs } from '../wall-cap.js';
import { hasSpecStage } from './ctx.js';
import { bulletLines } from '../maquette.js';
import { isNonConformingVerdict } from '../../audit.js';
import { HORS_REGLE } from '../probe.js';

/**
 * Consigne `{{converge}}` (L622, issue #41) d'une revue de code de rang 2 ou plus : le relecteur marque `inchange: true` un majeur qui n'était pas dans la revue précédente
 * et qui sort de l'objectif du lot et des lignes qu'il change ; le programme le met en suite pour le lead. Un bloquant (perte de données, sécurité, suite rouge) bloque toujours, marqué ou non.
 * Le brief porte les constats de la revue précédente (`codeConstats`) et les suites déjà mises de côté (`[suite code]`), sans quoi le relecteur, qui part d'une session neuve, ne peut pas juger « absent de la revue précédente ».
 */
const CONVERGE_BRIEF =
  'This is not the first code review of the lot: the author fixed the points of the previous one (listed below when the program has them). Check them first. Then report a finding that the previous review did not raise ONLY if it is about the goal of the lot or about lines the lot changes. Mark `inchange: true` on every major finding that the previous review had not raised AND that is outside the goal of the lot and the lines it changes: a major marked `inchange: true` does not block the lot (the program sends it to the lead as a follow-up item and buys no correction pass). A review whose only blocking or major findings are marked `inchange: true` is compliant: write a compliant verdict, the marked majors are not counted. A blocking finding (data loss, security, red test suite) always blocks and always buys a correction pass, marked or not.';

/** Préfixe des propositions nées d'un majeur mis de côté par une revue de code (`setAsideUnchanged(…, 'code')`). */
const SUITE_CODE = '[suite code] ';

/** Les attentes hors règle déjà proposées au lead (sans le préfixe). */
const horsRegleOf = (l: LotState): string[] => (l.proposals ?? []).filter((p) => p.startsWith(HORS_REGLE)).map((p) => p.slice(HORS_REGLE.length).trim()).filter(Boolean);

/** Rang de la revue qui se joue : 1 + les revues de code déjà lues du lot (une revue conforme compte, `reviewCounts` en garde un 0). L'UX n'a pas de marque : rang 1. */
const reviewRank = (kind: SessionKind, l: LotState): number => (kind === 'ux' ? 1 : (l.reviewCounts?.length ?? 0) + 1);

/**
 * `{{converge}}` d'une revue de code : à partir du rang 2 la consigne, les constats de la revue précédente et les suites déjà mises de côté ; à tout rang (la sonde joue avant la revue 1)
 * les attentes hors règle de la sonde (L625, issue #41), à ne pas rapporter en majeur. Vide pour les autres sessions.
 */
export function convergeBrief(kind: SessionKind, l: LotState): string {
  if (!(kind === 'review' || kind === 'review-small')) return '';
  const lines: string[] = [];
  if (reviewRank(kind, l) > 1) {
    lines.push(CONVERGE_BRIEF);
    if (l.codeConstats?.length) lines.push('', 'Findings of the previous review that the author had to fix:', ...bulletLines(l.codeConstats));
    const aside = (l.proposals ?? []).filter((p) => p.startsWith(SUITE_CODE));
    if (aside.length) lines.push('', 'Majors of earlier reviews already set aside as follow-ups for the lead (do not report them again):', ...aside.map((p) => `- ${p.slice(SUITE_CODE.length)}`));
  }
  const hors = horsRegleOf(l);
  if (hors.length) lines.push(...(lines.length ? [''] : []), 'Expectations the edge-case probe found OUTSIDE the rules of the lot (already follow-ups for the lead, no correction pass): do not report them as a blocking or major finding; at most a minor.', ...hors.map((e) => `- ${e}`));
  return lines.join('\n');
}

/** Un constat de revue répète un constat de la revue précédente : même fichier (ou aucun des deux) et même texte. Limite connue : un texte reformulé n'est pas reconnu. */
const repeats = (previous: Constat[], k: { fichier?: string; texte: string }): boolean => previous.some((p) => (p.fichier ?? '') === (k.fichier ?? '') && p.texte.trim() === k.texte.trim());

/**
 * Verdict d'une revue de code conforme une fois les majeurs mis de côté : celui de l'agent suivi de la note des suites (`asideVerdict`, comme la maquette L562).
 * Un verdict de l'agent qui dit « non conforme » (il comptait les marqués) est remplacé par la note seule : écrit au plan par `conclude`, il serait lu non conforme par
 * `raf done` et par l'audit de livraison (`isNonConformingVerdict`), et le lot prêt pour la vague ne le serait pas pour raf.
 */
const convergedVerdict = (verdict: string, aside: { texte: string }[]): string => (aside.length && isNonConformingVerdict(verdict) ? asideNote(aside) : asideVerdict(verdict, aside));

/**
 * Un majeur de la revue qui reprend mot pour mot (son texte contient l'entrée) une attente hors règle de la sonde ne compte pas (L625, issue #41) : elle est déjà une sous-tâche `[hors règle]` du lead
 * et n'achète pas de passe, à aucun rang. Un bloquant compte toujours ; un mineur n'achète rien. Limite connue : un texte reformulé n'est pas reconnu (le brief le demande au relecteur).
 */
function setAsideHorsRegle(rep: ReviewReport, kind: SessionKind, l: LotState): { rep: ReviewReport; dropped: string[] } {
  const hors = kind === 'review' || kind === 'review-small' ? horsRegleOf(l) : [];
  const known = (k: ReviewReport['constats'][number]) => k.gravite === 'majeur' && hors.some((e) => k.texte.includes(e));
  const dropped = rep.constats.filter(known);
  if (!dropped.length) return { rep, dropped: [] };
  for (const k of dropped) l.warnings.push(`majeur qui reprend une attente hors règle de la sonde, non compté (déjà proposée au lead) : ${k.texte}`);
  return { rep: { ...rep, majeurs: Math.max(0, rep.majeurs - dropped.length), constats: rep.constats.filter((k) => !known(k)) }, dropped: dropped.map((k) => k.texte) };
}

/** Note d'une revue rendue conforme par les majeurs hors règle écartés : le verdict « non conforme » de l'agent, qui les comptait, ne doit pas rester au plan (même raison que `convergedVerdict`). */
const horsRegleNote = (dropped: string[]): string => `conforme, ${dropped.length} majeur${dropped.length > 1 ? 's' : ''} qui reprend${dropped.length > 1 ? 'nent' : ''} une attente hors règle de la sonde, déjà proposée au lead : ${dropped.join(' ; ')}`;

/**
 * Ce que la revue de code compte : le rapport sans les majeurs mis de côté (L622), son résumé (verdict suivi des suites quand il est conforme) et les lignes `[suite code]` à proposer.
 * Un majeur marqué `inchange: true` que la revue précédente avait déjà signalé (`codeConstats`) porte une marque fausse : il compte, et le lot en garde l'avertissement.
 */
export function countReview(rep: ReviewReport, kind: SessionKind, l: LotState, head: string, repoHeads?: Record<string, string>) {
  const rank = reviewRank(kind, l);
  const previous = l.codeConstats ?? [];
  const falseMark = (k: ReviewReport['constats'][number]) => rank >= 2 && k.gravite === 'majeur' && k.inchange === true && repeats(previous, k);
  let checked = rep;
  if (rep.constats.some(falseMark)) {
    for (const k of rep.constats.filter(falseMark)) l.warnings.push(`majeur marqué inchange: true déjà signalé par la revue précédente, compté comme un majeur : ${k.texte}`);
    checked = { ...rep, constats: rep.constats.map((k) => (falseMark(k) ? { ...k, inchange: undefined } : k)) };
  }
  const horsRegle = setAsideHorsRegle(checked, kind, l);
  checked = horsRegle.rep;
  const { rep: counted, aside } = setAsideUnchanged(checked, rank, 'code');
  const counting = summarize(counted, head, repoHeads);
  const verdict = counting.conforme ? convergedVerdict(counting.verdict, aside) : counting.verdict;
  const summary = counting.conforme ? { ...counting, verdict: horsRegle.dropped.length && isNonConformingVerdict(verdict) ? horsRegleNote(horsRegle.dropped) : verdict } : counting;
  return { counted, summary, aside };
}

/** Plafond de mur (L622) : la raison du refus d'une passe de plus quand le mur du lot passe deux fois sa durée attendue, sinon undefined. Un lot repris par `--add` ne compte que les étapes depuis la reprise (`wallFrom`). */
export function wallReason(c: LotCtx, now: number): string | undefined {
  const wall = lotWallMs(c.lot.steps.slice(c.lot.wallFrom ?? 0), now);
  const cap = wallCapMs(c.config.timeouts.work, c.lot.estimate, hasSpecStage(c.lot));
  return wall > cap ? `plafond de mur : ${Math.round(wall / 60_000)} min sur ${Math.round(cap / 60_000)} (2 × la durée attendue de l'estimate), le lot est rendu avec ses constats au lieu d'une passe de plus` : undefined;
}
