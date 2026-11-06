import type { Constat } from './state.js';

/** Les classes de défaut de la grille du code-reviewer (L523) ; le relecteur en range chaque constat dans une (L646). */
export const CLASSES = ['bug-code', 'architecture', 'test', 'code-mort', 'erreur-avalee', 'documentation', 'convention'] as const;
export type Classe = (typeof CLASSES)[number];

/** La classe d'une valeur lue dans un rapport : une valeur inconnue ou d'un autre type n'est pas une classe. */
export const classeOf = (v: unknown): Classe | undefined => CLASSES.find((c) => c === v);

const line = (k: Constat): string => `- [${k.gravite}${k.source === 'code' ? '' : ` / ${k.source}`}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`;

const CLASS_RULE =
  'Each finding is one instance of a class of defect. Fix every other instance of the class in the diff of the lot (and in the callers of what you changed), not only the quoted line, and give each instance its own test: the next fresh review reports the instance you left.';

/**
 * `{{constats}}` du brief de fix (L646, gabarit `fix` seul : un autre gabarit reçoit la liste plate) : les constats de la revue précédente groupés par classe (sans classe : « other »), puis l'exigence de corriger la classe entière.
 * Aucun constat classé : la liste reste plate (la revue d'UX et la porte n'ont pas de classe). Aucun constat : vide.
 */
export function fixConstatsText(constats: Constat[], template = 'fix'): string {
  if (!constats.length) return '';
  // `fix-docs` et `fix-minors` ont leur propre périmètre (« la documentation et rien d'autre », « chaque mineur qui est juste ») que la consigne de classe contredirait : liste plate, sans consigne.
  if (template !== 'fix') return constats.map(line).join('\n');
  if (!constats.some((k) => k.classe)) return [...constats.map(line), '', CLASS_RULE].join('\n');
  const groups = new Map<string, Constat[]>();
  for (const k of constats) groups.set(k.classe ?? 'other', [...(groups.get(k.classe ?? 'other') ?? []), k]);
  const out = [...groups].flatMap(([name, list]) => [`Class « ${name} » (${list.length} finding${list.length > 1 ? 's' : ''}):`, ...list.map(line)]);
  return [...out, '', CLASS_RULE].join('\n');
}
