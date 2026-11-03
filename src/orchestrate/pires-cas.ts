// Jeu de données « pires cas » (L534, docs/specs/jeu-pires-cas) : la consigne que les briefs d'écran donnent quand le projet déclare `qa.worstData`.
// La consigne vit ici, dans les briefs, et jamais dans les textes statiques des agents (ils renvoient au brief). Sans la clé, rien n'est écrit.

/** Valeur de `qa.worstData` utilisable dans un brief : rognée, vide valant absente. */
const declared = (worst: string | undefined): string | undefined => worst?.trim() || undefined;

/** Consigne de l'étape spec : chaque état capturé une seconde fois avec le jeu pires cas ; vide sans la clé. `light` : la maquette légère capture aussi l'écran actuel. */
export function worstSpecLines(worst: string | undefined, light: boolean): string[] {
  const w = declared(worst);
  if (!w) return [];
  return [
    `The project declares a worst-case data set (\`qa.worstData\`): \`${w}\`. Activate it in dev mode only; it has no effect in production. Capture each state a second time with it, named \`maquette-<état>-pires-cas-<largeur>.png\`${light ? ' (and \`actuel-<état>-pires-cas-<largeur>.png\` for the current screen)' : ''}, at each width, next to the captures with the demo data.`,
    'A defect seen with it (cut text, overflow, an empty state badly handled) fixes the mockup or becomes a rule of the sheet. If the server is not in dev mode and the set cannot be loaded, say so under "nonVerifie".',
  ];
}

/** Consigne de la liste à cocher d'une revue (maquette, ux) : une ligne par état, par largeur et par jeu ; vide sans la clé. La gravité suit l'échelle habituelle de la revue. */
export function worstReviewText(worst: string | undefined): string {
  const w = declared(worst);
  if (!w) return '';
  return `The project declares a worst-case data set (\`qa.worstData\`): \`${w}\`. Walk every state at each width with the demo data and the worst-case data, and keep one line per state, per width and per data set in the checklist. Load the worst-case set in dev mode only; if the server is not in dev mode, say so under "nonVerifie".`;
}

/** Consigne du brief de la passe ux : seulement pour un lot à écran (`screen`), la passe de conformité parcourant les états de sa fiche ; vide sinon. */
export const worstUxText = (kind: string, screen: boolean, worst: string | undefined): string => (kind === 'ux' && screen ? worstReviewText(worst) : '');
