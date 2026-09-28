import { describe, expect, it } from 'vitest';
import { endAfterWorkdays, nextWorkday } from '../src/dates.js';
import type { Commit } from '../src/git.js';
import type { Lot } from '../src/plan.js';
import { schedule } from '../src/schedule.js';

const MONDAY = '2026-09-28';

function lot(id: string, extra: Partial<Lot> = {}): Lot {
  return { id, title: id, status: 'todo', estimate: 1, quickwin: false, after: [], notes: [], tasks: [], problems: [], ...extra };
}
const span = (bars: ReturnType<typeof schedule>) => Object.fromEntries(bars.map((b) => [b.lot.id, [b.start, b.end]]));

describe('workdays', () => {
  it('skips weekends', () => {
    expect(nextWorkday('2026-10-03')).toBe('2026-10-05');
    expect(endAfterWorkdays('2026-10-01', 3)).toBe('2026-10-05');
    expect(endAfterWorkdays(MONDAY, 0.5)).toBe(MONDAY);
  });
});

describe('schedule', () => {
  it('chains todo lots in file order on one lane', () => {
    const bars = schedule([lot('L1', { estimate: 2 }), lot('L2', { estimate: 4 })], new Map(), MONDAY);
    expect(span(bars)).toEqual({ L1: ['2026-09-28', '2026-09-29'], L2: ['2026-09-30', '2026-10-05'] });
  });

  it('waits for a dependency declared later in the file', () => {
    const bars = schedule([lot('L1', { after: ['L2'] }), lot('L2', { estimate: 2 })], new Map(), MONDAY);
    expect(span(bars)).toEqual({ L2: ['2026-09-28', '2026-09-29'], L1: ['2026-09-30', '2026-09-30'] });
    expect(bars.map((b) => b.lot.id)).toEqual(['L1', 'L2']); // ordre du fichier conservé
  });

  it('uses real dates for finished lots and commits when dates are missing', () => {
    const commits = new Map<string, Commit[]>([
      ['L2', [{ sha: 'b', day: '2026-09-10', subject: '', body: '' }, { sha: 'a', day: '2026-09-08', subject: '', body: '' }]],
    ]);
    const bars = schedule(
      [lot('L1', { status: 'done', started: '2026-09-01', finished: '2026-09-03' }), lot('L2', { status: 'done' })],
      commits,
      MONDAY,
    );
    expect(span(bars)).toEqual({ L1: ['2026-09-01', '2026-09-03'], L2: ['2026-09-08', '2026-09-10'] });
    expect(bars.every((b) => !b.projected)).toBe(true);
  });

  it('runs a late lot in progress up to today', () => {
    const bars = schedule([lot('L1', { status: 'doing', started: '2026-09-01', estimate: 2 })], new Map(), MONDAY);
    expect(span(bars)).toEqual({ L1: ['2026-09-01', MONDAY] });
  });

  it('packs half-day lots into the same day', () => {
    const bars = schedule([lot('L1', { estimate: 0.5 }), lot('L2', { estimate: 0.5 }), lot('L3', { estimate: 0.5 })], new Map(), MONDAY);
    expect(span(bars)).toEqual({ L1: [MONDAY, MONDAY], L2: [MONDAY, MONDAY], L3: ['2026-09-29', '2026-09-29'] });
  });

  it('starts after a dependency already in progress', () => {
    const bars = schedule(
      [lot('L1', { status: 'doing', started: MONDAY, estimate: 3 }), lot('L2', { after: ['L1'] })],
      new Map(),
      MONDAY,
    );
    expect(span(bars)).toEqual({ L1: [MONDAY, '2026-09-30'], L2: ['2026-10-01', '2026-10-01'] });
  });

  it('does not loop forever on a dependency cycle', () => {
    const bars = schedule([lot('L1', { after: ['L2'] }), lot('L2', { after: ['L1'] })], new Map(), MONDAY);
    expect(bars).toHaveLength(2);
  });
});
