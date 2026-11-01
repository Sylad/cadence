// Une revue non conforme n'ouvre une passe de correction que si elle laisse un constat actionnable (L522).

import type { LotCtx } from './cycle.js';
import type { Constat, ReviewSummary } from './state.js';

/**
 * Un constat est actionnable quand il est bloquant ou majeur et que son texte, rogné, n'est pas vide (`blockingConstats` ne garde déjà que les bloquants et majeurs).
 * Les totaux annoncés peuvent être > 0 sans constat lisible (`summarize` retient le plus grand) : la session fix n'aurait rien à lire, le lot est rendu avec les totaux dans la cause.
 * Ses constats sont vidés : une reprise (`resumedFrom && constats.length`) ne rouvre pas la passe. `stop` est celui du cycle. Vrai quand le lot est rendu.
 */
export function handBackWithoutFinding(c: LotCtx, constats: Constat[], summary: ReviewSummary, stop: (c: LotCtx, status: 'handed-back', outcome: string) => unknown): boolean {
  if (constats.some((k) => k.texte.trim())) return false;
  c.lot.constats = [];
  if (c.lot.escalation && !c.lot.escalation.issue) c.lot.escalation.issue = 'rendu'; // la revue neuve de l'escalade (L337) n'a pas jugé le lot conforme : comme `toFix`, l'escalade est dite rendue
  stop(c, 'handed-back', `revue non conforme sans constat actionnable (${summary.bloquants} bloquant(s), ${summary.majeurs} majeur(s) annoncé(s), aucun constat lisible) : pas de passe de correction`);
  return true;
}
