/** Estimate (en jours) que le délai de base `timeouts.work` couvre : un lot jusqu'à un quart de jour. */
export const BASE_ESTIMATE = 0.25;
/** Majoration d'un lot à fiche (étape spec, écran ou `spec: true`) : la session lit la fiche et écrit un test par règle. */
export const FICHE_FACTOR = 1.5;
/** Plafond du délai proportionné, en multiples du délai de base. */
export const MAX_FACTOR = 4;
/** Prolongation accordée à chaque échéance où la session a commité depuis la dernière. */
export const EXTENSION_MS = 15 * 60_000;
/** Nombre de prolongations au plus : 2 h de plus après le délai proportionné, la session qui commite sans fin finit par être coupée. */
export const MAX_EXTENSIONS = 8;

/**
 * Délai d'une étape d'écriture (L298) : le délai configuré (`timeouts.implement`, 45 min par défaut) vaut pour un lot de 0,25 j ;
 * il croît avec l'estimate (0,5 j : le double), d'un tiers en plus de moitié pour un lot à fiche, sans dépasser 4 fois le délai de base.
 */
export function workTimeoutMs(baseMs: number, estimate: number | undefined, fiche: boolean): number {
  const scale = Math.max(1, (estimate ?? BASE_ESTIMATE) / BASE_ESTIMATE) * (fiche ? FICHE_FACTOR : 1);
  return Math.round(Math.min(scale, MAX_FACTOR) * baseMs);
}

const isTest = (f: string): boolean => /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);

/** Fichiers listés au plus dans le message : au-delà, le nombre seul. */
const LISTED = 8;

/**
 * Phrase du tableau pour une étape d'écriture coupée à l'échéance (L298) : commits conservés, travail NON commité
 * (fichiers, dont les tests, lignes). `numstat` : sortie de `git diff --numstat HEAD` ; les fichiers non suivis n'y ont pas de lignes.
 */
export function cutReport(o: { minutes: number; commits: number; files: string[]; numstat: string }): string {
  const lines = o.numstat
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3)
    .reduce((n, p) => n + (Number(p[0]) || 0), 0);
  const kept = o.commits === 0 ? 'aucun commit' : `${o.commits} commit${o.commits > 1 ? 's' : ''} conservé${o.commits > 1 ? 's' : ''}`;
  const head = `coupé au délai de ${o.minutes} min : ${kept}`;
  if (o.files.length === 0) return `${head}, rien de non commité`;
  const tests = o.files.filter(isTest);
  const names = o.files.length > LISTED ? `${o.files.slice(0, LISTED).join(', ')}, …` : o.files.join(', ');
  const t = tests.length ? `, dont ${tests.length} de test (${tests.length > LISTED ? `${tests.slice(0, LISTED).join(', ')}, …` : tests.join(', ')})` : ', aucun de test';
  return `${head} ; travail NON commité : ${o.files.length} fichier${o.files.length > 1 ? 's' : ''} (${names})${t}${lines ? `, ${lines} lignes ajoutées` : ''} — laissé dans le dépôt, à commiter ou à reprendre par le lead`;
}
