import { posix } from 'node:path';
import { LARGEURS } from '../spec.js';
import type { Constat } from './state.js';

// Revue UX de la maquette (L172, spec etape-spec S4) : ce que le programme dit à l'agent ux-reviewer en mode « maquette », et à l'agent spec à la passe suivante.

/** Une ligne par constat : gravité, endroit, texte. */
export const bulletLines = (constats: Constat[]): string[] => constats.map((k) => `- [${k.gravite}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);

/** Consigne de la revue de maquette dans le brief : la fiche, la maquette, les captures attendues, le rang de la revue sur le plafond `max` (L230). */
export function maquetteText(o: { fiche: string; passes: number; max: number; previous?: Constat[] }): string {
  const folder = posix.dirname(o.fiche);
  const rank = o.passes + 1;
  const later = rank >= 2;
  const lines = [
    `Mockup mode: review the mockup \`${folder}/maquette.html\` against its sheet \`${o.fiche}\`. It is a local file, not an application: open it directly (file URL), do not start any server.`,
    `The spec writer committed the captures \`${folder}/maquette-<état>-<largeur>.png\` (one per state of the sheet and per width: ${LARGEURS.join(' and ')} px): look at every one, and re-capture a state yourself when a capture looks stale. Each state is the section \`#etat-<état>\` of the mockup.`,
    later
      ? `This is review ${rank} of ${o.max}${rank >= o.max ? ', the last review' : ''}: the spec writer fixed the points of the previous one (below). Check them first, then run the whole sweep again and report ALL the blocking and major findings of it in this report. Mark \`inchange: true\` on every blocking or major finding about a point the spec writer did not change and the previous review had not raised.`
      : `This is the first review of this mockup (${o.max} review${o.max > 1 ? 's' : ''} at most): there is no later review to keep a finding for. Report ALL the blocking and major findings in this first report; do not keep one back for a later review.`,
  ];
  if (later && o.previous?.length) lines.push('', 'Points of the previous review that the spec writer had to fix:', ...bulletLines(o.previous));
  return lines.join('\n');
}

/** Consigne de la passe `spec` qui suit une revue : les constats bloquants et majeurs de la revue UX de la maquette, la session `run` sur `max`. */
export function reviewedText(constats: Constat[], o: { run: number; max: number }): string {
  return [
    `The UX review of your mockup found the blocking and major points below. Fix exactly these in the mockup, the captures and the sheet (spec session ${o.run} of ${o.max}: the mockup is reviewed again, and what remains after the last review goes back to the lead). Keep the sheet consistent with the mockup — every field, every rule message visible in the state its \`etat\` names, every \`data-testid\`:`,
    ...bulletLines(constats),
  ].join('\n');
}
