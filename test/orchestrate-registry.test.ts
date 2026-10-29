import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SlotAbandoned, acquireSlot, addHold, cadenceHome, freeSlots, liveSlots, liveWaves, registerWave, releaseHold, unregisterWave } from '../src/orchestrate/registry.js';
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

describe('attente interrompue (L332)', () => {
  it("R1 — acquireSlot lève SlotAbandoned dès que abandon() donne une raison, sans prendre de créneau", async () => {
    const home = tempDir();
    const x = await acquireSlot(home, 1, { wave: 'x' });
    let ask = false;
    const waiting = acquireSlot(home, 1, { wave: 'y', pollMs: 10, abandon: () => (ask ? 'raison' : null) });
    const outcome = waiting.then(() => 'créneau pris', (e: unknown) => (e instanceof SlotAbandoned ? e.reason : 'autre erreur'));
    await new Promise((r) => setTimeout(r, 50));
    ask = true;
    expect(await outcome).toBe('raison');
    expect(liveSlots(home).map((s) => s.wave)).toEqual(['x']);
    x();
  });
});

describe("attente interrompue : seulement une VRAIE attente (L332, correctif)", () => {
  it("R2 — créneau libre et demande déjà posée : le créneau est pris, abandon() n'est pas même consultée", async () => {
    const home = tempDir();
    let asked = 0;
    const free = await acquireSlot(home, 1, { wave: 'y', abandon: () => (asked++, 'raison') });
    expect(asked).toBe(0);
    expect(liveSlots(home).map((s) => s.wave)).toEqual(['y']);
    free();
  });

  it("R2 — pas de créneau libre et demande déjà posée : l'attente commence, la demande l'interrompt aussitôt (sans attendre un tour), aucun créneau pris", async () => {
    const home = tempDir();
    const x = await acquireSlot(home, 1, { wave: 'x' });
    const waits: number[] = [];
    const e = await acquireSlot(home, 1, { wave: 'y', pollMs: 10_000, abandon: () => 'raison', onWait: (_h, ms) => waits.push(ms) }).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(SlotAbandoned);
    expect((e as SlotAbandoned).reason).toBe('raison');
    expect(liveSlots(home).map((s) => s.wave)).toEqual(['x']);
    x();
  });

  it("R2 — pendant une vraie attente, la demande est relue avant chaque tentative : un créneau libéré en même temps que la demande arrive n'est pas pris", async () => {
    const home = tempDir();
    const x = await acquireSlot(home, 1, { wave: 'x' });
    let ask = false;
    const waiting = acquireSlot(home, 1, { wave: 'y', pollMs: 20, abandon: () => (ask ? 'raison' : null) });
    const outcome = waiting.then(() => 'créneau pris', (err: unknown) => (err instanceof SlotAbandoned ? err.reason : 'autre erreur'));
    await new Promise((r) => setTimeout(r, 50));
    ask = true;
    x(); // le créneau se libère en même temps que la demande arrive
    expect(await outcome).toBe('raison');
    expect(liveSlots(home)).toEqual([]);
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

  it('un plafond commun : une vague à 4 à côté d\'une vague vivante à 3 attend à 3 sessions (jamais « 4/3 »)', async () => {
    const home = tempDir();
    registerWave(home, wave({ cap: 3 })); // la vague voisine, vivante, au plafond 3
    held(home, 0);
    held(home, 1);
    held(home, 2);
    let got = false;
    const waits: string[] = [];
    const p = acquireSlot(home, 4, { wave: 'haut', pollMs: 10, onWait: (h, _ms, limit) => waits.push(`${h.length}/${limit}`) }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false); // 3 sessions tournent : le plafond de 4 de cette vague cède au plafond commun de 3
    expect(waits[0]).toBe('3/3'); // le message dit le plafond appliqué, pas « 3/4 »
    rmSync(join(home, 'slots/slot-2.lock'));
    const r = await p;
    expect(liveSlots(home)).toHaveLength(3);
    r();
  });

  it("le plafond commun est le plus bas des vagues vivantes ; une vague sans plafond connu ou morte n'y compte pas", async () => {
    const home = tempDir();
    mkdirSync(join(home, 'waves'), { recursive: true });
    writeFileSync(join(home, 'waves/999999999.json'), JSON.stringify(wave({ pid: 999999999, wave: 'morte', cap: 1 })));
    registerWave(home, wave({ cap: undefined }));
    held(home, 0);
    held(home, 1);
    const r = await acquireSlot(home, 3, { wave: 'haut', pollMs: 10 });
    expect(liveSlots(home)).toHaveLength(3);
    r();
  });
});

describe('identité du porteur : pid + heure de démarrage (L71/t3)', () => {
  it('course : le total dépasse le plafond une fois le créneau pris → le créneau est rendu, on retente ; au plafond exact on passe', async () => {
    const home = tempDir();
    const lock = (n: number) => Array.from({ length: n }, () => ({ pid: process.pid, wave: 'x', started: 'x' }));
    // comptée 1 (< 2) → prise → recomptée 3 (> 2, une autre vague a pris) → rendu, onWait (compte 0) → comptée 1 → prise → recomptée 2 (= plafond) → obtenu
    const seen = [1, 3, 0, 1, 2];
    let calls = 0;
    const slots = () => lock(seen[calls++]!) as ReturnType<typeof liveSlots>;
    const rendu: boolean[] = [];
    const release = await acquireSlot(home, 2, { wave: 'a', pollMs: 5, slots, onWait: () => rendu.push(!existsSync(join(home, 'slots/slot-0.lock'))) });
    expect(calls).toBe(5);
    expect(rendu).toEqual([true]); // à l'attente, le créneau pris en trop a été rendu
    expect(existsSync(join(home, 'slots/slot-0.lock'))).toBe(true);
    release();
  });

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

  /** Attend (au plus 10 s) qu'une condition devienne vraie : seule la durée de l'attente dépend de la charge, pas le résultat. */
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it("le journal d'attente dit depuis combien de temps on attend, puis l'obtention", async () => {
    const home = tempDir();
    const a = await acquireSlot(home, 1, { wave: 'a' });
    const waits: number[] = [];
    const got: number[] = [];
    let t = 1_000_000; // horloge pilotée : aucune dépendance au temps réel ni à la charge de la machine
    const p = acquireSlot(home, 1, { wave: 'b', pollMs: 10, reportMs: 30, now: () => t, onWait: (_h, ms) => waits.push(ms), onGot: (ms) => got.push(ms) });
    await until(() => waits.length >= 1);
    await new Promise((r) => setTimeout(r, 40)); // quelques passes de plus : l'horloge n'a pas bougé, aucun nouveau compte-rendu
    expect(waits).toEqual([0]); // dès le début de l'attente, 0 ms, pas de nouveau compte-rendu tant que reportMs n'est pas écoulé
    t += 50;
    await until(() => waits.length >= 2);
    expect(waits).toEqual([0, 50]);
    t += 50;
    a();
    (await p)();
    expect(got).toEqual([100]);
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

describe('créneaux libres (L141)', () => {
  const w = (cap: number | undefined, repos: string[]) => wave({ cap, repos });
  it('sans vague : tout le plafond est libre', () => {
    expect(freeSlots([], 2)).toBe(2);
  });
  it('une vague retire min(plafond, dépôts qu\'elle tient)', () => {
    expect(freeSlots([w(2, ['/a'])], 2)).toBe(1);
    expect(freeSlots([w(2, ['/a', '/b', '/c'])], 2)).toBe(0);
    expect(freeSlots([w(1, ['/a', '/b'])], 2)).toBe(1);
  });
  it('deux vagues s\'additionnent, jamais sous zéro ; plafond inconnu : le total', () => {
    expect(freeSlots([w(2, ['/a']), w(2, ['/b'])], 2)).toBe(0);
    expect(freeSlots([w(2, ['/a', '/b']), w(2, ['/c', '/d'])], 2)).toBe(0);
    expect(freeSlots([w(undefined, ['/a', '/b'])], 2)).toBe(0);
  });
  it('plafond commun (L395) : une vague à 4 à côté d\'une vague à 3 ne retient pas plus que 3', () => {
    expect(freeSlots([w(4, ['/a', '/b', '/c', '/d']), w(3, ['/e'])], 6)).toBe(2);
  });
});

describe('plafond de sessions et sessions du lead (L424)', () => {
  it('R1 — une session du lead inscrite (lead hold) prend un créneau : la vague attend au lieu de partir', async () => {
    const home = tempDir();
    addHold(home, 'correctif-L12', 60, new Date());
    const waits: string[] = [];
    let got = false;
    const p = acquireSlot(home, 1, { wave: 'a', pollMs: 10, onWait: (h, _ms, limit, held) => waits.push(`${h.length}+${held.map((x) => x.label)}/${limit}`) }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false);
    expect(waits[0]).toBe('0+correctif-L12/1');
    releaseHold(home, 'correctif-L12');
    (await p)();
  });

  it('R2 — avec un plafond de 3, un hold et une session de vague laissent exactement un créneau', async () => {
    const home = tempDir();
    addHold(home, 'revue', 60, new Date());
    const a = await acquireSlot(home, 3, { wave: 'a' });
    const b = await acquireSlot(home, 3, { wave: 'a' });
    let got = false;
    const p = acquireSlot(home, 3, { wave: 'a', pollMs: 10 }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false); // 2 sessions + 1 hold = 3/3
    a();
    (await p)();
    b();
  });

  it("R3 — un hold dont le TTL est échu ne retient plus de créneau", async () => {
    const home = tempDir();
    addHold(home, 'vieille', 10, new Date(Date.now() - 3600_000));
    (await acquireSlot(home, 1, { wave: 'a', pollMs: 10 }))();
  });
});
