import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSlot } from '../src/orchestrate/registry.js';
import { slotPlace } from '../src/orchestrate/attente.js';
import type { LotState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

const POLL = 5;
const lot = (project: string, steps: number, id = 'L1') => ({ project, lot: id, steps: Array.from({ length: steps }, () => ({})) }) as unknown as LotState;

describe('L531 bords — attentes illisibles, doublons, rang neutre', () => {
  it('une inscription corrompue ne retient personne', async () => {
    const home = tempDir();
    mkdirSync(join(home, 'waiters'), { recursive: true });
    writeFileSync(join(home, 'waiters', 'x-1.json'), '{pas du json');
    writeFileSync(join(home, 'waiters', 'y-1.json'), '');
    const free = await acquireSlot(home, 1, { wave: 'a', pollMs: POLL, fresh: true });
    free();
  });

  it("une inscription d'un pid vivant avec un `start` périmé (pid réutilisé) ne retient personne", async () => {
    const home = tempDir();
    mkdirSync(join(home, 'waiters'), { recursive: true });
    writeFileSync(join(home, 'waiters', `${process.pid}-99.json`), JSON.stringify({ pid: process.pid, start: 'jamais-ce-start', wave: 'fantome', since: 1, seq: 99, fresh: false, rank: 0 }));
    const t = Date.now();
    const free = await acquireSlot(home, 1, { wave: 'a', pollMs: POLL, fresh: true, rank: 9 });
    expect(Date.now() - t).toBeLessThan(1000);
    free();
  });

  it('inscription sans since/seq/rank (champs absents) : triée sans planter, ne bloque pas un vivant plus ancien', async () => {
    const home = tempDir();
    mkdirSync(join(home, 'waiters'), { recursive: true });
    writeFileSync(join(home, 'waiters', '999998-1.json'), JSON.stringify({ pid: 999998, wave: 'morte' }));
    const free = await acquireSlot(home, 1, { wave: 'a', pollMs: POLL });
    free();
  });

  it('deux créneaux libres, deux attentes simultanées : les deux partent (la tête ne monopolise pas)', async () => {
    const home = tempDir();
    const got: string[] = [];
    const run = (w: string, o: object) => acquireSlot(home, 2, { wave: w, pollMs: POLL, ...o }).then((f) => { got.push(w); return f; });
    const frees = await Promise.all([run('a', { fresh: true, rank: 0 }), run('b', { fresh: false, rank: 5 })]);
    expect(got.sort()).toEqual(['a', 'b']);
    frees.forEach((f) => f());
  });

  it('le même processus attend deux fois à la fois : deux inscriptions distinctes, toutes retirées', async () => {
    const home = tempDir();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    const order: string[] = [];
    const mk = (n: string) => acquireSlot(home, 1, { wave: n, pollMs: POLL, rank: 1 }).then((f) => { order.push(n); f(); });
    const ps = [mk('1'), mk('2'), mk('3')];
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(join(home, 'waiters')).length).toBe(3);
    held();
    await Promise.all(ps);
    expect(order).toEqual(['1', '2', '3']);
    expect(readdirSync(join(home, 'waiters'))).toEqual([]);
  });

  it("une attente abandonnée en tête libère la suivante", async () => {
    const home = tempDir();
    const held = await acquireSlot(home, 1, { wave: 'tenu' });
    let stop: string | null = null;
    const a = acquireSlot(home, 1, { wave: 'tete', pollMs: POLL, fresh: false, rank: 0, abandon: () => stop }).catch((e) => (e as Error).message);
    await new Promise((r) => setTimeout(r, 30));
    const b = acquireSlot(home, 1, { wave: 'suite', pollMs: POLL, fresh: true, rank: 9 });
    await new Promise((r) => setTimeout(r, 30));
    stop = 'stop';
    expect(await a).toContain('stop');
    held();
    (await b)();
  });

  it('slotPlace : lot sans aucun pas = premier tirage (fresh)', () => {
    expect(slotPlace([lot('p', 0)], tempDir(), ['p'], 'p:L1')).toEqual({ fresh: true, rank: 0 });
  });

  it('slotPlace : projet imbriqué groupe/gamma et préfixe « maritime » couvre maritime-atlas', () => {
    expect(slotPlace([lot('maritime-atlas', 2)], tempDir(), ['finance', 'maritime'], 'maritime-atlas:L1')).toEqual({ fresh: false, rank: 1 });
    expect(slotPlace([lot('groupe/gamma', 2)], tempDir(), ['groupe/gamma'], 'groupe/gamma:L1')).toEqual({ fresh: false, rank: 0 });
  });

  it('slotPlace : cadence.yaml illisible → rang neutre (pas le rang 0 du plus prioritaire)', () => {
    const parent = tempDir();
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: [a, : :\n  - {');
    const r = slotPlace([lot('finance', 1)], parent, undefined, 'finance:L1');
    expect(r.rank === undefined || r.rank > 0).toBe(true);
  });

  it('slotPlace : priority: de mauvais type (chaîne) → rang neutre, pas de plantage', () => {
    const parent = tempDir();
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: finance\n');
    const r = slotPlace([lot('finance', 1)], parent, undefined, 'finance:L1');
    expect(r.rank === undefined || r.rank > 0).toBe(true);
  });

  it('slotPlace : liste vide `all`', () => {
    expect(slotPlace([], tempDir(), undefined, 'p:L1')).toEqual({});
  });
});
