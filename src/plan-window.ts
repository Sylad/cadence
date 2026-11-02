// La fenêtre prévue d'un lot (L466, M4) : `planned: { from, to }`, lue, héritée du parent, proposée, dite à la reprise.
import type { Document, YAMLMap, YAMLSeq } from 'yaml';
import { diffDays, isCalendarDay, workdayAt, workdaysThrough, type Day } from './dates.js';
import { RafError, type Lot } from './plan.js';
import { isRecurring } from './recurring.js';

export interface PlannedWindow {
  from: Day;
  to: Day;
}

/** Ce que l'héritage lit d'un lot : son id, sa fenêtre propre et son parent. */
type Windowed = Pick<Lot, 'id' | 'planned' | 'parent'>;

const FORM = 'AAAA-MM-JJ..AAAA-MM-JJ, ou un seul jour AAAA-MM-JJ, début avant la fin';
/** Marge (en jours ouvrés) en deçà de laquelle une fin de fenêtre est une échéance à dire à la reprise. */
const DUE_DAYS = 7;

/** `J1..J2` (ou `J` seul : la fenêtre d'un jour) lu en fenêtre ; `RafError` sinon. */
export function parseWindow(text: string): PlannedWindow {
  const parts = text.trim().split('..').map((p) => p.trim());
  const [from, to = from] = parts;
  if (parts.length > 2 || !isCalendarDay(from) || !isCalendarDay(to) || from > to) throw new RafError(`fenêtre invalide : « ${text} » (attendu ${FORM})`);
  return { from, to };
}

/** La clé `planned:` d'un lot lue dans le fichier du plan ; une forme fausse est un problème du lot (remonté par `raf check`) et le lot n'a alors pas de fenêtre. */
export function readPlanned(raw: unknown, problems: string[]): { planned?: PlannedWindow } {
  if (raw == null) return {};
  const w = raw as Record<string, unknown>;
  const ok = typeof raw === 'object' && !Array.isArray(raw) && Object.keys(w).every((k) => k === 'from' || k === 'to') && isCalendarDay(w.from) && isCalendarDay(w.to) && w.from <= w.to;
  if (!ok) {
    problems.push(`planned : { from: AAAA-MM-JJ, to: AAAA-MM-JJ } attendu, début avant la fin (reçu « ${JSON.stringify(raw)} »)`);
    return {};
  }
  return { planned: { from: w.from as Day, to: w.to as Day } };
}

/** La fenêtre d'un lot : la sienne, sinon celle de son plus proche ancêtre qui en a une (`from` : cet ancêtre). */
interface Resolved {
  window: PlannedWindow;
  from?: string;
}

/** Le résolveur d'héritage des lots donnés (un parent inconnu ou des parents en boucle n'héritent de rien). */
export function windowResolver(lots: Windowed[]): (lot: Windowed) => Resolved | undefined {
  const byId = new Map(lots.map((l) => [l.id, l]));
  return (lot) => {
    if (lot.planned) return { window: lot.planned };
    const seen = new Set([lot.id]);
    for (let p = lot.parent ? byId.get(lot.parent) : undefined; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
      seen.add(p.id);
      if (p.planned) return { window: p.planned, from: p.id };
    }
    return undefined;
  };
}

export const windowOf = (lots: Windowed[], lot: Windowed): Resolved | undefined => windowResolver(lots)(lot);

const span = (w: PlannedWindow) => `${w.from}..${w.to}`;
export const formatWindow = (r: Resolved): string => `${span(r.window)}${r.from ? ` (hérité de ${r.from})` : ''}`;

/** Pose la clé de lot `key` en notation de flux, à sa place si elle y est, sinon avant `created:` (à défaut après `after:`, à la fin) — la place de `uses:` et de `planned:`. */
export function putFlowKey(doc: Document, node: YAMLMap, key: string, value: unknown): void {
  const flow = doc.createNode(value) as YAMLMap | YAMLSeq;
  flow.flow = true;
  if (node.has(key)) {
    node.set(key, flow);
    return;
  }
  const keys = node.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
  const created = keys.indexOf('created');
  const after = keys.indexOf('after');
  node.items.splice(created >= 0 ? created : after >= 0 ? after + 1 : keys.length, 0, doc.createPair(key, flow));
}

/** La référence d'un lot : une sous-tâche (`L1/t1`) n'a pas de fenêtre propre, `RafError` sinon. */
export function lotRef(ref: string): string {
  if (ref.includes('/')) throw new RafError(`planned se pose sur un lot, pas sur une sous-tâche : ${ref}`);
  return ref;
}

/** Pose la fenêtre d'un lot en notation de flux (`planned:`), la remplace, ou la retire sans fenêtre. */
export function putPlanned(doc: Document, node: YAMLMap, window: PlannedWindow | null | undefined): void {
  if (window) putFlowKey(doc, node, 'planned', { from: window.from, to: window.to });
  else node.delete('planned');
}

/** `plan.requirePlanned` (`required`) : refuse l'ajout d'un lot sans fenêtre propre ni héritée de son parent `under` ; un lot récurrent (`every`) en est exempt. */
export function refuseUnplanned(required: boolean | undefined, lots: Lot[], id: string, opts: { planned?: PlannedWindow; every?: number; under?: string }): void {
  if (!required || opts.planned || opts.every !== undefined || windowOf(lots, { id, parent: opts.under })) return;
  throw new RafError(`plan.requirePlanned : une fenêtre prévue est exigée (raf add --planned AAAA-MM-JJ..AAAA-MM-JJ${opts.under ? `, ou une fenêtre sur ${opts.under}` : ''})`);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Les fenêtres à poser aux lots à faire sans fenêtre (propre ni héritée), hors récurrents : `perDay` jours d'estimation tiennent dans un jour ouvré, à partir de `from`.
 * Les lots prêts passent d'abord (un lot qui attend un lot encore à placer vient après lui), puis l'ordre du plan ; un lot qui suit un lot déjà daté commence le jour ouvré d'après sa fin.
 */
export function proposeWindows(lots: Lot[], opts: { from: Day; perDay: number }): { id: string; window: PlannedWindow }[] {
  const resolve = windowResolver(lots);
  let pending = lots.filter((l) => l.status === 'todo' && !isRecurring(l) && !resolve(l));
  const waiting = new Set(pending.map((l) => l.id));
  const ends = new Map<string, number>();
  const out: { id: string; window: PlannedWindow }[] = [];
  let cursor = 0;
  while (pending.length > 0) {
    const lot = pending.find((l) => !l.after.some((d) => waiting.has(d))) ?? pending[0]!;
    pending = pending.filter((l) => l !== lot);
    waiting.delete(lot.id);
    let start = cursor;
    for (const d of lot.after) {
      const dated = lots.find((l) => l.id === d);
      const w = dated && !waiting.has(d) ? resolve(dated)?.window : undefined;
      start = Math.max(start, ends.get(d) ?? (w ? workdaysThrough(opts.from, w.to) : 0));
    }
    const stop = round(start + lot.estimate / opts.perDay);
    ends.set(lot.id, stop);
    const first = Math.floor(start);
    out.push({ id: lot.id, window: { from: workdayAt(opts.from, first), to: workdayAt(opts.from, Math.max(first, Math.ceil(stop) - 1)) } });
    cursor = stop;
  }
  return out;
}

/** Une ligne de `windowLines` : son rang (retards, puis lots qui devaient démarrer, puis échéances) et la date qui l'ordonne dans son rang. */
interface WindowEntry {
  rank: number;
  date: Day;
  line: string;
}

function windowEntry(lot: Lot, r: Resolved | undefined, today: Day): WindowEntry | null {
  if (!r || (lot.status !== 'todo' && lot.status !== 'doing') || isRecurring(lot)) return null;
  const { from, to } = r.window;
  const head = `${lot.id}  ${lot.title} —`;
  const via = r.from ? `hérité de ${r.from}` : '';
  const left = diffDays(today, to);
  if (left < 0) return { rank: 0, date: to, line: `${head} en retard de ${-left} j (prévu jusqu'au ${to}${via && `, ${via}`})` };
  if (lot.status === 'todo' && from < today) return { rank: 1, date: from, line: `${head} devait démarrer le ${from}${via && ` (${via})`}` };
  return left <= DUE_DAYS ? { rank: 2, date: to, line: `${head} échéance ${left === 0 ? "aujourd'hui" : `dans ${left} j`} (${to}${via && `, ${via}`})` } : null;
}

/** Ce que `session start` dit des fenêtres : retards d'abord (les plus longs en tête), lots qui devaient démarrer, puis échéances de la semaine. */
export function windowLines(lots: Lot[], today: Day): string[] {
  const resolve = windowResolver(lots);
  return lots
    .flatMap((lot) => windowEntry(lot, resolve(lot), today) ?? [])
    .sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date))
    .map((e) => e.line);
}

/** Avertissements de `raf check` : une fenêtre propre qui sort de celle que son parent porte ou hérite. */
export function windowIssues(lots: Lot[]): { message: string; warning: true }[] {
  const resolve = windowResolver(lots);
  const byId = new Map(lots.map((l) => [l.id, l]));
  return lots.flatMap((lot) => {
    const parent = lot.planned && lot.parent ? byId.get(lot.parent) : undefined;
    const up = parent ? resolve(parent) : undefined;
    if (!lot.planned || !up || (lot.planned.from >= up.window.from && lot.planned.to <= up.window.to)) return [];
    return [{ message: `${lot.id} : fenêtre prévue ${span(lot.planned)} hors de celle de ${up.from ?? parent!.id} (${span(up.window)})`, warning: true as const }];
  });
}
