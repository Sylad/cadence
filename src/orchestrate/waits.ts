import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDay, toDay, type Day } from '../dates.js';
import { RunStore } from './state.js';

/** « 4 min 27 s », « 45 s », « 1 h 02 min 03 s » (la forme de `duration` et des lignes du journal) en millisecondes ; null si illisible. */
export function parseWaitMs(text: string): number | null {
  const m = /^(?:(\d+) h )?(?:(\d+) min )?(\d+) s$/.exec(text.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 1000;
}

export interface Wait {
  day: Day;
  ms: number;
}

/** Les attentes d'un créneau d'un journal : comptées à l'obtention (« obtenu après … »), au jour de cette ligne ; `unfinished` = attentes commencées sans créneau obtenu. */
export function parseWaits(journal: string): { waits: Wait[]; unfinished: number } {
  const waits: Wait[] = [];
  let unfinished = 0;
  let open = false;
  let since = 0; // « depuis » de la dernière ligne d'attente : une ligne dont il recule est celle d'une nouvelle attente
  for (const line of journal.split('\n')) {
    const m = /^(\S+) (?:en attente d'un créneau de session depuis (.+?) \(|créneau de session obtenu après (.+?) d'attente)/.exec(line);
    if (!m) continue;
    if (m[3] === undefined) {
      const ms = parseWaitMs(m[2]) ?? 0;
      if (open && ms < since) unfinished++;
      open = true;
      since = ms;
      continue;
    }
    const ms = parseWaitMs(m[3]);
    const at = new Date(m[1]);
    if (ms !== null && !Number.isNaN(at.getTime())) waits.push({ day: toDay(at), ms });
    open = false;
  }
  if (open) unfinished++;
  return { waits, unfinished };
}

/** Les arrêts par le quota d'un journal (« … → suspended — quota atteint », cycle.ts), au jour de la ligne : le statut final de wave.json ne les garde pas, `--resume` le remet à `running` puis `done`. */
export function parseQuotaStops(journal: string): Day[] {
  const days: Day[] = [];
  for (const line of journal.split('\n')) {
    const m = /^(\S+) \S+ → suspended — quota atteint$/.exec(line);
    const at = m ? new Date(m[1]) : null;
    if (at && !Number.isNaN(at.getTime())) days.push(toDay(at));
  }
  return days;
}

export interface WaveWaits {
  id: string;
  totalMs: number;
  count: number;
  maxMs: number;
  unfinished: number;
  status: string;
  consumed: number;
}

export interface DayWaits {
  day: Day;
  totalMs: number;
  count: number;
  waves: number;
  quotaHits: number;
  consumed: number;
}

export interface WaitsReport {
  waves: WaveWaits[];
  days: DayWaits[];
}

/** Attente de créneau par vague et par jour, lue dans les `journal.log` et `wave.json` de `.cadence/runs/<vague>/` du dossier de lancement ; `since` écarte les vagues d'avant ce jour (début de l'identifiant). */
export function readWaits(launchDir: string, since?: Day): WaitsReport {
  const base = RunStore.runsDir(launchDir);
  const ids = existsSync(base) ? readdirSync(base).filter((n) => existsSync(join(base, n, 'wave.json'))).sort() : [];
  const waves: WaveWaits[] = [];
  const days = new Map<Day, DayWaits>();
  const dayOf = (day: Day): DayWaits => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, totalMs: 0, count: 0, waves: 0, quotaHits: 0, consumed: 0 }));
    return d;
  };
  for (const id of ids) {
    const idDay = id.slice(0, 10);
    if (!isDay(idDay) || (since && idDay < since)) continue; // un dossier qui n'est pas une vague datée (essai à la main) n'a pas de jour
    let meta: { status?: string; consumed?: number } = {};
    try {
      meta = JSON.parse(readFileSync(join(base, id, 'wave.json'), 'utf8'));
    } catch {
      // wave.json illisible : la vague compte sans jetons
    }
    const journalFile = join(base, id, 'journal.log');
    const journal = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '';
    const { waits, unfinished } = parseWaits(journal);
    waves.push({ id, totalMs: waits.reduce((s, w) => s + w.ms, 0), count: waits.length, maxMs: Math.max(0, ...waits.map((w) => w.ms)), unfinished, status: meta.status ?? '?', consumed: meta.consumed ?? 0 });
    const d = dayOf(idDay);
    d.waves++;
    d.consumed += meta.consumed ?? 0;
    for (const day of parseQuotaStops(journal)) dayOf(day).quotaHits++;
    for (const w of waits) {
      const dw = dayOf(w.day);
      dw.totalMs += w.ms;
      dw.count++;
    }
  }
  return { waves, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  return min < 60 ? `${min} min ${String(s % 60).padStart(2, '0')} s` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Deux tableaux : par jour, puis par vague (celles qui ont attendu). */
export function renderWaits(r: WaitsReport): string[] {
  if (r.waves.length === 0) return ['aucune vague dans ce dossier'];
  const lines = ['attente de créneau de session, par jour', '  jour         attente cumulée   attentes  vagues  quota atteint  jetons'];
  for (const d of r.days) lines.push(`  ${d.day}   ${duration(d.totalMs).padEnd(16)}  ${String(d.count).padStart(8)}  ${String(d.waves).padStart(6)}  ${String(d.quotaHits).padStart(13)}  ${d.consumed}`);
  const total = r.days.reduce((s, d) => s + d.totalMs, 0);
  lines.push(`  total        ${duration(total)}`, '', 'par vague (celles qui ont attendu)');
  const waited = r.waves.filter((w) => w.count > 0 || w.unfinished > 0).sort((a, b) => b.totalMs - a.totalMs);
  if (waited.length === 0) lines.push('  aucune');
  for (const w of waited) lines.push(`  ${w.id}   ${duration(w.totalMs).padEnd(16)}  ${w.count} attente(s), la plus longue ${duration(w.maxMs)}${w.unfinished ? `, ${w.unfinished} sans créneau obtenu` : ''}  [${w.status}]`);
  return lines;
}
