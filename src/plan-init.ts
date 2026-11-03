import type { Day } from './dates.js';

/** Le contenu d'un plan neuf, tel que `raf init` l'écrit. */
export function initialContent(project: string, prefix: string, since: Day): string {
  return `# Plan « reste à faire » tenu par raf (https://github.com/Sylad/cadence).
# Édité par le CLI, mais les modifications à la main et les commentaires sont préservés.
# Un commit appartient à un lot quand son message cite l'identifiant (${prefix}3, ${prefix}3/t1).
version: 1
project: ${JSON.stringify(project)}
prefix: ${prefix}
since: ${since}       # raf check ignore les commits antérieurs à l'adoption
lots: []
`;
}
