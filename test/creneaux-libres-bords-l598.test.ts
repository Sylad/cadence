import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addHold, registerWave, updateWaveRepos } from '../src/orchestrate/registry.js';
import { slotsLine } from '../src/orchestrate/status.js';
import { tempDir } from './helpers.js';

const { COLLECTOR, parseCollected } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as {
  COLLECTOR: string;
  parseCollected: (stdout: string) => { waves: unknown[]; holds: { expires: string }[]; cap: number };
};
const hud = (await import(new URL('../plugins/cadence-hud/hooks/format.ts', import.meta.url).href)) as {
  freeSlots: (waves: unknown[], cap: number, leadSessions: number) => number;
  liveHolds: (holds: { expires: string }[], now: number) => unknown[];
};

const NOW = new Date('2026-11-05T10:00:00Z');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});
function living(): number {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}
function dead(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}
interface Spec { cap?: number; lanes?: number; repos: number; pid?: number }

function both(total: number, waves: Spec[], holds: { label: string; ttlMinutes: number }[] = []): { registre: number; bande: number } {
  const root = tempDir();
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  mkdirSync(cwd, { recursive: true });
  waves.forEach((w, i) => {
    const pid = w.pid ?? living();
    const repos = Array.from({ length: w.repos }, (_, k) => join(cwd, `r${i}-${k}`));
    registerWave(home, { pid, wave: `vague-${i}`, started: `2026-11-05T09:0${i}:00.000Z`, cwd, repos, cap: w.cap });
    updateWaveRepos(home, pid, repos, w.lanes);
  });
  for (const h of holds) addHold(home, h.label, h.ttlMinutes, NOW);
  process.env.CADENCE_HOME = home;
  try {
    const registre = slotsLine(total, NOW).free;
    const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home, CADENCE_MAX_SESSIONS: String(total) } });
    expect(run.status).toBe(0);
    const c = parseCollected(run.stdout);
    return { registre, bande: hud.freeSlots(c.waves, total, hud.liveHolds(c.holds, NOW.getTime()).length) };
  } finally {
    delete process.env.CADENCE_HOME;
  }
}

describe('L598 — bords de la formule unique des créneaux libres', () => {
  it('lanes à 0 : la vague ne tient rien, malgré ses dépôts', () => {
    expect(both(3, [{ cap: 3, lanes: 0, repos: 2 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('vague sans dépôt ni lanes : ne tient rien', () => {
    expect(both(3, [{ cap: 3, repos: 0 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('plafond de vague supérieur à la machine : borné par le plafond de la machine', () => {
    expect(both(2, [{ cap: 9, lanes: 5, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
  it('plafond 0 (invalide) : ignoré comme inconnu', () => {
    expect(both(3, [{ cap: 0, lanes: 5, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
  it('une vague vivante à côté d\'une morte : seule la vivante compte', () => {
    expect(both(4, [{ cap: 4, lanes: 2, repos: 1 }, { cap: 4, lanes: 3, repos: 1, pid: dead() }])).toEqual({ registre: 2, bande: 2 });
  });
  it('deux vagues dont une sans plafond : la sans plafond compte pour le total', () => {
    expect(both(4, [{ cap: 2, lanes: 1, repos: 1 }, { lanes: 1, repos: 1 }])).toEqual({ registre: 2, bande: 2 });
  });
  it('la même session du lead posée deux fois ne compte qu\'une fois', () => {
    const r = both(3, [], [{ label: 'qa', ttlMinutes: 30 }, { label: 'qa', ttlMinutes: 30 }]);
    expect(r).toEqual({ registre: 2, bande: 2 });
  });
  it('TTL négatif : échue, ne compte pas', () => {
    expect(both(3, [], [{ label: 'qa', ttlMinutes: -5 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('plafond machine 1, deux vagues : 0', () => {
    expect(both(1, [{ cap: 1, lanes: 1, repos: 1 }, { cap: 1, lanes: 1, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
});
