import { ESCALATION_RESERVE } from './cycle.js';

/**
 * Budget d'un lot ordinaire (L78, L128, recalibré L194). Mesuré sur le TOTAL de chaque lot dans `.cadence/runs` (toutes les vagues
 * où il est passé, 250 lots, 11-10), rangé par estimate : jusqu'à 0,5 j p90 374 k (152 lots), de 0,5 à 1 j p90 732 k (88 lots, max
 * 1,09 M), au-delà d'un jour p90 1,14 M pour les 10 lots de 1,25 à 2 j (570 k par jour d'estimate), max 1,7 M (L188). Le plafond
 * de L78 (400 k par jour) rendait au lead, au deuxième tour, un lot de 1 j (L188 : 483 k puis 495 k).
 * Plancher relevé de 450 k à 540 k (L218) avec la réserve de la passe fix (155 k) : 14 k + 282 k + 80 k + 155 k = 531 k arrondis, la marge avant refus du fix reste 385 k.
 * Relevé à 600 k (L247), mesuré sur 16–22-10 : 145 lots à 540 k, p90 451 k, 3 au-dessus (tous maritime-atlas : 12 lots, p90 556 k, max 609 k) ; la marge
 * avant refus du fix passe à 445 k. Les lots à 750 k (60 lots, p90 571 k, 0 dépassement) et à 1,3 M (20 lots, p90 904 k, 1 dépassement) tiennent : inchangés.
 * Remesuré sur 17–23-10 (L280, `docs/perf/recalage-2026-10-24.md`) : 0 lot sur 309 au-dessus de son budget, p90 452 k à 600 k, 563 k à 750 k, 875 k à 1,3 M : tous inchangés, avec au moins 10 % de marge.
 */
const LOT_BUDGET_FLOOR = 600_000;
/** Lot de plus de 0,5 j et d'au plus 1 j : p90 mesuré du total, 732 k arrondis à 750 k. */
const LOT_BUDGET_ONE_DAY = 750_000;
/** Tokens par jour d'estimate au-delà d'un jour : p90 1,14 M pour 2 j. */
const LOT_BUDGET_PER_DAY = 570_000;
/**
 * Total d'un lot à `screen:` (L194), étapes spec, maquette et accept comprises : p90 1,28 M sur 5 lots (L113 1,12 M, L25 1,28 M, L50 877 k,
 * L85 758 k, L43 238 k), arrondi à 1,3 M. Remplace l'allocation de L191 (+350 k au budget d'estimate), qui ne payait ni l'UX de
 * conformité ni les passes de correction.
 */
const SCREEN_LOT_BUDGET = 1_300_000;
/**
 * Allocation d'un lot à fiche `spec: true` (L188/L191), en plus du budget dérivé de l'estimate : sessions spec, fiche et accept hors de
 * l'estimate d'écriture. Relevée de 350 k à 450 k (L218) : la chaîne avant implement du lot spec warhammer L120 a coûté 388 k (350 k : pire cas
 * mesuré des étapes d'un lot à écran, ol L113 : 349 k) ; cadence L217 n'en a pris que 176 k.
 */
export const SPEC_STAGE_ALLOCATION = 450_000;

/** `light` : maquette légère (L459), un lot visible sans `screen: page` qui passe par spec et maquette sans accept ; son budget est celui d'un lot `spec`. */
export type SpecStage = 'screen' | 'spec' | 'light';

/** Tokens d'une classe de lots rendus, tels que `cadence perf` les mesure (`tokens.byEstimate[<classe>].p90`, 14 jours glissants) ; la clé est la classe de taille de perf : l'estimate, « +spec » pour un lot passé par la chaîne spec. */
export interface MeasuredTokens {
  p90: number;
  lots: number;
}
export type MeasuredBudgets = ReadonlyMap<string, MeasuredTokens>;

/** Sous ce nombre de lots rendus dans la classe, la mesure ne dit rien : le budget statique reste (le seuil de tendance de `cadence perf`). */
export const MEASURE_MIN_LOTS = 5;
/** Jours que couvre la mesure : les deux fenêtres de 7 jours de `cadence perf`. */
export const MEASURE_DAYS = 14;
/** Le budget mesuré est arrondi au multiple supérieur de ce pas. */
const MEASURE_STEP = 50_000;
/** Plafond du budget mesuré : ce multiple du budget statique de la classe. Les lots rendus pour budget s'arrêtent au budget (le p90 les compte tronqués) : la mesure monte par paliers, jamais d'un coup. */
const MEASURE_CEILING = 2;

const classKey = (estimate: number, stage?: SpecStage): string => `${estimate}${stage ? '+spec' : ''}`;

type Resolved = { budget: number; m?: MeasuredTokens; rounded?: number; state: 'statique' | 'court' | 'mesure' | 'plancher' | 'plafond' };

/** Le budget (hors escalade) d'un lot : le statique, relevé au p90 mesuré de sa classe quand `measured` en porte assez, borné entre le statique et son double. */
function resolveBudget(estimate: number, stage?: SpecStage, measured?: MeasuredBudgets): Resolved {
  const fixed = lotBaseBudget(estimate, stage);
  if (!measured) return { budget: fixed, state: 'statique' };
  const m = measured.get(classKey(estimate, stage));
  if (!m || m.lots < MEASURE_MIN_LOTS) return { budget: fixed, ...(m ? { m } : {}), state: 'court' };
  if (!Number.isFinite(m.p90)) return { budget: fixed, state: 'statique' };
  const rounded = Math.ceil(m.p90 / MEASURE_STEP) * MEASURE_STEP;
  const ceiling = fixed * MEASURE_CEILING;
  if (rounded < fixed) return { budget: fixed, m, rounded, state: 'plancher' };
  if (rounded > ceiling) return { budget: ceiling, m, rounded, state: 'plafond' };
  return { budget: rounded, m, rounded, state: 'mesure' };
}

/** Base d'un budget, pour `--dry-run` : la mesure d'où il sort (p90, nombre de lots, fenêtre, arrondi, bornes) ou, à défaut, l'estimate (et l'étape spec). */
export function lotBudgetBasis(estimate: number, stage?: SpecStage, escalationModel?: string, measured?: MeasuredBudgets): string {
  const base = measuredBasis(estimate, stage, measured);
  return escalationModel ? `${base}, plus ${ESCALATION_RESERVE} réservés à l'escalade ${escalationModel}` : base;
}

function measuredBasis(estimate: number, stage?: SpecStage, measured?: MeasuredBudgets): string {
  const r = resolveBudget(estimate, stage, measured);
  const fixed = lotBaseBudget(estimate, stage);
  const derived = ordinaryBasis(estimate, stage);
  if (r.state === 'statique') return derived;
  if (r.state === 'court') return `${r.m?.lots ?? 0} lot(s) mesuré(s) sur ${MEASURE_DAYS} jours, il en faut ${MEASURE_MIN_LOTS} : budget statique ${fixed} (${derived})`;
  const seen = `p90 mesuré ${r.m!.p90} sur ${r.m!.lots} lots (classe ${classKey(estimate, stage)}, ${MEASURE_DAYS} derniers jours), arrondi à ${r.rounded}`;
  if (r.state === 'plancher') return `${seen}, sous le budget statique ${fixed} : budget statique gardé (${derived})`;
  if (r.state === 'plafond') return `${seen}, plafonné à ${r.budget} (${MEASURE_CEILING} × le budget statique ${fixed})`;
  return `${seen}, borné à ${fixed}–${fixed * MEASURE_CEILING}`;
}

function ordinaryBasis(estimate: number, stage?: SpecStage): string {
  if (stage === 'screen' && lotBudget(estimate, stage) === SCREEN_LOT_BUDGET) return "p90 mesuré du total d'un lot à écran, étapes spec, maquette et accept comprises";
  const ordinary = lotBudget(estimate);
  const basis = estimate <= 0.5 ? "plancher d'un lot jusqu'à 0,5 j" : estimate <= 1 ? "p90 mesuré du total d'un lot de 0,5 à 1 j" : Math.round(estimate * LOT_BUDGET_PER_DAY) <= LOT_BUDGET_ONE_DAY ? `plancher de ${LOT_BUDGET_ONE_DAY} au-delà d'un jour, l'estimate × ${LOT_BUDGET_PER_DAY} ne le dépasse pas encore` : `${LOT_BUDGET_PER_DAY} par jour, p90 mesuré du total au-delà d'un jour`;
  if (!stage) return basis;
  return `${ordinary} dérivés de l'estimate (${basis}), plus ${SPEC_STAGE_ALLOCATION} pour ${stage === 'light' ? 'les étapes spec et maquette' : `les étapes spec, ${stage === 'screen' ? 'maquette' : 'fiche'} et accept`}`;
}

/** Budget d'un lot, dérivé de son estimate et de sa catégorie : empêche quelques lots d'avaler le budget de la vague au détriment des autres. Un lot à `screen:` vaut le total mesuré d'un lot à écran (L194) ; un lot à `spec: true` y ajoute l'allocation de son étape (L191) ; `measured` (L501, le p90 de `cadence perf`) le relève au p90 de sa classe, borné ; `escalation` (orchestrate.escalation déclarée) y ajoute la part de l'escalade (L349). */
export const lotBudget = (estimate: number, stage?: SpecStage, escalation = false, measured?: MeasuredBudgets): number => resolveBudget(estimate, stage, measured).budget + (escalation ? ESCALATION_RESERVE : 0);

const lotBaseBudget = (estimate: number, stage?: SpecStage): number => {
  const ordinary = estimate <= 0.5 ? LOT_BUDGET_FLOOR : Math.max(LOT_BUDGET_ONE_DAY, Math.round(estimate * LOT_BUDGET_PER_DAY));
  if (stage === 'screen') return Math.max(SCREEN_LOT_BUDGET, ordinary + SPEC_STAGE_ALLOCATION);
  return ordinary + (stage === 'spec' || stage === 'light' ? SPEC_STAGE_ALLOCATION : 0);
};
