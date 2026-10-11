import type { Constat } from './state.js';
import { bulletLines } from './maquette.js';

// Revue de la fiche back (L188, spec etape-spec-back B3) : ce que le programme dit à l'agent code-reviewer en mode « fiche », et à l'agent spec à la seconde passe.

/** Consigne de la revue de fiche dans le brief : la fiche, la passe en cours, les points de la première revue à la seconde. */
export function ficheReviewText(o: { fiche: string; passes: number; previous?: Constat[] }): string {
  const second = o.passes >= 1;
  const lines = [
    `Sheet mode: review the sheet \`${o.fiche}\` (back part: \`sujet\`, \`cas\`, \`regles\`, \`contrats\`, \`donnees\`). It is a document, not code: read it, then open the code, the tests and the sources it cites.`,
    second
      ? 'This is the second and last review: the spec writer fixed the points of the first one (below). Check them first, then review the whole sheet again.'
      : 'This is the first review of this sheet.',
  ];
  if (second && o.previous?.length) lines.push('', 'Points of the first review that the spec writer had to fix:', ...bulletLines(o.previous));
  return lines.join('\n');
}

/** Consigne de la seconde passe `spec` : les constats bloquants et majeurs des revues de la fiche (et de la maquette d'un lot mixte), ensemble. */
export function reviewedSheetText(constats: Constat[], mockup: boolean): string {
  return [
    `The review of your ${mockup ? 'sheet and mockup' : 'sheet'} found the blocking and major points below. Fix exactly these in the sheet${mockup ? ', the mockup and the captures' : ''} (one more pass only: it is reviewed again, and what remains goes back to the lead). Keep the sheet consistent: every rule sourced or a hypothesis with its \`si_faux\`, every rule attached to a case and tested, every contract with its errors:`,
    ...bulletLines(constats),
  ].join('\n');
}
