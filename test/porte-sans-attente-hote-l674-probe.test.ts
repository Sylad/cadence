import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withPlace, type PlaceOpts } from '../src/orchestrate/gate-place.js';
import { hostGates, localGates } from '../src/orchestrate/gate-host-slots.js';
import type { OrchestrateConfig } from '../src/config.js';
import { git, harness } from './orchestrate-harness.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs } from './helpers.js';

afterEach(cleanupTempDirs);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT = "en attente d'un créneau de porte sur box";

let remote: FakeRemote;
let h: ReturnType<typeof harness>;
let said: string[];
let held: (() => void)[];
beforeEach(() => {
  remote = fakeRemote();
  h = harness();
  said = [];
  held = [];
});
afterEach(() => {
  for (const free of held) free();
});

const opts = (gate: Record<string, unknown> = {}, extra: Partial<PlaceOpts> = {}): PlaceOpts => ({
  config: { test: 'true', gate: { overflow: 'box', ...gate } } as OrchestrateConfig,
  repo: h.repo,
  sha: git(h.repo, 'rev-parse', 'HEAD'),
  dir: h.repo,
  needClean: true,
  label: 'porte du lot L1',
  local: async () => ({ code: 0, output: '' }),
  say: (l) => said.push(l),
  env: remote.env,
  ...extra,
});
const count = (needle: string) => said.filter((l) => l.includes(needle)).length;
const occupyLocal = async () => void held.push(await localGates().acquire(1));

describe('L674 — jamais d\'attente d\'un créneau de l\'hôte', () => {
  it('trois portes, local pris, maxParallel 2 : deux partent sur l\'hôte, la troisième attend le local, une seule fois, sans ligne d\'attente', async () => {
    await occupyLocal();
    const places: (boolean | undefined)[] = [undefined, undefined, undefined];
    let waits = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = (i: number) => withPlace(opts({ maxParallel: 2 }, { owner: {}, onWait: () => waits++ }), async (p) => ((places[i] = p.remote()), await gate));
    const all = [run(0), run(1)];
    await wait(1500);
    all.push(run(2));
    await wait(1500);
    expect(places).toEqual([true, true, undefined]);
    expect(waits).toBe(1);
    expect(count(WAIT)).toBe(0);
    release();
    await wait(300);
    expect(places[2]).toBeUndefined(); // l'hôte libéré ne la prend pas
    held.pop()!();
    await Promise.all(all);
    expect(places[2]).toBe(false);
    expect(waits).toBe(1);
  });

  it('la demande de créneau abandonnée ne laisse pas de fantôme dans la file de l\'hôte', async () => {
    await occupyLocal();
    const hostFree = await hostGates('box').acquire(1);
    const p = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => {});
    await wait(1200);
    hostFree();
    const t = hostGates('box').request(1);
    expect(t.started()).toBe(true); // aucun fantôme n'a pris le créneau libéré
    t.cancel();
    held.pop()!();
    await p;
  });

  it('deux portes en attente du local : servies dans l\'ordre des demandes, sans ligne d\'attente de l\'hôte', async () => {
    await occupyLocal();
    const hostFree = await hostGates('box').acquire(1);
    const order: number[] = [];
    const run = (i: number) => withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => void order.push(i));
    const a = run(1);
    await wait(1200);
    const b = run(2);
    await wait(1200);
    held.pop()!();
    await Promise.all([a, b]);
    hostFree();
    expect(order).toEqual([1, 2]);
    expect(count(WAIT)).toBe(0);
  });

  it('hôte injoignable, local occupé : la porte attend le local, onWait une fois, aucune ligne d\'attente de créneau', async () => {
    await occupyLocal();
    let waits = 0;
    const down = fakeRemote();
    const o = opts({}, { owner: {}, onWait: () => waits++, env: { ...down.env, PATH: '/nonexistent' } });
    let ran = false;
    const p = withPlace(o, async () => void (ran = true));
    await wait(1500);
    expect(ran).toBe(false);
    held.pop()!();
    await p;
    expect(ran).toBe(true);
    expect(waits).toBe(1);
    expect(count(WAIT)).toBe(0);
  });

  it('gate.host (sans overflow) garde sa ligne d\'attente de créneau', async () => {
    const hostFree = await hostGates('box').acquire(1);
    let waits = 0;
    const o = opts({ maxParallel: 1 }, { owner: {}, onWait: () => waits++ });
    o.config = { test: 'true', gate: { host: 'box', maxParallel: 1 } } as OrchestrateConfig;
    const p = withPlace(o, async () => {});
    await wait(1200);
    expect(count(WAIT)).toBe(1);
    expect(waits).toBe(1);
    hostFree();
    await p;
  });
});
