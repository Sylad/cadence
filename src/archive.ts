import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Day } from './dates.js';
import type { Lot } from './plan.js';

/**
 * Archive du plan (L396) : les lots done et dropped quittent `.cadence/raf.yaml` pour `.cadence/archive/<année>.yaml`
 * (l'année de leur fin). Le plan actif reste ce que lisent les sessions ; l'archive n'est lue que par les commandes
 * qui retrouvent un lot par son identifiant (show, commits, check, news, perf) — jamais par un brief.
 */
export const ARCHIVE_DIR = 'archive';

export interface Kept {
  id: string;
  /** Pourquoi le lot reste dans le plan, dit tel quel à l'utilisateur. */
  why: string;
}

/**
 * Les lots à déplacer et ceux qui restent. Un lot reste quand un lot du plan qui reste le cite (`after` : sa sortie
 * ferait un `bad-dependency`), ou quand il compte pour la condition de tirage (`gate`) d'un lot encore
 * ouvert : l'archiver baisserait le compte. `before` : seuls les lots terminés strictement avant ce jour (un lot sans date de fin reste).
 */
export function selectArchivable(lots: Lot[], before?: Day): { move: Lot[]; kept: Kept[] } {
  const closed = (l: Lot) => (l.status === 'done' || l.status === 'dropped') && (before === undefined || (!!l.finished && l.finished < before));
  const move = new Map(lots.filter(closed).map((l) => [l.id, l]));
  const kept: Kept[] = [];
  const keep = (id: string, why: string) => {
    move.delete(id);
    kept.push({ id, why });
  };
  for (const l of lots) {
    if (!l.gate || l.gate.invalid || move.has(l.id) || l.status === 'done' || l.status === 'dropped') continue;
    for (const c of lots) {
      if (move.has(c.id) && c.status === 'done' && (l.gate.criterion === 'spec' ? c.spec === true : c.screen === 'page')) keep(c.id, `compte pour le gate de ${l.id}`);
    }
  }
  // Un lot gardé peut en retenir d'autres : on boucle jusqu'à ce que plus rien ne bouge.
  for (let moved = true; moved; ) {
    moved = false;
    for (const l of lots) {
      if (move.has(l.id)) continue;
      for (const ref of l.after) {
        if (move.has(ref)) {
          keep(ref, `cité par ${l.id} (after)`);
          moved = true;
        }
      }
    }
  }
  return { move: lots.filter((l) => move.has(l.id)), kept };
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

/** Les lots bruts d'un fichier d'archive ; une archive illisible est une erreur nommée, pas un lot de moins. */
export function readArchiveFile(file: string): Record<string, unknown>[] {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`${file} : ${doc.errors[0].message}`);
  const lots = isMap(doc.contents) ? doc.get('lots') : undefined;
  if (!isSeq(lots)) throw new Error(`${file} : la clé « lots » doit porter la liste des lots archivés`);
  return lots.toJSON() as Record<string, unknown>[];
}

/** Ajoute les nœuds au fichier de l'année (créé au besoin) ; un identifiant déjà archivé n'est pas ajouté deux fois (rejeu après un échec d'écriture du plan). */
export function appendToArchive(dir: string, year: string, nodes: YAMLMap[]): string {
  const file = join(dir, `${year}.yaml`);
  const doc = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : new Document({ version: 1, lots: [] });
  if (doc.errors.length > 0) throw new Error(`${file} : ${doc.errors[0].message}`);
  let seq = doc.get('lots') as YAMLSeq | undefined;
  if (!isSeq(seq)) {
    seq = doc.createNode([]) as YAMLSeq;
    doc.set('lots', seq);
  }
  seq.flow = false;
  const have = new Set(seq.items.filter(isMap).map((n) => String(n.get('id'))));
  for (const n of nodes) if (!have.has(String(n.get('id')))) seq.add(n);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) doc.commentBefore = ` Lots terminés ou abandonnés de ${year}, déplacés du plan par « raf archive ». Lecture seule pour les sessions : ne pas l'ouvrir.`;
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return file;
}
