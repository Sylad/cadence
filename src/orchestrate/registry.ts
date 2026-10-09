import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { processStart } from '../proc.js';
import { lotKey, lotRepoPaths, RunStore, type LotState } from './state.js';
import { activeLock, holderAlive, releaseLock, takeLock, type OLock } from './lock.js';

/**
 * État commun à toutes les vagues de l'utilisateur, quel que soit le dossier d'où elles partent : le registre
 * des vagues vivantes (`waves/<pid>.json`) et les créneaux de sessions simultanées (`slots/slot-<n>.lock`).
 * Les verrous de DÉPÔT restent dans le dépôt (`.git/cadence/orchestrate.lock`).
 */
export function cadenceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CADENCE_HOME || join(env.HOME || homedir(), '.cadence', 'orchestrate');
}

export interface LiveWave {
  pid: number;
  wave: string;
  started: string;
  cwd: string;
  repos: string[];
  /** Plafond de sessions simultanées que cette vague s'applique (`--max-sessions`). */
  cap?: number;
  /** Heure de démarrage du processus : avec le pid, l'identité de la vague (un pid se réutilise). */
  start?: string;
}

const wavesDir = (home: string) => join(home, 'waves');
const slotsDir = (home: string) => join(home, 'slots');

function readWave(file: string): LiveWave | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const w: LiveWave = { pid: Number(raw.pid), wave: String(raw.wave), started: String(raw.started), cwd: String(raw.cwd), repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [] };
    if (raw.cap !== undefined) w.cap = Number(raw.cap);
    if (raw.start !== undefined) w.start = String(raw.start);
    return w;
  } catch {
    return null;
  }
}

/** Les vagues dont le processus vit encore. */
export function liveWaves(home: string): LiveWave[] {
  let names: string[];
  try {
    names = readdirSync(wavesDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LiveWave[] = [];
  for (const n of names) {
    const w = readWave(join(wavesDir(home), n));
    if (w && holderAlive(w.pid, w.start)) out.push(w);
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/**
 * Les créneaux que le lead peut encore donner à des sous-agents : `total` moins, pour chaque vague vivante, le
 * plus petit de son plafond et du nombre de dépôts qu'elle tient encore (ses pas prennent un créneau et le
 * rendent entre deux étapes : les sessions vivantes à l'instant ne disent pas ce que la vague va reprendre).
 * Une vague sans plafond connu compte pour `total`.
 */
export function freeSlots(waves: LiveWave[], total: number): number {
  const held = waves.reduce((n, w) => n + Math.min(w.cap ?? total, w.repos.length), 0);
  return Math.max(0, total - held);
}

/** Inscrit la vague ; écarte au passage les entrées de processus morts (les `.tmp` d'une inscription en cours ne sont pas touchés). */
export function registerWave(home: string, given: LiveWave): void {
  const w: LiveWave = { ...given, start: given.start ?? processStart(given.pid) ?? undefined };
  mkdirSync(wavesDir(home), { recursive: true });
  for (const n of readdirSync(wavesDir(home))) {
    if (!n.endsWith('.json')) continue;
    const old = readWave(join(wavesDir(home), n));
    if (!old || !holderAlive(old.pid, old.start)) rmSync(join(wavesDir(home), n), { force: true });
  }
  const file = join(wavesDir(home), `${w.pid}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(w));
  renameSync(`${file}.tmp`, file);
}

/** Met à jour la liste des dépôts tenus par la vague (un dépôt libéré en cours de vague n'y figure plus). */
export function updateWaveRepos(home: string, pid: number, repos: string[]): void {
  const file = join(wavesDir(home), `${pid}.json`);
  const w = readWave(file);
  if (!w) return;
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...w, repos }));
  renameSync(`${file}.tmp`, file);
}

export function unregisterWave(home: string, pid: number): void {
  rmSync(join(wavesDir(home), `${pid}.json`), { force: true });
}

/** Les sessions en cours en ce moment, toutes vagues confondues. */
export function liveSlots(home: string): OLock[] {
  let names: string[];
  try {
    names = readdirSync(slotsDir(home)).filter((n) => /^slot-\d+\.lock$/.test(n));
  } catch {
    return [];
  }
  return names.map((n) => activeLock(join(slotsDir(home), n))).filter((l): l is OLock => l !== null);
}

/** Index de créneau le plus haut essayé : le plafond de chaque vague est le sien, les fichiers sont communs. */
const MAX_SLOT_INDEX = 64;

/** Intervalle des rappels d'attente dans le journal. */
const WAIT_REPORT_MS = 60_000;

/**
 * Attend que le nombre de sessions vivantes, TOUTES vagues confondues et quel que soit l'index de leur créneau,
 * soit sous `cap` (le plafond de cette vague), puis prend le premier créneau libre (un pid mort est repris) et
 * rend sa libération. Chaque vague applique SON plafond au total commun : avec des plafonds différents, la
 * vague au plafond le plus haut peut porter le total au-dessus du plafond de l'autre, qui attend alors.
 * Deux vagues qui prennent en même temps se départagent au recomptage : si le total dépasse `cap` une fois
 * le créneau pris, il est rendu et l'attente reprend.
 *
 * `onWait(holders, waitedMs)` : appelé quand on commence à attendre (0 ms), puis toutes les minutes.
 * `onGot(waitedMs)` : appelé à l'obtention, seulement si on a attendu.
 */
export async function acquireSlot(
  home: string,
  cap: number,
  opts: { wave: string; slots?: (home: string) => OLock[]; pollMs?: number; reportMs?: number; onWait?: (holders: OLock[], waitedMs: number) => void; onGot?: (waitedMs: number) => void; now?: () => number },
): Promise<() => void> {
  mkdirSync(slotsDir(home), { recursive: true });
  const now = opts.now ?? Date.now; // injectable : les tests pilotent l'horloge
  const t0 = now();
  let reportedAt: number | null = null;
  const pollMs = opts.pollMs ?? 2000;
  const live = opts.slots ?? liveSlots; // injectable : les tests simulent une vague qui prend un créneau entre les deux comptées
  for (;;) {
    if (live(home).length < cap) {
      for (let k = 0; k < MAX_SLOT_INDEX; k++) {
        const file = join(slotsDir(home), `slot-${k}.lock`);
        const got = takeLock(file, { pid: process.pid, wave: opts.wave, started: new Date().toISOString() });
        if (!got.ok) continue;
        if (live(home).length <= cap) {
          if (reportedAt !== null) opts.onGot?.(now() - t0);
          return () => releaseLock(file, process.pid);
        }
        releaseLock(file, process.pid); // pris à plusieurs en même temps : on rend, on retente
        break;
      }
    }
    if (reportedAt === null || now() - reportedAt >= (opts.reportMs ?? WAIT_REPORT_MS)) {
      reportedAt = now();
      opts.onWait?.(live(home), reportedAt - t0);
    }
    await new Promise((r) => setTimeout(r, pollMs + Math.random() * pollMs * 0.25));
  }
}

/** Lots de la vague `pid` qui travaillent encore dans `repo` (en cours, en file ou suspendus) ; null si l'état de la vague est illisible. */
export function openLotsIn(home: string, pid: number, repo: string): string[] | null {
  try {
    const w = liveWaves(home).find((x) => x.pid === pid);
    const store = w && RunStore.find(w.cwd, w.wave);
    if (!store) return null;
    const finished = (l: LotState) => l.status === 'ready' || l.status === 'handed-back' || l.status === 'failed';
    return store.lots().filter((l) => !finished(l) && lotRepoPaths(l).includes(repo)).map((l) => lotKey(l.project, l.lot));
  } catch {
    return null;
  }
}
