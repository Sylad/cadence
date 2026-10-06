import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from '../state.js';
import { activeLock, releaseLock, takeLock, type OLock } from './lock.js';

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
}

const wavesDir = (home: string) => join(home, 'waves');
const slotsDir = (home: string) => join(home, 'slots');

function readWave(file: string): LiveWave | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { pid: Number(raw.pid), wave: String(raw.wave), started: String(raw.started), cwd: String(raw.cwd), repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [] };
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
    if (w && pidAlive(w.pid)) out.push(w);
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/** Inscrit la vague ; écarte au passage les entrées de processus morts. */
export function registerWave(home: string, w: LiveWave): void {
  mkdirSync(wavesDir(home), { recursive: true });
  for (const n of readdirSync(wavesDir(home))) {
    const old = readWave(join(wavesDir(home), n));
    if (!old || !pidAlive(old.pid)) rmSync(join(wavesDir(home), n), { force: true });
  }
  const file = join(wavesDir(home), `${w.pid}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(w));
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

/**
 * Attend un créneau libre parmi `cap` (premier libre, un pid mort est repris) et rend sa libération. `onWait`
 * est appelé une seule fois, quand on commence à attendre, avec les porteurs.
 */
export async function acquireSlot(home: string, cap: number, opts: { wave: string; pollMs?: number; onWait?: (holders: OLock[]) => void }): Promise<() => void> {
  mkdirSync(slotsDir(home), { recursive: true });
  let warned = false;
  for (;;) {
    for (let k = 0; k < cap; k++) {
      const file = join(slotsDir(home), `slot-${k}.lock`);
      const got = takeLock(file, { pid: process.pid, wave: opts.wave, started: new Date().toISOString() });
      if (got.ok) return () => releaseLock(file, process.pid);
    }
    if (!warned) {
      warned = true;
      opts.onWait?.(liveSlots(home));
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
  }
}
