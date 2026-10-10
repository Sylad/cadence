import { posix } from 'node:path';
import { LARGEURS } from '../spec.js';
import type { Constat } from './state.js';

// Revue UX de la maquette (L172, spec etape-spec S4) : ce que le programme dit à l'agent ux-reviewer en mode « maquette », et à l'agent spec à la seconde passe.

/** Une ligne par constat : gravité, endroit, texte. */
export const bulletLines = (constats: Constat[]): string[] => constats.map((k) => `- [${k.gravite}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);

/** Consigne de la revue de maquette dans le brief : la fiche, la maquette, les captures attendues, la passe en cours. */
export function maquetteText(o: { fiche: string; passes: number; previous?: Constat[] }): string {
  const folder = posix.dirname(o.fiche);
  const second = o.passes >= 1;
  const lines = [
    `Mockup mode: review the mockup \`${folder}/maquette.html\` against its sheet \`${o.fiche}\`. It is a local file, not an application: open it directly (file URL), do not start any server.`,
    `The spec writer committed the captures \`${folder}/maquette-<état>-<largeur>.png\` (one per state of the sheet and per width: ${LARGEURS.join(' and ')} px): look at every one, and re-capture a state yourself when a capture looks stale. Each state is the section \`#etat-<état>\` of the mockup.`,
    second
      ? 'This is the second and last review: the spec writer fixed the points of the first one (below). Check them first, then review the whole mockup again.'
      : 'This is the first review of this mockup.',
  ];
  if (second && o.previous?.length) lines.push('', 'Points of the first review that the spec writer had to fix:', ...bulletLines(o.previous));
  return lines.join('\n');
}

/** Consigne de la seconde passe `spec` : les constats bloquants et majeurs de la revue UX de la maquette. */
export function reviewedText(constats: Constat[]): string {
  return [
    'The UX review of your mockup found the blocking and major points below. Fix exactly these in the mockup, the captures and the sheet (one more pass only: the mockup is reviewed again, and what remains goes back to the lead). Keep the sheet consistent with the mockup — every field, every rule message visible in the state its `etat` names, every `data-testid`:',
    ...bulletLines(constats),
  ].join('\n');
}
