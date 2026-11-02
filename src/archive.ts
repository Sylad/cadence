import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Day } from './dates.js';
import type { Lot } from './plan.js';

/**
 * Archive du plan (L396) : un détail de STOCKAGE. Les lots done et dropped quittent le fichier `.cadence/raf.yaml` pour
 * `.cadence/archive/<année>.yaml` (l'année de leur fin), mais le plan chargé (`Plan.load`) les présente tous : `plan.lots()`
 * rend la même chose avant et après `raf archive`, et aucun lecteur n'a à connaître l'archive. Seul le fichier du plan
 * actif devient petit, et les briefs disent aux sessions de ne jamais ouvrir `.cadence/archive/`.
 */
export const ARCHIVE_DIR = 'archive';

export interface Kept {
  id: string;
  /** Pourquoi le lot reste dans le plan, dit tel quel à l'utilisateur. */
  why: string;
}

/**
 * Les lots à déplacer et ceux qui restent, parmi `lots` (ceux du fichier actif). Un lot reste seulement quand `blocked` le dit (un
 * écart que `raf check` signale encore) : les lecteurs voyant l'archive, un lot cité par `after` ou compté par un `gate` s'archive
 * comme les autres sans rien changer à ce qu'ils lisent. `before` : seuls les lots terminés strictement avant ce jour (un lot sans
 * date de fin reste).
 */
export function selectArchivable(lots: Lot[], before?: Day, blocked: (lot: Lot) => string | null = () => null): { move: Lot[]; kept: Kept[] } {
  const closed = (l: Lot) => (l.status === 'done' || l.status === 'dropped') && (before === undefined || (!!l.finished && l.finished < before));
  const move: Lot[] = [];
  const kept: Kept[] = [];
  for (const l of lots.filter(closed)) {
    const why = blocked(l);
    if (why) kept.push({ id: l.id, why });
    else move.push(l);
  }
  return { move, kept };
}

/** Le numéro d'un identifiant (`L12` → 12) ; NaN pour un identifiant sans numéro. */
const num = (id: string) => Number(/\d+$/.exec(id)?.[0] ?? NaN);

/** La clé d'un lot archivé qui garde sa place : l'identifiant du lot qui le précédait dans le plan présenté (vide : il le commençait). */
export const PLACE_KEY = 'place';

/**
 * Les lots archivés remis à leur place parmi ceux du fichier actif. Un lot qui porte un rang (`places` : id → id du lot qui le précédait
 * dans le plan présenté au moment de l'archivage, `raf archive` le pose sur tout lot archivé dès que `plan.idPattern` est déclaré : le nombre final d'un id ne dit alors rien de
 * l'ordre) revient juste après ce lot, en tête quand le rang est vide, à la fin quand le lot du rang n'existe plus. Les autres vont juste
 * avant le premier lot actif de numéro plus grand, à la fin sinon, entre eux par numéro. L'ordre du fichier actif ne bouge jamais ; un plan que
 * `raf add` tient dans l'ordre des numéros (le cas ordinaire) se lit exactement comme avant l'archivage (L396).
 */
export function mergeArchived(archived: Lot[], active: Lot[], places: ReadonlyMap<string, string> = new Map()): Lot[] {
  const queue = archived.filter((l) => !places.has(l.id)).sort((a, b) => num(a.id) - num(b.id) || 0);
  const out: Lot[] = [];
  for (const lot of active) {
    const n = num(lot.id);
    while (queue.length > 0 && !(num(queue[0].id) >= n)) out.push(queue.shift()!);
    out.push(lot);
  }
  out.push(...queue);
  return placeRanked(out, archived.filter((l) => places.has(l.id)), places);
}

/**
 * Pose les lots à rang derrière leur prédécesseur, en un passage (L536 : sous `plan.idPattern` les archivés forment une seule chaîne de rangs,
 * un plan de 685 lots ne peut pas payer k²·n à chaque lecture). Les lots d'un même rang se suivent dans l'ordre d'archivage (celui du fichier),
 * chacun suivi des lots dont il est lui-même le rang ; le rang vide ouvre le plan. Un lot dont le prédécesseur ne viendra jamais (inconnu,
 * cycle, lui-même) va à la fin du plan, dans l'ordre d'archivage.
 */
function placeRanked(out: Lot[], ranked: Lot[], places: ReadonlyMap<string, string>): Lot[] {
  const followers = new Map<string, Lot[]>();
  for (const l of ranked) {
    const from = places.get(l.id)!;
    followers.set(from, [...(followers.get(from) ?? []), l]);
  }
  const result: Lot[] = [];
  const placed = new Set<Lot>();
  // Un lot posé entraîne ses suiveurs, puis les leurs : le parcours en profondeur (pile explicite, une chaîne peut être longue) rend
  // exactement l'ordre que donnait la pose tour par tour.
  const emit = (from: string) => {
    const stack = [[...(followers.get(from) ?? [])].reverse()];
    while (stack.length > 0) {
      const next = stack[stack.length - 1].pop();
      if (next === undefined) stack.pop();
      else if (!placed.has(next)) {
        result.push(next);
        placed.add(next);
        stack.push([...(followers.get(next.id) ?? [])].reverse());
      }
    }
  };
  emit('');
  // Un prédécesseur dont l'id est aussi dans le fichier actif (plan déjà en erreur) : les suiveurs vont derrière celui du fichier.
  const seen = new Set<string>();
  for (const lot of out) {
    result.push(lot);
    if (!seen.has(lot.id)) emit(lot.id);
    seen.add(lot.id);
  }
  return [...result, ...ranked.filter((l) => !placed.has(l))];
}

/**
 * Les rangs à réécrire quand des lots archivés rouvrent (`back`, parmi `nodes`, les lots de toutes les archives) : un lot dont le `place:` nommait un lot
 * rouvert est re-pointé sur le prédécesseur de celui-ci, de proche en proche, pour que seul le lot rouvert bouge dans le plan présenté (L536). Un lot rouvert
 * sans rang (archivé avant `plan.idPattern`) prend pour prédécesseur celui du plan présenté (`order`, lu seulement alors). Rend les lots restés archivés dont le rang change.
 */
export function repointPlaces(nodes: YAMLMap[], back: YAMLMap[], order: () => string[]): Map<YAMLMap, string> {
  const places = new Map<YAMLMap, string>();
  for (const n of nodes) {
    const v = n.get(PLACE_KEY);
    if (typeof v === 'string' || v === null) places.set(n, v ?? '');
  }
  let presented: string[] | undefined;
  for (const n of back.filter((b) => !places.has(b))) {
    presented ??= order();
    places.set(n, presented[presented.indexOf(String(n.get('id'))) - 1] ?? '');
  }
  const moved = new Map<YAMLMap, string>();
  for (const n of back) {
    const id = String(n.get('id'));
    for (const s of nodes.filter((o) => places.get(o) === id)) {
      places.set(s, places.get(n)!);
      if (!back.includes(s)) moved.set(s, places.get(s)!);
    }
  }
  return moved;
}

/** Année de rangement d'un lot : celle de sa fin, à défaut de sa création, à défaut d'aujourd'hui. */
export function archiveYear(lot: Lot, today: Day): string {
  return (lot.finished ?? lot.created ?? today).slice(0, 4);
}

/** Fichiers `<année>.yaml` du dossier d'archive, du plus ancien au plus récent ; vide sans dossier. */
export function archiveFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}\.yaml$/.test(f)).sort().map((f) => join(dir, f));
}

/** La liste des lots d'un document d'archive (toujours présente : `readArchiveDoc` et `newArchiveDoc` la garantissent). */
export function archiveLots(doc: Document): YAMLSeq {
  return doc.get('lots') as YAMLSeq;
}

/** Un fichier d'archive lu tel quel ; une archive illisible est une erreur nommée, pas un lot de moins. */
export function readArchiveDoc(file: string): Document {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`${file} : ${doc.errors[0].message}`);
  const lots = isMap(doc.contents) ? doc.get('lots') : undefined;
  if (!isSeq(lots)) throw new Error(`${file} : la clé « lots » doit porter la liste des lots archivés`);
  lots.flow = false;
  return doc;
}

/** Le document d'un fichier d'année qui n'existe pas encore. */
export function newArchiveDoc(year: string): Document {
  const doc = new Document({ version: 1, lots: [] });
  doc.commentBefore = ` Lots terminés ou abandonnés de ${year}, déplacés du fichier du plan par « raf archive ». Lecture seule pour les sessions : ne pas l'ouvrir, « raf show <id> » lit un lot archivé.`;
  archiveLots(doc).flow = false;
  return doc;
}
