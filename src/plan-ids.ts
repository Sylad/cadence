// Identifiants d'un plan natif (L465) : comment un message de commit les cite, et comment `plan.idPattern` en déclare de libres.
export type Ref = { lot: string; task?: string };

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ce qui ne peut pas suivre un identifiant cité : un point suivi d'un caractère de mot — « L1.4 » n'est
 * pas le lot L1, « NC2.4 » n'est pas NC2 — alors que le point qui finit une phrase (« voir L1. ») passe.
 * Même garde pour le format de raf et pour les identifiants d'un plan en lecture seule.
 */
export const DOTTED = '\\.\\w';

/** Matches `L3` or `L3/t1` as whole words. Group 1 = lot id, group 2 = task id. */
function refPattern(prefix: string): RegExp {
  return new RegExp(`(?<![\\w/])(${escapeRe(prefix)}\\d+)(?:/(t\\d+))?(?!\\w|${DOTTED})`, 'g');
}

export function extractRefs(text: string, prefix: string): Ref[] {
  return [...text.matchAll(refPattern(prefix))].map((m) => ({ lot: m[1], task: m[2] }));
}

/**
 * Le motif des références d'un plan natif qui déclare `plan.idPattern` : `<préfixe>\d+` ou le motif du projet, puis un sous-id `/slug` facultatif
 * (`X7/t1-fusion`). Garde des `<préfixe>\d+` : celle du format de raf (pas collés à un mot ni à un chemin, pas suivis d'un point et d'un mot ; « feat(L3-L5) » cite L3 et L5) ; les ids du motif du projet, plus strictes, refusent aussi un `-` ou un `.` avant et un `-` après (« AB-1-x »). Le point de fin de phrase passe.
 * Seul le groupe nommé `sub` est capturé, après le motif du projet : ses groupes numérotés (`([A-Z])\1\d+`) gardent leur numéro. L'id est le reste de la correspondance.
 */
function idRefPattern(prefix: string, idPattern: string): RegExp {
  const own = `(?<![\\w/])${escapeRe(prefix)}\\d+`;
  const free = `(?<![\\w/.-])(?:${idPattern})(?=/|(?!-))`;
  return new RegExp(`(?:${own}|${free})(?:/(?<sub>[\\w-]+(?:\\.[\\w-]+)*)(?![\\w-]|${DOTTED})|(?!\\w|${DOTTED}))`, 'g');
}

/** Références d'un message dans un plan natif qui déclare `plan.idPattern`. Un sous-id `t<n>` est une sous-tâche du lot ; tout autre (`t1-fusion`) n'est qu'une précision sur le lot cité. */
export function idRefs(text: string, prefix: string, idPattern: string): Ref[] {
  return [...text.matchAll(idRefPattern(prefix, idPattern))].map((m) => {
    const sub = m.groups!.sub;
    return { lot: sub === undefined ? m[0] : m[0].slice(0, -(sub.length + 1)), ...(/^t\d+$/.test(sub ?? '') ? { task: sub } : {}) };
  });
}

/** Ce que le motif `plan.idPattern` a de refusable (ancres, groupe nommé `id` ou `sub` réservé, id vide), null s'il est utilisable. Vérifié à la lecture de cadence.yaml. */
function idPatternProblem(idPattern: string): string | null {
  if (idPattern.trim() === '') return 'est vide';
  if (/^\^|(?<!\\)\$$/.test(idPattern)) return "ne prend pas d'ancre (^ ou $) : le motif est ancré par raf";
  if (/\(\?<(?:id|sub)>/.test(idPattern)) return 'ne peut pas nommer un groupe « id » ou « sub » (noms réservés à raf)';
  try {
    idRefPattern('L', idPattern);
    if (new RegExp(`^(?:${idPattern})$`).test('')) return "accepte l'identifiant vide";
  } catch (e) {
    return `n'est pas une expression régulière utilisable (${(e as Error).message.split('\n')[0]})`;
  }
  return null;
}

/** Pourquoi `id` ne peut pas être donné à `raf add --id` : sans `plan.idPattern`, avec un « / » (réservé aux sous-tâches), hors du motif, ou déjà pris (archivés compris). Null s'il est libre. */
function freeIdProblem(id: string, idPattern: string | undefined, known: Set<string>): string | null {
  if (idPattern === undefined) return '--id exige plan.idPattern dans cadence.yaml : sans motif déclaré, les identifiants sont <préfixe><n> générés par raf';
  if (id.includes('/')) return `identifiant invalide : ${id} (« / » est réservé aux sous-tâches)`;
  if (!new RegExp(`^(?:${idPattern})$`).test(id)) return `identifiant invalide : ${id === '' ? '(vide)' : id} ne suit pas plan.idPattern (${idPattern})`;
  return known.has(id) ? `identifiant déjà pris : ${id}` : null;
}

/**
 * L'identifiant d'un lot ajouté : celui que `raf add --id` donne (libre, voir `freeIdProblem`), sinon `<préfixe><n+1>` ; `under`, le lot parent
 * d'un sous-lot, doit exister. `known` : tous les lots du plan, archivés compris — un identifiant n'est jamais réutilisé.
 */
export function pickId(prefix: string, given: string | undefined, under: string | undefined, idPattern: string | undefined, known: Set<string>): { id: string } | { problem: string } {
  if (under !== undefined && !known.has(under)) return { problem: `lot parent inconnu : ${under}` };
  if (given !== undefined) {
    const problem = freeIdProblem(given, idPattern, known);
    return problem ? { problem } : { id: given };
  }
  const re = new RegExp(`^${escapeRe(prefix)}(\\d+)$`);
  return { id: `${prefix}${Math.max(0, ...[...known].map((id) => Number(re.exec(id)?.[1] ?? 0))) + 1}` };
}

/** Le `parent:` d'un lot à plat : un identifiant de lot ; toute autre forme est un problème du lot et ne désigne aucun parent. */
export function readParent(raw: unknown, problems: string[]): { parent?: string } {
  if (raw == null) return {};
  if (typeof raw === 'string' && raw.trim() !== '') return { parent: raw.trim() };
  problems.push(`parent : un identifiant de lot attendu (reçu « ${String(raw)} »)`);
  return {};
}

/** `plan.idPattern` lu dans cadence.yaml : `{ idPattern }` (rien sans la clé), ou l'erreur que `bad` fabrique (qui nomme la clé). */
export function readIdPattern(raw: unknown, bad: (what: string) => Error): { idPattern?: string } {
  if (raw == null) return {};
  if (typeof raw !== 'string') throw bad('idPattern doit être une expression régulière (texte)');
  const problem = idPatternProblem(raw);
  if (problem) throw bad(`idPattern ${problem}`);
  return { idPattern: raw };
}
