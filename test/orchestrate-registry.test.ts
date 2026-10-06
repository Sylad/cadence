import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSlot, cadenceHome, liveSlots, liveWaves, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { tempDir } from './helpers.js';

const wave = (over = {}) => ({ pid: process.pid, wave: 'w1', started: 'x', cwd: '/p', repos: ['/p/a'], ...over });

describe('registre des vagues vivantes (L71)', () => {
  it('une vague enregistrée est listée, puis retirée', () => {
    const home = tempDir();
    registerWave(home, wave());
    expect(liveWaves(home)).toEqual([wave({ start: expect.any(String) })]);
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

describe('plafond réellement global (L71/t2)', () => {
  const held = (home: string, k: number, pid = process.ppid, extra = {}) => {
    mkdirSync(join(home, 'slots'), { recursive: true });
    writeFileSync(join(home, `slots/slot-${k}.lock`), JSON.stringify({ pid, wave: `w${k}`, started: 'x', ...extra }));
  };

  it('tous les créneaux vivants comptent, quel que soit leur index : deux sessions aux index 0 et 5 remplissent un plafond de 2', async () => {
    const home = tempDir();
    held(home, 0);
    held(home, 5);
    let got = false;
    const p = acquireSlot(home, 2, { wave: 'c', pollMs: 10 }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false); // le créneau 1 est libre, mais 2 sessions tournent déjà
    rmSync(join(home, 'slots/slot-5.lock'));
    const r = await p;
    expect(liveSlots(home).map((s) => s.wave).sort()).toEqual(['c', 'w0']);
    r();
  });

  it("un plafond plus haut passe là où un plafond plus bas attend : chaque vague applique le sien", async () => {
    const home = tempDir();
    held(home, 0);
    held(home, 1);
    const r = await acquireSlot(home, 3, { wave: 'haut', pollMs: 10 });
    expect(liveSlots(home)).toHaveLength(3);
    r();
  });
});

describe('identité du porteur : pid + heure de démarrage (L71/t3)', () => {
  it('un créneau dont le pid existe mais a une autre heure de démarrage (pid réutilisé) est repris', async () => {
    const home = tempDir();
    mkdirSync(join(home, 'slots'), { recursive: true });
    writeFileSync(join(home, 'slots/slot-0.lock'), JSON.stringify({ pid: process.pid, wave: 'ancienne', started: 'x', start: 'pas-la-meme-heure' }));
    expect(liveSlots(home)).toEqual([]);
    const r = await acquireSlot(home, 1, { wave: 'a', pollMs: 10 });
    expect(liveSlots(home).map((s) => s.wave)).toEqual(['a']);
    r();
  });

  it("une vague du registre dont le pid est réutilisé n'est plus vivante", () => {
    const home = tempDir();
    registerWave(home, wave({ start: 'pas-la-meme-heure' }));
    expect(liveWaves(home)).toEqual([]);
  });

  it("l'heure de démarrage est inscrite aux créneaux et au registre", async () => {
    const home = tempDir();
    const r = await acquireSlot(home, 1, { wave: 'a' });
    expect(liveSlots(home)[0]!.start).toEqual(expect.any(String));
    r();
    registerWave(home, wave());
    expect(liveWaves(home)[0]!.start).toEqual(expect.any(String));
  });

  it("le journal d'attente dit depuis combien de temps on attend, puis l'obtention", async () => {
    const home = tempDir();
    const a = await acquireSlot(home, 1, { wave: 'a' });
    const waits: number[] = [];
    const got: number[] = [];
    const p = acquireSlot(home, 1, { wave: 'b', pollMs: 10, reportMs: 30, onWait: (_h, ms) => waits.push(ms), onGot: (ms) => got.push(ms) });
    await new Promise((r) => setTimeout(r, 120));
    a();
    (await p)();
    expect(waits[0]).toBe(0);
    expect(waits.length).toBeGreaterThan(1);
    expect(waits[1]).toBeGreaterThanOrEqual(30);
    expect(got).toHaveLength(1);
    expect(got[0]).toBeGreaterThanOrEqual(100);
  });
});

describe('registerWave (L71/t4)', () => {
  it("les .tmp d'une inscription en cours ne sont pas touchés au nettoyage", () => {
    const home = tempDir();
    mkdirSync(join(home, 'waves'), { recursive: true });
    writeFileSync(join(home, 'waves/4242.json.tmp'), '{"pid":4242');
    registerWave(home, wave());
    expect(existsSync(join(home, 'waves/4242.json.tmp'))).toBe(true);
  });
});
