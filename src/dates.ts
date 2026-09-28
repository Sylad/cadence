/** Calendar dates are plain `YYYY-MM-DD` strings, handled in UTC to avoid DST drift. */
export type Day = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is Day {
  return typeof value === 'string' && DAY_RE.test(value);
}

export function toDay(date: Date): Day {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parse(day: Day): Date {
  return new Date(`${day}T00:00:00Z`);
}

function format(date: Date): Day {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: Day, n: number): Day {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return format(d);
}

export function isWeekend(day: Day): boolean {
  const w = parse(day).getUTCDay();
  return w === 0 || w === 6;
}

/** First working day on or after `day`. */
export function nextWorkday(day: Day): Day {
  let d = day;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/**
 * Start on the first working day at or after `start`, spend `days` working days
 * (fractions round up) and return the last day worked.
 */
export function endAfterWorkdays(start: Day, days: number): Day {
  let d = nextWorkday(start);
  let left = Math.max(1, Math.ceil(days));
  while (--left > 0) d = nextWorkday(addDays(d, 1));
  return d;
}

export function diffDays(from: Day, to: Day): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

export function maxDay(a: Day, b: Day): Day {
  return a > b ? a : b;
}

/** The `n`-th working day (0-based) counted from the first working day at or after `base`. */
export function workdayAt(base: Day, n: number): Day {
  let d = nextWorkday(base);
  for (let i = 0; i < n; i++) d = nextWorkday(addDays(d, 1));
  return d;
}

/** Number of working days from the first working day at or after `base` through `day` inclusive. */
export function workdaysThrough(base: Day, day: Day): number {
  let n = 0;
  for (let d = nextWorkday(base); d <= day; d = nextWorkday(addDays(d, 1))) n++;
  return n;
}
