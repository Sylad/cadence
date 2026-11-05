import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { addHold, registerWave, updateWaveRepos } from '../src/orchestrate/registry.js';
import { slotsLine } from '../src/orchestrate/status.js';
import { tempDir } from './helpers.js';

// Le mod est hors du typecheck de cadence (tsconfig.json) : ses modules sont chargés à l'exécution, par une URL que tsc ne suit pas.
const { COLLECTOR, parseCollected } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as {
  COLLECTOR: string;
  parseCollected: (stdout: string) => { waves: unknown[]; holds: { expires: string }[]; cap: number };
};
const hud = (await import(new URL('../plugins/cadence-hud/hooks/format.ts', import.meta.url).href)) as {
  freeSlots: (waves: unknown[], cap: number, leadSessions: number) => number;
  liveHolds: (holds: { expires: string }[], now: number) => unknown[];
};

// L598 (E1) : un seul calcul des créneaux libres. Le registre (`freeSlots`, lu par `orchestrate --status` et `lead tour`) et la bande
// (`freeSlots` de format.ts, nourrie par le collecteur Python) sont deux implémentations ; ce contrat les joue sur le MÊME registre :
// la prochaine divergence est une porte rouge, pas un constat du lead.

const NOW = new Date('2026-11-05T10:00:00Z');
const children: ChildProcess[] = [];
/** À appeler dans un `afterEach` : tue les processus vivants que les vagues ont empruntés. */
export function reap(): void {
  for (const c of children.splice(0)) c.kill();
}

/** Un processus vivant (le registre juge la vivacité d'un pid) : un par vague, deux vagues ne partagent pas le leur. */
function living(): number {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}

/** Un pid mort : un processus lancé et terminé. */
export function dead(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

interface Spec {
  cap?: number;
  lanes?: number;
  repos: number;
  pid?: number;
  /** Heure de démarrage inscrite au registre, quand elle diffère de celle du processus vivant (pid repris). */
  start?: string;
}

/** Inscrit les vagues et les sessions du lead par le registre lui-même, rend le `free` des deux lecteurs sur le plafond `total`. */
export function both(total: number, waves: Spec[], holds: { label: string; ttlMinutes: number }[] = []): { registre: number; bande: number } {
  const root = tempDir();
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  mkdirSync(cwd, { recursive: true });
  waves.forEach((w, i) => {
    const pid = w.pid ?? living();
    const repos = Array.from({ length: w.repos }, (_, k) => join(cwd, `r${i}-${k}`));
    registerWave(home, { pid, wave: `vague-${i}`, started: `2026-11-05T09:0${i}:00.000Z`, cwd, repos, cap: w.cap, start: w.start });
    updateWaveRepos(home, pid, repos, w.lanes);
  });
  for (const h of holds) addHold(home, h.label, h.ttlMinutes, NOW);
  process.env.CADENCE_HOME = home;
  try {
    const registre = slotsLine(total, NOW).free;
    const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home, CADENCE_MAX_SESSIONS: String(total) } });
    expect(run.status).toBe(0);
    const c = parseCollected(run.stdout);
    const bande = hud.freeSlots(c.waves, total, hud.liveHolds(c.holds, NOW.getTime()).length);
    return { registre, bande };
  } finally {
    delete process.env.CADENCE_HOME;
  }
}

