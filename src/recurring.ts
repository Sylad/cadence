import { diffDays, type Day } from './dates.js';
import type { Lot } from './plan.js';

export function isRecurring(lot: Lot): boolean {
  return lot.every !== undefined && (lot.status === 'todo' || lot.status === 'doing');
}

/** Retard en jours sur l'échéance (`last`, sinon `created`, sinon `started`, + `every`) : négatif tant qu'elle n'est pas là. */
export function dueDays(lot: Lot, today: Day): number {
  const from = lot.last ?? lot.created ?? lot.started ?? today;
  return diffDays(from, today) - (lot.every ?? 0);
}

export function dueLine(lot: Lot, today: Day): string {
  const late = dueDays(lot, today);
  if (late > 0) return `dû depuis ${late} j`;
  return late === 0 ? "dû aujourd'hui" : `prochain dans ${-late} j`;
}

/** Les lots récurrents ouverts, du plus en retard au moins en retard — partagé par raf now et session start. */
export function recurringByDue(lots: Lot[], today: Day): Lot[] {
  return lots.filter(isRecurring).sort((a, b) => dueDays(b, today) - dueDays(a, today));
}
