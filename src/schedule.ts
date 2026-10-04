import { endAfterWorkdays, maxDay, workdayAt, workdaysThrough, type Day } from './dates.js';
import type { Commit } from './git.js';
import type { Lot } from './plan.js';
import { isRecurring } from './recurring.js';

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
export function schedule(all: Lot[], commitsByLot: Map<string, Commit[]>, today: Day): Bar[] {
  // Un lot récurrent ne se termine pas : il n'a pas de place dans la file.
  const lots = all.filter((l) => !isRecurring(l));
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

  // Les lots à faire se placent en jours ouvrés fractionnaires : deux lots d'une
  // demi-journée partagent la même journée. Position 0 = premier jour ouvré à partir d'aujourd'hui.
  const endPos = new Map<string, number>();
  // Une seule file : la suite commence après les lots en cours.
  let cursor = Math.max(
    0,
    ...[...bars.values()].filter((b) => b.lot.status === 'doing').map((b) => workdaysThrough(today, b.end)),
  );
  let pending = lots.filter((l) => l.status === 'todo');
  while (pending.length > 0) {
    const ready = (l: Lot) =>
      l.after.every((d) => bars.has(d) || !lots.some((x) => x.id === d && x.status === 'todo'));
    // Premier lot prêt dans l'ordre du fichier ; en cas de cycle, le premier tout court.
    const lot = pending.find(ready) ?? pending[0];
    pending = pending.filter((l) => l !== lot);
    let startPos = cursor;
    for (const d of lot.after) {
      const dep = bars.get(d);
      if (!dep || dep.lot.status === 'dropped') continue;
      startPos = Math.max(startPos, endPos.get(d) ?? workdaysThrough(today, dep.end));
    }
    const end = startPos + lot.estimate;
    endPos.set(lot.id, end);
    bars.set(lot.id, {
      lot,
      start: workdayAt(today, Math.floor(startPos)),
      end: workdayAt(today, Math.max(Math.floor(startPos), Math.ceil(end) - 1)),
      projected: true,
      commits: count(lot.id),
    });
    cursor = end;
  }

  return lots.flatMap((l) => bars.get(l.id) ?? []);
}
