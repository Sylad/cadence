import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSlot, cadenceHome, liveSlots, liveWaves, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { tempDir } from './helpers.js';

const wave = (over = {}) => ({ pid: process.pid, wave: 'w1', started: 'x', cwd: '/p', repos: ['/p/a'], ...over });

describe('registre des vagues vivantes (L71)', () => {
  it('une vague enregistrée est listée, puis retirée', () => {
    const home = tempDir();
    registerWave(home, wave());
    expect(liveWaves(home)).toEqual([wave()]);
    unregisterWave(home, process.pid);
    expect(liveWaves(home)).toEqual([]);
  });

  it("l'entrée d'un pid mort est ignorée (et écartée à l'enregistrement suivant)", () => {
    const home = tempDir();
    mkdirSync(join(home, 'waves'), { recursive: true });
    writeFileSync(join(home, 'waves/999999999.json'), JSON.stringify(wave({ pid: 999999999, wave: 'morte' })));
    expect(liveWaves(home)).toEqual([]);
    registerWave(home, wave());
    expect(existsSync(join(home, 'waves/999999999.json'))).toBe(false);
  });

  it('cadenceHome : CADENCE_HOME, sinon ~/.cadence', () => {
    expect(cadenceHome({ CADENCE_HOME: '/x' })).toBe('/x');
    expect(cadenceHome({ HOME: '/h' })).toMatch(/\.cadence\/orchestrate$/);
  });
});

describe('créneaux de sessions simultanées (L71)', () => {
  it('au plus `cap` créneaux ; un créneau libéré est repris', async () => {
    const home = tempDir();
    const a = await acquireSlot(home, 2, { wave: 'a' });
    const b = await acquireSlot(home, 2, { wave: 'b' });
    expect(liveSlots(home).map((s) => s.wave).sort()).toEqual(['a', 'b']);
    let got = false;
    const waits: string[] = [];
    const c = acquireSlot(home, 2, { wave: 'c', pollMs: 10, onWait: (h) => waits.push(h.map((x) => x.wave).sort().join('+')) }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false);
    expect(waits).toEqual(['a+b']); // prévenu une seule fois
    a();
    const rc = await c;
    expect(liveSlots(home).map((s) => s.wave).sort()).toEqual(['b', 'c']);
    b();
    rc();
    expect(liveSlots(home)).toEqual([]);
  });

  it("un créneau tenu par un pid mort est repris", async () => {
    const home = tempDir();
    mkdirSync(join(home, 'slots'), { recursive: true });
    writeFileSync(join(home, 'slots/slot-0.lock'), JSON.stringify({ pid: 999999999, wave: 'morte', started: 'x' }));
    const r = await acquireSlot(home, 1, { wave: 'a', pollMs: 10 });
    expect(liveSlots(home).map((s) => s.wave)).toEqual(['a']);
    r();
  });
});
