import { addDays, endAfterWorkdays, maxDay, nextWorkday, type Day } from './dates.js';
import type { Commit } from './git.js';
import type { Lot } from './plan.js';

export interface Bar {
  lot: Lot;
  start: Day;
  end: Day;
  /** True when the dates are a forecast rather than history. */
  projected: boolean;
  commits: number;
}

/**
 * One lane of work: finished lots use their real dates, lots in progress run to
 * max(estimate, today), lots to do follow in file order after their dependencies.
 */
export function schedule(lots: Lot[], commitsByLot: Map<string, Commit[]>, today: Day): Bar[] {
  const bars = new Map<string, Bar>();
  const firstCommit = (id: string) => commitsByLot.get(id)?.at(-1)?.day;
  const lastCommit = (id: string) => commitsByLot.get(id)?.[0]?.day;
  const count = (id: string) => commitsByLot.get(id)?.length ?? 0;

  for (const lot of lots) {
    if (lot.status === 'done' || lot.status === 'dropped') {
      const start = lot.started ?? firstCommit(lot.id) ?? lot.finished ?? lastCommit(lot.id);
      if (!start) continue;
      const end = maxDay(start, lot.finished ?? lastCommit(lot.id) ?? start);
      bars.set(lot.id, { lot, start, end, projected: false, commits: count(lot.id) });
    } else if (lot.status === 'doing') {
      const start = lot.started ?? firstCommit(lot.id) ?? today;
      const end = maxDay(endAfterWorkdays(start, lot.estimate), today);
      bars.set(lot.id, { lot, start, end, projected: true, commits: count(lot.id) });
    }
  }

  let cursor = nextWorkday(today);
  let pending = lots.filter((l) => l.status === 'todo');
  while (pending.length > 0) {
    const ready = (l: Lot) =>
      l.after.every((d) => bars.has(d) || !lots.some((x) => x.id === d && x.status === 'todo'));
    // Premier lot prêt dans l'ordre du fichier ; en cas de cycle, le premier tout court.
    const lot = pending.find(ready) ?? pending[0];
    pending = pending.filter((l) => l !== lot);
    let start = cursor;
    for (const d of lot.after) {
      const dep = bars.get(d);
      if (dep && dep.lot.status !== 'dropped') start = maxDay(start, nextWorkday(addDays(dep.end, 1)));
    }
    const end = endAfterWorkdays(start, lot.estimate);
    bars.set(lot.id, { lot, start, end, projected: true, commits: count(lot.id) });
    cursor = nextWorkday(addDays(end, 1));
  }

  return lots.flatMap((l) => bars.get(l.id) ?? []);
}
