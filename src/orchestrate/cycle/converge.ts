import { type LotState, type Constat, type ConstatRevue } from '../state.js';
import { type SessionKind } from '../launch.js';
import { type ReviewReport, summarize } from '../schemas.js';
import { type LotCtx } from './ctx.js';
import { asideNote, asideVerdict, setAsideUnchanged } from './shared.js';
import { lotWallMs, wallCapMs } from '../wall-cap.js';
import { hasSpecStage } from './ctx.js';
import { bulletLines } from '../maquette.js';
import { isNonConformingVerdict } from '../../audit.js';
import { HORS_REGLE } from '../probe.js';
import { type Shrunk } from './retreci.js';

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
 * Consigne `{{converge}}` d'une revue de code d'un lot rétréci (L621) : (a) juger le diff des commits postérieurs à la tête de lancement contre l'objectif, les commits déjà intégrés n'étant que du contexte ;
 * (b) marquer `inchange: true` un majeur hors objectif et hors lignes changées, dès la revue 1 (à partir de la revue 2 c'est `CONVERGE_BRIEF` qui le dit, une seule fois).
 */
const shrunkJudge = (s: Shrunk, l: LotState): string =>
  `The goal of this lot narrowed it to commits that are already merged into the base branch. Judge ONLY the diff of the commits written after the launch head (\`git log ${s.from}..HEAD\`, \`git diff ${s.from}..HEAD\`) against the goal: « ${s.goal} ». The commits before ${s.from} are context, not under review.${
    l.repos?.length ? ' That range is the project repository only: in the neighbouring repositories every commit that cites the lot is under review, whatever its date.' : ''
  }`;

const SHRUNK_MARK =
  'Mark `inchange: true` on every major finding that is outside the goal and outside the lines changed by that diff: a major marked `inchange: true` does not block the lot (the program sends it to the lead as a follow-up item and buys no correction pass). A blocking finding (data loss, security, red test suite) always blocks and always buys a correction pass, marked or not.';

/**
 * `{{converge}}` d'une revue de code : la consigne du lot rétréci dès la revue 1 (L621) ; à partir du rang 2 la consigne de convergence, les constats de la revue précédente et les suites déjà mises de côté ; à tout rang (la sonde joue avant la revue 1)
 * les attentes hors règle de la sonde (L625, issue #41), à ne pas rapporter du tout. Vide pour les autres sessions.
 */
export function convergeBrief(kind: SessionKind, l: LotState, shrunk?: Shrunk): string {
  if (!(kind === 'review' || kind === 'review-small')) return '';
  const lines: string[] = shrunk ? [shrunkJudge(shrunk, l), ''] : [];
  if (reviewRank(kind, l) > 1) {
    lines.push(CONVERGE_BRIEF);
    // Les mineurs notés (L646) ne sont pas à corriger par l'auteur : la revue complète ne les rapporte pas, ce qui lui évite de les compter deux fois. La revue courte, elle, les relit
    // avec le reste (« had to fix ») : elle rend au lead ceux que la passe des mineurs n'a pas corrigés, et `setAsideNoted` ne les écarte pas.
    const full = kind === 'review';
    const toFix = (l.codeConstats ?? []).filter((k) => !full || k.gravite !== 'mineur');
    const noted = full ? (l.codeConstats ?? []).filter((k) => k.gravite === 'mineur') : [];
    if (toFix.length) lines.push('', 'Findings of the previous review that the author had to fix:', ...bulletLines(toFix));
    if (noted.length) lines.push('', 'Minor findings of the previous review, already noted (do not report them again, reworded or not; a minor is only worth a line if it is new):', ...bulletLines(noted));
    const aside = (l.proposals ?? []).filter((p) => p.startsWith(SUITE_CODE));
    if (aside.length) lines.push('', 'Majors of earlier reviews already set aside as follow-ups for the lead (do not report them again):', ...aside.map((p) => `- ${p.slice(SUITE_CODE.length)}`));
  } else if (shrunk) lines.push(SHRUNK_MARK);
  const hors = horsRegleOf(l);
  if (hors.length) lines.push(...(lines.length ? [''] : []), 'Expectations the edge-case probe found OUTSIDE the rules of the lot (already follow-ups for the lead, no correction pass): do not report them at all, neither as a blocking, a major nor a minor finding; they are not findings of this lot.', ...hors.map((e) => `- ${e}`));
  return lines.join('\n');
}

type Repris = { fichier?: string; ligne?: number; classe?: string; texte: string };

/**
 * Un constat de revue répète un constat de la revue précédente : même fichier (ou aucun des deux) et même texte, ou (L649) un texte reformulé sur le même fichier et la même ligne, ou la même classe de défaut.
 * Sans fichier, seul le texte compare (une ligne ou une classe seules rapprocheraient des constats sans rapport). Limite connue : un texte reformulé à une autre ligne et sans classe commune n'est pas reconnu.
 */
const repeats = (previous: Repris[], k: Repris): boolean =>
  previous.some((p) => {
    const fichier = p.fichier ?? '';
    if (fichier !== (k.fichier ?? '')) return false;
    if (p.texte.trim() === k.texte.trim()) return true;
    return fichier !== '' && ((p.ligne !== undefined && p.ligne === k.ligne) || (p.classe !== undefined && p.classe === k.classe));
  });

/**
 * Verdict d'une revue de code conforme une fois les majeurs mis de côté : celui de l'agent suivi de la note des suites (`asideVerdict`, comme la maquette L562).
 * Un verdict de l'agent qui dit « non conforme » (il comptait les marqués) est remplacé par la note seule : écrit au plan par `conclude`, il serait lu non conforme par
 * `raf done` et par l'audit de livraison (`isNonConformingVerdict`), et le lot prêt pour la vague ne le serait pas pour raf.
 */
const convergedVerdict = (verdict: string, aside: { texte: string }[]): string => (aside.length && isNonConformingVerdict(verdict) ? asideNote(aside) : asideVerdict(verdict, aside));

/**
 * Les mineurs notés que la revue complète ne rapporte plus (le brief le lui demande, ou `setAsideNoted` les a écartés) restent notés : sans eux `codeConstats` les perdrait à la revue suivante,
 * dont le brief ne les montrerait plus et qui les compterait de nouveau. Seule la revue complète les garde ; la revue courte les relit et n'écarte rien.
 * Un mineur que la revue redit à un autre rang (majeur ou bloquant compté) n'est pas gardé : le brief suivant le donnerait à corriger et à taire à la fois.
 */
export const carriedNoted = (kind: SessionKind, l: LotState, counted: ReviewReport): Constat[] =>
  kind === 'review' ? (l.codeConstats ?? []).filter((k) => k.gravite === 'mineur' && !repeats(counted.constats, k)) : [];

/**
 * Un majeur ou un mineur de la revue qui reprend mot pour mot (son texte contient l'entrée) une attente hors règle de la sonde ne compte pas (L625, issue #41) : elle est déjà une sous-tâche `[hors règle]` du lead
 * et n'achète pas de passe, à aucun rang — ni une correction (majeur), ni la passe des mineurs (mineur). Un bloquant compte toujours. `dropped` ne porte que les majeurs écartés (la note du verdict).
 * Limite connue : un texte reformulé n'est pas reconnu (le brief demande au relecteur de ne pas les rapporter).
 */
function setAsideHorsRegle(rep: ReviewReport, kind: SessionKind, l: LotState): { rep: ReviewReport; dropped: string[] } {
  const hors = kind === 'review' || kind === 'review-small' ? horsRegleOf(l) : [];
  const known = (k: ReviewReport['constats'][number]) => (k.gravite === 'majeur' || k.gravite === 'mineur') && hors.some((e) => k.texte.includes(e));
  const out = rep.constats.filter(known);
  if (!out.length) return { rep, dropped: [] };
  for (const k of out) l.warnings.push(`${k.gravite} qui reprend une attente hors règle de la sonde, non compté (déjà proposée au lead) : ${k.texte}`);
  const majors = out.filter((k) => k.gravite === 'majeur');
  return {
    rep: { ...rep, majeurs: Math.max(0, rep.majeurs - majors.length), mineurs: Math.max(0, rep.mineurs - (out.length - majors.length)), constats: rep.constats.filter((k) => !known(k)) },
    dropped: majors.map((k) => k.texte),
  };
}

/**
 * Un mineur de la revue de code qui reprend un mineur déjà noté par la revue précédente (même fichier ou aucun des deux, même texte : `repeats`) ne compte pas (L646) : la passe des mineurs l'a vu ou le lead l'a en note.
 * Seul un mineur est écarté (un majeur ou un bloquant de même texte compte), et seulement à la revue complète : la revue courte qui suit la passe des mineurs rend au lead ceux que la passe n'a pas corrigés, les écarter les perdrait. Limite connue : un texte reformulé n'est pas reconnu (le brief demande au relecteur de ne pas les rapporter).
 */
function setAsideNoted(rep: ReviewReport, kind: SessionKind, l: LotState): { rep: ReviewReport } {
  const noted = kind === 'review' ? (l.codeConstats ?? []).filter((k) => k.gravite === 'mineur') : [];
  const known = (k: ReviewReport['constats'][number]) => k.gravite === 'mineur' && repeats(noted, k);
  const out = rep.constats.filter(known);
  if (!out.length) return { rep };
  for (const k of out) l.warnings.push(`mineur déjà noté par la revue précédente, non compté : ${k.texte}`);
  return { rep: { ...rep, mineurs: Math.max(0, rep.mineurs - out.length), constats: rep.constats.filter((k) => !known(k)) } };
}

/** Note d'une revue rendue conforme par les majeurs hors règle écartés : le verdict « non conforme » de l'agent, qui les comptait, ne doit pas rester au plan (même raison que `convergedVerdict`). */
const horsRegleNote = (dropped: string[]): string => `conforme, ${dropped.length} majeur${dropped.length > 1 ? 's' : ''} qui reprend${dropped.length > 1 ? 'nent' : ''} une attente hors règle de la sonde, déjà proposée au lead : ${dropped.join(' ; ')}`;

/**
 * Ce que la revue de code compte : le rapport sans les majeurs mis de côté (L622) ni les constats qui reprennent une attente hors règle (L625), son résumé (verdict suivi des suites quand il est conforme) et les lignes `[suite code]` à proposer.
 * Un lot rétréci (`shrunk`, L621) compte la marque dès la revue 1. Un majeur marqué `inchange: true` que la revue précédente avait déjà signalé (`codeConstats`) porte une marque fausse : il compte, et le lot en garde l'avertissement.
 */
export function countReview(rep: ReviewReport, kind: SessionKind, l: LotState, head: string, { repoHeads, shrunk }: { repoHeads?: Record<string, string>; shrunk?: Shrunk } = {}) {
  const rank = reviewRank(kind, l);
  const previous = l.codeConstats ?? [];
  const falseMark = (k: ReviewReport['constats'][number]) => rank >= 2 && k.gravite === 'majeur' && k.inchange === true && repeats(previous, k);
  // `current[i]` : le constat i du rapport tel que les étapes suivantes le voient (copié quand sa marque est fausse) ; les filtres gardent l'identité, d'où la décision de chaque constat (L638).
  let current = rep.constats;
  let checked = rep;
  if (rep.constats.some(falseMark)) {
    for (const k of rep.constats.filter(falseMark)) l.warnings.push(`majeur marqué inchange: true déjà signalé par la revue précédente, compté comme un majeur : ${k.texte}`);
    current = rep.constats.map((k) => (falseMark(k) ? { ...k, inchange: undefined } : k));
    checked = { ...rep, constats: current };
  }
  const horsRegle = setAsideHorsRegle(checked, kind, l);
  checked = horsRegle.rep;
  const afterHors = new Set(checked.constats);
  // Un mineur que la revue précédente avait noté, redit, ne compte pas (L646) : il ne rouvre pas la passe des mineurs.
  const known = setAsideNoted(checked, kind, l);
  checked = known.rep;
  // Un lot rétréci (L621) met de côté dès la revue de code 1 ; l'UX n'a pas de marque.
  const markRank = shrunk && kind !== 'ux' ? Math.max(rank, 2) : rank;
  const { rep: counted, aside } = setAsideUnchanged(checked, markRank, 'code');
  const counting = summarize(counted, head, repoHeads);
  const verdict = counting.conforme ? convergedVerdict(counting.verdict, aside) : counting.verdict;
  const summary = counting.conforme ? { ...counting, verdict: horsRegle.dropped.length && isNonConformingVerdict(verdict) ? horsRegleNote(horsRegle.dropped) : verdict } : counting;
  const kept = new Set(counted.constats);
  const afterNoted = new Set(known.rep.constats);
  const decisions: ConstatRevue[] = rep.constats.map((k, i): ConstatRevue => ({ texte: k.texte, gravite: k.gravite, rang: markRank, decision: !afterHors.has(current[i]) ? 'ecarte-hors-regle' : !afterNoted.has(current[i]) ? 'ecarte-deja-note' : !kept.has(current[i]) ? 'ecarte-inchange' : 'compte' }));
  return { counted, summary, aside, decisions };
}

/** Plafond de mur (L622) : la raison du refus d'une passe de plus quand le mur du lot passe deux fois sa durée attendue, sinon undefined. Un lot repris par `--add` ne compte que les étapes depuis la reprise (`wallFrom`). */
export function wallReason(c: LotCtx, now: number): string | undefined {
  const wall = lotWallMs(c.lot.steps.slice(c.lot.wallFrom ?? 0), now);
  const cap = wallCapMs(c.config.timeouts.work, c.lot.estimate, hasSpecStage(c.lot));
  return wall > cap ? `plafond de mur : ${Math.round(wall / 60_000)} min sur ${Math.round(cap / 60_000)} (2 × la durée attendue de l'estimate), le lot est rendu avec ses constats au lieu d'une passe de plus` : undefined;
}
