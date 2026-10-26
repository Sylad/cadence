import type { Day } from './dates.js';
import type { Lot } from './plan.js';

/** Une note de clôture et les lots qu'elle cite alors qu'ils sont déjà finis : « L217 done le 24-10 ». */
export interface NoteCheck {
  line: string;
  stale: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** « 2026-10-24 » → « 24-10 » : la note est récente, l'année ne se lit pas. */
const dayMonth = (d: Day) => `${d.slice(8, 10)}-${d.slice(5, 7)}`;

/**
 * Pour chaque ligne de note, les lots `done` ou `dropped` qu'elle cite, dans l'ordre de la ligne. Un identifiant se
 * lit entier : `L2` n'est pas cité par `L217`, ni `B28` par `B28.8`, mais un point final (`reprendre L2.`) ne le prolonge pas.
 */
export function staleNotes(lines: string[], lots: Lot[]): NoteCheck[] {
  const finished = lots.filter((l) => l.status === 'done' || l.status === 'dropped');
  return lines.map((line) => {
    const hits = finished
      .map((l) => ({ l, at: line.search(new RegExp(`(?<![\\w./-])${escape(l.id)}(?![\\w/-]|\\.\\w)`)) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at);
    return { line, stale: hits.map(({ l }) => `${l.id} ${l.status}${l.finished ? ` le ${dayMonth(l.finished)}` : ''}`) };
  });
}

export const staleText = (stale: string[]) => `⚠ note périmée : ${stale.join(', ')}`;

/** Les notes telles quelles, celles qui citent un lot fini suivies de « ⚠ note périmée : … ». */
export function staleNoteLines(lines: string[], lots: Lot[]): string[] {
  return staleNotes(lines, lots).map((n) => (n.stale.length ? `${n.line} ${staleText(n.stale)}` : n.line));
}
