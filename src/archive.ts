import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml';
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

/**
 * Les lots archivés remis à leur place parmi ceux du fichier actif : chacun juste avant le premier lot actif de numéro plus grand, à la fin
 * sinon, les archivés entre eux par numéro. L'ordre du fichier actif ne bouge jamais ; un plan que `raf add` tient dans l'ordre des numéros
 * (le cas ordinaire) se lit exactement comme avant l'archivage (L396).
 */
export function mergeArchived(archived: Lot[], active: Lot[]): Lot[] {
  const queue = [...archived].sort((a, b) => num(a.id) - num(b.id) || 0);
  const out: Lot[] = [];
  for (const lot of active) {
    const n = num(lot.id);
    while (queue.length > 0 && !(num(queue[0].id) >= n)) out.push(queue.shift()!);
    out.push(lot);
  }
  return [...out, ...queue];
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
