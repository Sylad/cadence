import type { Lot } from '../plan.js';

/** Une décision de l'humain relevée dans une note de lot : le lot qui la porte, la date de la note et son texte tel qu'écrit. */
export interface Decision {
  lot: string;
  date: string;
  text: string;
}

/** Longueur maximale gardée d'une note : la décision est dite en tête, la suite (mesures, détail) n'a pas sa place dans un brief. */
const MAX_TEXT = 1500;

/** Une note est une décision de l'humain quand elle nomme celui qui décide (Sylvain, l'humain, le lead, l'utilisateur) et dit qu'il a tranché, validé, demandé ou refusé. */
const WHO = /\b(sylvain|humain|human|lead|utilisateur|user)\b/i;
const DECIDED = /(décision|décid|tranch|valid|arbitr|demand|veut|voulu|exig|refus|interdi|decision|decided|approved|asked|wants|required|refused)/i;

/**
 * Les notes que le programme écrit lui-même, reconnues à leur préfixe : une hypothèse de fiche (`hypothesisNote`, spec.ts : un choix que personne
 * n'a validé), un mineur de revue (`noteMinors`, cycle.ts), un titre remplacé (plan.ts : l'ancien titre, périmé), une remise en attente (plan.ts) ou
 * un abandon (cli.ts `drop --reason`). Elles citent souvent l'utilisateur ou le lead sans porter aucune décision de l'humain.
 */
const PROGRAM_NOTE = /^(Hypothèses \(fiche |Revue de [^\n]{1,60}? — mineur : |titre remplacé : |remis en attente(\s*:|$)|abandonné : )/;

const isDecision = (text: string): boolean => !PROGRAM_NOTE.test(text) && WHO.test(text) && DECIDED.test(text);

/**
 * Les décisions de l'humain écrites dans les notes d'un lot et de son parent (le parent d'abord), dans l'ordre du plan. Le texte est
 * celui de la note, coupé à `MAX_TEXT` : la date et la citation restent celles de l'humain, jamais reformulées (L344, B28.8 du 26-10 :
 * « champs exclus » lu contre la décision du 22-10). Les notes de revue, de mesure ou de relevé, qui ne nomment personne, sont ignorées, comme celles que le programme
 * écrit lui-même (`PROGRAM_NOTE`), même quand leur contenu cite l'utilisateur ou le lead.
 */
export function humanDecisions(lot: Lot, parent?: Lot): Decision[] {
  return [parent, lot].flatMap((l) =>
    l ? l.notes.filter((n) => isDecision(n.text)).map((n) => ({ lot: l.id, date: n.date ?? '', text: n.text.length > MAX_TEXT ? `${n.text.slice(0, MAX_TEXT)} […]` : n.text })) : [],
  );
}

/** `{{decisions}}` des briefs d'écriture : les décisions et la règle qui en découle ; vide sans décision. */
export function decisionsText(decisions: Decision[]): string {
  if (!decisions.length) return '';
  return [
    'Decisions to respect (decisions of the human written in the notes of this lot and of its parent, with their date and wording as written):',
    ...decisions.map((d) => `- ${d.date} (${d.lot}): ${d.text}`),
    'An interpretation of the lot that departs from one of these decisions is not a choice: put it under "questions" and stop on that point, never under "choix".',
  ].join('\n');
}
