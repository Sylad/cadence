import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSlot } from '../src/orchestrate/registry.js';
import { slotPlace } from '../src/orchestrate/attente.js';
import type { LotState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

const POLL = 5;

/** Lance une attente de créneau et note l'ordre d'obtention ; rend la promesse de la libération. */
function waiter(home: string, order: string[], name: string, opts: { fresh?: boolean; rank?: number }) {
  return acquireSlot(home, 1, { wave: name, pollMs: POLL, ...opts }).then((free) => {
    order.push(name);
    free();
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend que `n` attentes soient inscrites (les trois lancées, avant de libérer le créneau). */
async function registered(home: string, n: number) {
  for (let i = 0; i < 400; i++) {
    try {
      if (readdirSync(join(home, 'waiters')).length >= n) return;
    } catch {
      // pas encore de dossier
    }
    await pause(5);
  }
  throw new Error('attentes non inscrites');
}

describe('L531 — équité entre vagues pour le créneau qui se libère', () => {
  it("R1 — l'étape suivante d'un lot en cours passe avant un nouveau tirage, même arrivé avant", async () => {
    const home = tempDir();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    const order: string[] = [];
    const a = waiter(home, order, 'tirage', { fresh: true, rank: 0 });
    await registered(home, 1);
    const b = waiter(home, order, 'etape', { fresh: false, rank: 5 });
    await registered(home, 2);
    held();
    await Promise.all([a, b]);
    expect(order).toEqual(['etape', 'tirage']);
  });

  it('R2 — entre deux nouveaux tirages, le projet le plus haut dans priority: passe en premier', async () => {
    const home = tempDir();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    const order: string[] = [];
    const a = waiter(home, order, 'bas', { fresh: true, rank: 3 });
    await registered(home, 1);
    const b = waiter(home, order, 'haut', { fresh: true, rank: 0 });
    await registered(home, 2);
    held();
    await Promise.all([a, b]);
    expect(order).toEqual(['haut', 'bas']);
  });

  it('R3 — à rang égal, la plus ancienne attente passe en premier', async () => {
    const home = tempDir();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    const order: string[] = [];
    const a = waiter(home, order, 'premier', { fresh: false, rank: 1 });
    await registered(home, 1);
    const b = waiter(home, order, 'second', { fresh: false, rank: 1 });
    await registered(home, 2);
    held();
    await Promise.all([a, b]);
    expect(order).toEqual(['premier', 'second']);
  });

  it('R4 — une attente dont le processus est mort ne retient personne', async () => {
    const home = tempDir();
    mkdirSync(join(home, 'waiters'), { recursive: true });
    writeFileSync(
      join(home, 'waiters', '999999-1.json'),
      JSON.stringify({
        pid: 999999,
        wave: 'morte',
        since: 1,
        seq: 0,
        fresh: false,
        rank: 0,
      }),
    );
    const order: string[] = [];
    await waiter(home, order, 'vivant', { fresh: true, rank: 9 });
    expect(order).toEqual(['vivant']);
  });

  it("R5 — l'inscription est retirée une fois le créneau obtenu, et quand l'attente est abandonnée", async () => {
    const home = tempDir();
    const free = await acquireSlot(home, 1, { wave: 'x', fresh: true });
    expect(readdirSync(join(home, 'waiters'))).toEqual([]);
    free();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    await expect(acquireSlot(home, 1, { wave: 'y', pollMs: POLL, abandon: () => 'stop' })).rejects.toThrow('stop');
    expect(readdirSync(join(home, 'waiters'))).toEqual([]);
    held();
  });

  it('R6 — sans autre attente, un créneau libre est pris sans délai (comportement inchangé)', async () => {
    const home = tempDir();
    const t0 = Date.now();
    const free = await acquireSlot(home, 2, {
      wave: 'seul',
      fresh: true,
      rank: 4,
    });
    expect(Date.now() - t0).toBeLessThan(500);
    free();
  });

  it("R7 — la place d'une session : premier pas (un seul pas inscrit) ou suite, rang du projet dans priority: ; lot inconnu ou priorité illisible : place neutre", () => {
    const lot = (project: string, steps: number) => ({ project, lot: 'L1', steps: Array.from({ length: steps }, () => ({})) }) as unknown as LotState;
    const all = [lot('maritime-atlas', 1), lot('finance', 3)];
    const parent = tempDir();
    expect(slotPlace(all, parent, ['finance', 'maritime'], 'maritime-atlas:L1')).toEqual({ fresh: true, rank: 1 });
    expect(slotPlace(all, parent, ['finance', 'maritime'], 'finance:L1')).toEqual({ fresh: false, rank: 0 });
    expect(slotPlace(all, parent, ['finance'], 'maritime-atlas:L1')).toEqual({ fresh: true, rank: 1 });
    expect(slotPlace(all, parent, undefined, 'finance:L1')).toEqual({ fresh: false, rank: 0 });
    expect(slotPlace(all, parent, undefined, 'inconnu:L9')).toEqual({});
    expect(slotPlace(all, parent, undefined, undefined)).toEqual({});
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: []\n'); // illisible (liste vide) : pas de rang, et non le rang 0 du plus prioritaire
    expect(slotPlace(all, parent, undefined, 'finance:L1')).toEqual({ fresh: false });
  });
});
