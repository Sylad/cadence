// Import d'un plan tenu dans un autre format vers le natif, et retour (L472, M10) : les entrées sont traduites champ à champ,
// les clés que le format ne mappe pas sont gardées telles quelles, et chaque traduction est rejouée dans l'autre sens pour être comparée à l'original.
import { isDeepStrictEqual } from 'node:util';
import type { Day } from './dates.js';
import { FIELDS, RafError, STATUSES, type Field, type Lot, type PlanFormat } from './plan.js';
import { PLACE_KEY } from './archive.js';
import { readForeignEntry } from './plan-foreign.js';
import { normalizeLot } from './plan-read.js';

type Entry = Record<string, unknown>;

/** Les clés qu'un lot natif lit ou écrit : une clé du fichier d'origine qui les porte sans être mappée dessus changerait de sens (ou serait lue de travers), l'import la refuse. */
const RESERVED = new Set<string>([...FIELDS, 'state', 'state_before', 'delivered', 'uses', 'planned', 'local', 'ux', 'review', 'docs_ok', 'tasks', PLACE_KEY, 'estimate_label']);
/** Les champs recopiés tels quels (la valeur du fichier d'origine fait foi). */
const VERBATIM: Field[] = ['quickwin', 'visible', 'screen', 'spec', 'public', 'every', 'repos', 'gate', 'goal'];
const DAYS: Field[] = ['last', 'created', 'started', 'finished'];
/** Ce que le natif tient sous ses clés propres : le reste d'une entrée native est rendu tel quel au format d'origine. */
const NATIVE_OWN = new Set<string>([...FIELDS, 'state', 'estimate_label']);

/** Les clés renommées : `--rename ancien=nouveau`, l'ancien nom du fichier d'origine et le nom qu'il prend en natif. */
export type Renames = Record<string, string>;

const keyOf = (format: PlanFormat, field: Field): string => format.fields[field]?.[0] ?? field;
const labelOf = (format: PlanFormat, days: number): string | undefined => Object.entries(format.estimates).find(([, d]) => d === days)?.[0];
const day = (v: unknown): unknown => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v);

function refuse(problems: string[]): never {
  throw new RafError(problems.join('\n'));
}

/** Le statut d'une entrée : celui de raf, et l'état d'origine (`state:`) quand `plan.statuses` en traduit. */
function putStatus(entry: Entry, theirs: unknown, lot: Lot, format: PlanFormat, fail: (what: string) => void): void {
  const mapped = Object.keys(format.statuses).length > 0;
  if (!mapped && !STATUSES.includes(theirs as never)) fail(`état « ${String(theirs)} » ni mappé (plan.statuses) ni un statut de raf`);
  entry.status = lot.status;
  if (mapped) entry.state = String(theirs);
}

/** L'effort d'une entrée : en jours, et le libellé d'origine (`estimate_label:`) quand c'en est un. */
function putEstimate(entry: Entry, v: unknown, format: PlanFormat, fail: (what: string) => void): void {
  if (typeof v === 'string') [entry.estimate, entry.estimate_label] = [format.estimates[v], v];
  else if (typeof v === 'number' && v > 0) entry.estimate = v;
  else fail(`effort « ${String(v)} » illisible (un nombre de jours > 0 ou un libellé de plan.estimates)`);
}

/** Les clés du fichier d'origine que le format ne mappe pas, recopiées telles quelles (sous leur nom renommé) : une qui prendrait un nom du natif est refusée. */
function putExtras(entry: Entry, r: Entry, consumed: Set<string>, renames: Renames, fail: (what: string) => void): void {
  for (const [key, value] of Object.entries(r)) {
    if (consumed.has(key)) continue;
    const name = renames[key] ?? key;
    const reserved = RESERVED.has(name);
    if (reserved || name in entry) fail(`la clé « ${key} » du fichier d'origine n'est pas mappée et porte un nom du plan natif${reserved ? '' : ' déjà pris'} — la mapper (plan.fields) ou la renommer (--rename ${key}=autre)`);
    else entry[name] = value;
  }
}

/** Une entrée du fichier d'origine, en natif : clés de raf, `state:` = l'état d'origine, `estimate_label:` = le libellé d'effort d'origine. */
function nativeEntry(r: Entry, i: number, how: { format: PlanFormat; renames: Renames; today: Day }, seen: Set<string>, problems: string[]): Entry {
  const { format, renames, today } = how;
  const e = readForeignEntry(r, i, format);
  const id = e.lot.id;
  const fail = (what: string) => void problems.push(`${id} : ${what}`);
  if (seen.has(id)) fail('identifiant en double (deux entrées)');
  seen.add(id);
  e.lot.problems.forEach(fail);
  const used = e.used;
  const take = (field: Field): unknown => (used[field] === undefined ? undefined : r[used[field]!]);
  const entry: Entry = { id };
  if (used.title) entry.title = String(take('title'));
  if (used.status) putStatus(entry, take('status'), e.lot, format, fail);
  if (used.estimate) putEstimate(entry, take('estimate'), format, fail);
  for (const f of VERBATIM) if (used[f]) entry[f] = take(f);
  for (const f of DAYS) if (used[f]) entry[f] = day(take(f));
  if (used.after) entry.after = [take('after')].flat().map(String);
  if (used.notes) {
    const notes = take('notes');
    entry.notes = typeof notes === 'string' ? [{ date: today, text: notes }] : notes;
  }
  if (used.parent) entry.parent = e.parent;
  putExtras(entry, r, new Set(Object.values(used)), renames, fail);
  return entry;
}

/** Les entrées d'un plan d'un autre format, en natif. Refuse, en les nommant toutes, ce qu'il ne saurait pas tenir sans perte. */
export function nativeEntries(raw: Entry[], format: PlanFormat, renames: Renames, today: Day): Entry[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const out = raw.map((r, i) => nativeEntry(r, i, { format, renames, today }, seen, problems));
  if (problems.length > 0) refuse(problems);
  return out;
}

/** L'état d'origine d'une entrée native : `state:` tant qu'il porte encore le statut, sinon le premier état du format qui le porte (undefined : aucun) ; sans `plan.statuses`, le statut lui-même. */
function stateOf(n: Entry, format: PlanFormat): unknown {
  if (Object.keys(format.statuses).length === 0) return n.status;
  if (typeof n.state === 'string' && format.statuses[n.state] === n.status) return n.state;
  return Object.entries(format.statuses).find(([, s]) => s === n.status)?.[0];
}

/** Le libellé d'effort d'une entrée native : `estimate_label:` tant qu'il vaut encore les jours de l'estimation, sinon le libellé du format qui les vaut (undefined : aucun, le nombre). */
function labelFor(n: Entry, format: PlanFormat): string | undefined {
  const days = n.estimate as number;
  return typeof n.estimate_label === 'string' && format.estimates[n.estimate_label] === days ? n.estimate_label : labelOf(format, days);
}

/** Une entrée native, au format d'origine. */
function foreignEntry(n: Entry, format: PlanFormat, back: Record<string, string>, problems: string[]): Entry {
  const id = String(n.id);
  const fail = (what: string) => void problems.push(`${id} : ${what}`);
  const e: Entry = {};
  const put = (field: Field, value: unknown) => void (e[keyOf(format, field)] = value);
  put('id', n.id);
  if (n.title !== undefined) put('title', n.title);
  if (n.status !== undefined) {
    const state = stateOf(n, format);
    if (state === undefined) fail(`le statut « ${String(n.status)} » n'est porté par aucun état du plan d'origine (plan.statuses)`);
    else put('status', state);
  }
  if (n.estimate !== undefined) put('estimate', labelFor(n, format) ?? n.estimate);
  for (const f of [...VERBATIM, ...DAYS, 'after', 'notes', 'parent'] as Field[]) if (n[f] !== undefined) put(f, n[f]);
  for (const [key, value] of Object.entries(n)) {
    if (NATIVE_OWN.has(key)) continue;
    const name = back[key] ?? key;
    if (name in e) fail(`la clé « ${key} » reprendrait le nom « ${name} » d'un champ du plan d'origine (--rename)`);
    else e[name] = value;
  }
  readForeignEntry(e, 0, format).lot.problems.forEach(fail);
  return e;
}

/** Des entrées natives, au format d'origine (l'écriture inverse). `raf done` et les autres écritures du natif ne laissent pas toujours `state:` d'accord avec `status:` : `stateOf` en tient compte. */
export function foreignEntries(native: Entry[], format: PlanFormat, renames: Renames): Entry[] {
  const problems: string[] = [];
  const back = Object.fromEntries(Object.entries(renames).map(([from, to]) => [to, from]));
  const out = native.map((n) => foreignEntry(n, format, back, problems));
  if (problems.length > 0) refuse(problems);
  return out;
}

/** Ce qu'une entrée dit, pour être comparée à une autre : par champ de raf la valeur normalisée, et les clés que le format ne mappe pas. */
function view(r: Entry, format: PlanFormat): { fields: Partial<Record<Field, unknown>>; extras: Entry } {
  const fields: Partial<Record<Field, unknown>> = {};
  const consumed = new Set<string>();
  for (const f of FIELDS) {
    const key = (format.fields[f] ?? [f]).find((k) => r[k] != null);
    if (key === undefined) continue;
    consumed.add(key);
    const v = r[key];
    const canon = (): unknown => {
      if (f === 'id' || f === 'parent' || f === 'title' || f === 'status') return String(v);
      if (DAYS.includes(f)) return day(v);
      if (f === 'after') return [v].flat().map(String);
      if (f === 'estimate') return typeof v === 'string' ? format.estimates[v] : v;
      if (f === 'notes') return typeof v === 'string' ? [{ text: v }] : v;
      return v;
    };
    const c = canon();
    // Ce qui ne dit rien (faux, liste vide) vaut l'absence : le natif ne l'écrit pas.
    if (c === false || (Array.isArray(c) && c.length === 0)) continue;
    fields[f] = c;
  }
  return { fields, extras: Object.fromEntries(Object.entries(r).filter(([k]) => !consumed.has(k))) };
}

const same = (f: Field, a: unknown, b: unknown): boolean => {
  if (f !== 'notes' || !Array.isArray(a) || !Array.isArray(b)) return isDeepStrictEqual(a, b);
  // Un texte sans date est devenu une note datée du jour de l'import : seul le texte se compare.
  return a.length === b.length && a.every((n: Entry, i) => n.text === (b[i] as Entry).text && (n.date === undefined || n.date === (b[i] as Entry).date));
};

/** Les écarts entre les entrées d'origine et leur aller-retour (natif puis écriture inverse) : une ligne par champ qui diffère. Vide : sans perte. */
export function roundTripDiff(raw: Entry[], back: Entry[], format: PlanFormat): string[] {
  const diffs: string[] = [];
  if (raw.length !== back.length) diffs.push(`${raw.length} entrées à l'origine, ${back.length} au retour`);
  raw.forEach((r, i) => {
    const b = back[i];
    if (!b) return;
    const [a, c] = [view(r, format), view(b, format)];
    const id = String(a.fields.id ?? `n° ${i + 1}`);
    for (const f of FIELDS) if (!same(f, a.fields[f], c.fields[f])) diffs.push(`${id} : ${f} « ${JSON.stringify(a.fields[f])} » devient « ${JSON.stringify(c.fields[f])} »`);
    for (const k of new Set([...Object.keys(a.extras), ...Object.keys(c.extras)])) {
      if (!isDeepStrictEqual(a.extras[k], c.extras[k])) diffs.push(`${id} : la clé « ${k} » n'est pas revenue à l'identique`);
    }
  });
  return diffs;
}

/** Ce qu'un lot veut dire pour raf, hors dates des notes et états détaillés : sert à comparer le plan lu dans l'autre format au plan natif relu. */
function meaning(lot: Lot, parent: string | undefined): Record<string, unknown> {
  const { id, title, status, estimate, unestimated, quickwin, visible, screen, spec, public: pub, every, last, after, created, started, finished, goal, gate, repos } = lot;
  return { id, title, status, estimate, unestimated, quickwin, visible, screen, spec, public: pub, every, last, after, created, started, finished, goal, gate, repos, parent, notes: lot.notes.map((n) => n.text) };
}

/** Les écarts de sens entre le plan lu dans son format et le plan natif relu : raf lit les deux de la même façon. Vide : identiques. */
export function readingDiff(raw: Entry[], native: Entry[], format: PlanFormat): string[] {
  const diffs: string[] = [];
  raw.forEach((r, i) => {
    const e = readForeignEntry(r, i, format);
    const lot = normalizeLot(native[i] ?? {});
    const [a, b] = [meaning(e.lot, e.parent), meaning(lot, lot.parent)];
    for (const k of Object.keys(a)) if (!isDeepStrictEqual(a[k], b[k])) diffs.push(`${e.lot.id} : ${k} se lit « ${JSON.stringify(a[k])} » à l'origine et « ${JSON.stringify(b[k])} » en natif`);
    diffs.push(...lot.problems.map((p) => `${e.lot.id} : ${p} (en natif)`));
  });
  return diffs;
}
