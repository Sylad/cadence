// Définition unique de « lire » et « écrire » dans un transcript Claude Code, partagée par le hook
// lecture-obligatoire.mjs (bras candidat) et par la mesure lectureReferences (src/sequence/mesures.ts) :
// le hook et la mesure ne peuvent pas diverger. JavaScript sans dépendance : le hook tourne sous node nu.
import { isAbsolute, relative, resolve } from 'node:path';

/** Outils qui écrivent un fichier. Une écriture par Bash (sed -i, tee, redirection) n'est pas vue : limite connue. */
export const ECRITURES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Chemin visé par un outil (Read, Edit, Write, MultiEdit : file_path ; NotebookEdit : notebook_path). */
export const cheminOutil = (input) => {
  const f = input?.file_path ?? input?.notebook_path;
  return typeof f === 'string' ? f : undefined;
};

/** R30 : une lecture ne compte que si elle est entière, sans offset, limit ni pages. Une image lue compte (aucun de ces champs). */
export const lectureEntiere = (input) => input?.pages === undefined && input?.limit === undefined && input?.offset === undefined;

/** `p` est le clone ou dedans. */
export const dansClone = (p, clone) => {
  const r = relative(resolve(clone), resolve(p));
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r);
};

/** Appels d'outils d'une ligne de transcript (messages assistant, sous-agents compris) ; [] si la ligne n'en a pas. */
export function appelsOutils(ligne) {
  let d;
  try { d = JSON.parse(ligne); } catch { return []; }
  if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) return [];
  return d.message.content.filter((c) => c?.type === 'tool_use' && typeof c.name === 'string').map((c) => ({ name: c.name, input: c.input ?? {} }));
}
