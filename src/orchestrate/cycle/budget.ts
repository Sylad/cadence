import { type SessionKind } from '../launch.js';
import { lotKey, lotRepoPaths, type LotState } from '../state.js';
import { type WaveCtx, type LotCtx, transition, stop, hasSpecStage } from './ctx.js';

/** Tokens comptés par les sessions d'un lot (un lot repris compte ses étapes d'avant). */
export const lotSpent = (l: LotState): number => l.steps.reduce((n, s) => n + (s.tokens?.counted ?? 0), 0);

/** Le lot a dépensé son propre budget (L78) : il ne compte plus que sur le lead, la vague garde le sien pour les autres. */
export const lotOver = (l: LotState): boolean => l.budget !== undefined && lotSpent(l) >= l.budget - heldForEscalation(l);

/**
 * Coût réservé à l'escalade de modèle (L349) : une correction puis une revue neuve complète, jouées au modèle d'escalade. `lotBudget` l'ajoute au budget dérivé de
 * l'estimate quand `orchestrate.escalation` est déclarée, comme REVIEW_RESERVE paie la dernière passe : sans elle, l'escalade (L337) ne jouait que sur les lots
 * qui avaient peu consommé (cadence L341 494 k / 600 k et L342 572 k / 600 k, rendus « escalade fable non jouée (budget) »). ESTIMATION, aucune mesure : aucune
 * escalade n'a été jouée depuis L337 (le seul journal qui en porte une, cadence L342, l'a laissée non jouée). Elle est déduite des journaux `.cadence/runs` du
 * 2026-10-26 (823 passes fix : p90 67 k ; 1 009 revues complètes : p90 109 k), soit 176 k, arrondis à 175 k, au nombre de tokens comptés du modèle des passes
 * (le comptage ne distingue pas le tarif du modèle). À remesurer sur les premières escalades jouées (`cadence perf`, « Escalade de modèle »).
 */
export const ESCALATION_RESERVE = 175_000;

/** Part du budget que les passes ordinaires doivent laisser à l'escalade : retenue tant que l'escalade n'est pas engagée (ou écartée), libérée ensuite. */
export const heldForEscalation = (l: LotState): number => (l.escalation ? 0 : (l.escalationReserve ?? 0));

/**
 * Compteur du lot face au budget de ses passes ordinaires, pour les messages de refus (L349) : la part retenue pour l'escalade en est déduite et nommée
 * (« 6000 / 160999 tokens comptés, 175000 retenus pour l'escalade sur 335999 »), sinon un refus dans cette part contredirait ses propres chiffres ; sans
 * part retenue, le texte d'avant (« 6000 / 335999 tokens comptés »).
 */
export const budgetCount = (l: LotState): string => {
  const held = heldForEscalation(l);
  return `${lotSpent(l)} / ${(l.budget ?? 0) - held} tokens comptés${held ? `, ${held} retenus pour l'escalade sur ${l.budget}` : ''}`;
};

/**
 * Coût réservé à une passe de correction et à la revue courte qui la suit (L145, étendu L218). Réserve fixe de 155 k tokens comptés :
 * p90 d'une passe fix (65 k) plus p90 d'une revue courte Opus (88 k), arrondi. Mesure faite le 2026-10-15 sur les journaux
 * `.cadence/runs` (523 fichiers de lot) : 497 passes fix Sonnet, médiane 45 k, p90 65 k, max 124 k ; 272 revues courtes Opus,
 * médiane 45 k, p90 88 k ; la somme des p90 majore le p90 de la somme, elle n'a pas été recalculée par lot. La réserve de L145 (65 k, revue
 * seule) laissait un lot rendu avant la correction à 740 k / 800 k (warhammer L120) ou 406 k / 450 k (maritime B26.1). Une passe fix ne part
 * que s'il reste de quoi payer la correction ET sa revue ; sinon le lot est rendu avec « correction non jouée (budget) ».
 * Seule exception : des tests rouges après une écriture (work() appelle toFix() sans revue) — la passe fix suivante peut
 * alors être refusée et le lot revient au lead sans revue, avec ses constats.
 */
export const REVIEW_RESERVE = 155_000;

/** Étapes d'écriture : les seules que le budget du lot borne (`session`), donc les seules qu'il puisse laisser non jouées. */
export const WRITE_STEPS: readonly SessionKind[] = ['implement', 'fix', 'spec', 'accept'];

/**
 * Étape d'écriture que le budget a laissée non jouée (L223), pour un lot rendu au lead sur budget ; null sinon. `stop` vide `next` : l'étape se lit
 * dans l'outcome que `overBudget` écrit (« étape « fix » non jouée »), repli sur `next` s'il est resté. Reconnu par ce texte (aucun marqueur dans
 * l'état) : « correction non jouée (budget) » ou « budget du lot atteint ».
 */
export function budgetStep(l: LotState): SessionKind | null {
  if (l.status !== 'handed-back' || !/correction non jouée \(budget\)|budget du lot atteint/.test(l.outcome ?? '')) return null;
  const named = /étape « ([\w-]+) » non jouée/.exec(l.outcome ?? '')?.[1] as SessionKind | undefined;
  const step = named ?? l.next;
  return step && step !== 'integrate' && WRITE_STEPS.includes(step) ? step : null;
}

/** Le budget du lot paie-t-il la passe de correction et la revue courte qui la suit ? Sans budget de lot : toujours. La part de l'escalade (L349) n'est pas à dépenser, sauf pour décider l'escalade elle-même (`escalating`). `extra` : le coût d'une étape de plus devant elles (la sonde, L497). */
export const fixAffordable = (l: LotState, escalating = false, extra = 0): boolean => l.budget === undefined || lotSpent(l) + extra + REVIEW_RESERVE < l.budget - (escalating ? 0 : heldForEscalation(l));

/** Combien de tokens manquent au lot pour que `fixAffordable` soit vrai (0 : la correction et sa revue sont payées). */
const fixShortfall = (l: LotState): number => (l.budget === undefined ? 0 : Math.max(0, lotSpent(l) + REVIEW_RESERVE + heldForEscalation(l) + 1 - l.budget));

/** La revue qui vient de se rendre converge-t-elle (L584) ? Ses constats sont tous des majeurs de code (1 ou 2), après une baisse d'une revue à l'autre : ni bloquant, ni tests rouges, ni passe des mineurs. */
const converging = (l: LotState): boolean => {
  const counts = l.reviewCounts ?? [];
  return l.constats.length >= 1 && l.constats.length <= 2 && l.constats.every((k) => k.source === 'code' && k.gravite === 'majeur') && counts.length >= 2 && counts[counts.length - 1] < counts[counts.length - 2];
};

/**
 * Prélèvement de la dernière passe (L584) : avant une passe fix que le budget du lot refuserait, un lot dont la revue converge reçoit le manque sur le budget restant de la vague
 * (qui doit payer la réserve `REVIEW_RESERVE`), dans la limite de `orchestrate.budgetTopUp` cumulé sur le lot. Le lot est rendu « correction non jouée (budget) » sinon, comme avant. Vrai si le budget a été relevé.
 */
function topUpBudget(c: LotCtx): boolean {
  const l = c.lot;
  const shortfall = fixShortfall(l);
  const taken = l.budgetTopUp ?? 0;
  const w = c.wave.budget;
  if (!shortfall || l.budget === undefined || !converging(l) || taken + shortfall > c.config.budgetTopUp || w.limit - w.consumed < REVIEW_RESERVE) return false;
  l.budget += shortfall;
  l.budgetTopUp = taken + shortfall;
  l.warnings.push(`budget du lot relevé de ${shortfall} token(s) à la dernière passe (la revue converge : ${l.constats.length} majeur(s) restant(s)), ${l.budgetTopUp} / ${c.config.budgetTopUp} prélevés sur la vague`);
  c.wave.log(`${lotKey(l.project, l.lot)} · budget relevé de ${shortfall} token(s) pour la correction et la revue courte (${l.budgetTopUp} / ${c.config.budgetTopUp} prélevés)`);
  return true;
}

/** La passe fix que le budget du lot refuse, après le prélèvement de la dernière passe (L584) : toute autre étape n'est pas concernée. */
export const fixRefused = (c: LotCtx, kind: SessionKind): boolean => kind === 'fix' && !fixAffordable(c.lot) && !topUpBudget(c);

/** Cause d'une suspension demandée par `--stop-after-current` (L79). */
export const STOP_REQUESTED = 'arrêt demandé (--stop-after-current)';

/** Le lot a-t-il été écarté de la vague par `--drop` (L79) ? */
export const dropped = (c: LotCtx): boolean => c.wave.store.control().drops.includes(lotKey(c.lot.project, c.lot.lot));
export const DROPPED = 'retiré de la vague (--drop)';

/** Mention de la réponse du lead restée en attente : un lot rendu sans que la session l'ait lue le dit (comme overBudget). */
export const unplayedAnswer = (l: LotState): string => (l.pendingAnswer ? ` ; la réponse du lead (« ${l.pendingAnswer} ») n'a pas été jouée` : '');

/** Pourquoi plus aucune session ne doit partir (incident, quota, budget), sinon null. */
export function halted(w: WaveCtx, lot?: LotState): string | null {
  if (w.store.control().stopAfterCurrent) return STOP_REQUESTED;
  if (w.incident) return `vague arrêtée : ${w.incident}`;
  if (lot && w.dirtyRepos) {
    for (const r of lotRepoPaths(lot)) {
      const by = w.dirtyRepos.get(r);
      if (by && w.movedRepos?.has(r)) return `dépôt ${r} laissé en HEAD déplacé par ${by} : à remettre sur sa branche par le lead avant de reprendre`;
      if (by) return `dépôt ${r} sali par la revue de ${by} : à nettoyer par le lead avant de reprendre`;
    }
  }
  if (w.quota.hit) return 'quota atteint';
  if (w.budget.exhausted) return 'budget atteint';
  return null;
}

/**
 * Budget du lot atteint avant une session d'écriture : le lot est rendu au lead (reprendre ne lui rendrait pas de budget), les autres continuent.
 * `reserve` : le budget n'est pas dépensé, mais la passe fix ne laisserait pas de quoi rejouer la revue (L145).
 */
export function overBudget(c: LotCtx, reserve = false): null {
  const l = c.lot;
  // Une réponse du lead encore en attente n'a pas été consommée : elle ne doit pas se perdre sans qu'on le dise.
  const answer = l.pendingAnswer ? ` ; la réponse du lead (« ${l.pendingAnswer} ») n'a pas été jouée` : '';
  const basis = hasSpecStage(l) ? 'estimate et étape spec' : "dérivé de l'estimate";
  const why = reserve ? `budget du lot : ${budgetCount(l)} (${basis}), il ne reste pas de quoi payer la correction et la revue courte qui la suivrait (${REVIEW_RESERVE} réservés)` : `budget du lot atteint (${budgetCount(l)}, ${basis})`;
  // Tests rouges après une écriture : la passe fix refusée aurait suivi, le lot revient sans revue (L145) — la cause le dit.
  const red = l.next === 'fix' && l.constats.some((k) => k.source === 'tests');
  // Passe d'écriture qui vient d'être jouée, nommée d'après le compteur : l.pass - 1 passes de correction l'ont précédée (minorPass reste vrai après la passe des mineurs). Sans passe jouée, un lot repris déjà revu compte ses tests rouges depuis la revue de sa branche ; jamais revu (L315), c'est l'implémentation qui les a laissés.
  const played = l.pass - 1;
  const after = l.minorPass && played === (l.minorPassAt ?? 0) ? 'la passe des mineurs' : played > 0 ? `la passe fix ${played}` : l.resumedFrom && l.resumedReviewed ? 'la dernière revue de la branche reprise' : "l'implémentation";
  const notPlayed = l.next === 'fix' ? 'correction non jouée (budget) : ' : '';
  const prefix = notPlayed + (red ? `tests rouges après ${after}, correction suivante non abordable : ` : '');
  const unreviewed = red ? ' ; le lot revient sans revue, avec ses constats' : '';
  return stop(c, 'handed-back', `${prefix}${why} : étape « ${l.next ?? '?'} » non jouée${answer}${unreviewed}, à décider par le lead`);
}

export function suspend(c: LotCtx, why: string): null {
  transition(c, 'suspended', why);
  return null;
}
