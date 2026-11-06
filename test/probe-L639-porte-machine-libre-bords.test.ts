import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPlace, type PlaceOpts } from '../src/orchestrate/gate-place.js';
import { hostGates, localGates } from '../src/orchestrate/gate-host-slots.js';
import { readOrchestrateConfig } from '../src/config.js';
import type { OrchestrateConfig } from '../src/config.js';
import { git, harness } from './orchestrate-harness.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const occupyLocal = async () => void held.push(await localGates().acquire(1));

describe('L639 — bords de la porte sur la machine libre (R3, R4, R8, R12, R13)', () => {
  it('R8 — connexion perdue : le créneau de l\'hôte est rendu tout de suite, une autre porte y joue pendant que la première finit', async () => {
    await occupyLocal();
    let end!: () => void;
    const gate = new Promise<void>((r) => (end = r));
    let lostDone!: () => void;
    const lost = new Promise<void>((r) => (lostDone = r));
    const a = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async (p) => {
      remote.lose('PERDUE');
      await p.run('echo PERDUE');
      remote.lose();
      lostDone();
      await gate;
    });
    await lost;
    let onHost: boolean | undefined;
    const b = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async (p) => void (onHost = p.remote()));
    await Promise.race([b, wait(2500)]);
    expect(onHost).toBe(true);
    end();
    await Promise.all([a, b]);
  });

  it('R5 — échec de cache : le créneau de l\'hôte est rendu, une autre porte (autre lot) y joue ensuite', async () => {
    await occupyLocal();
    remote.lose('git-receive-pack');
    const a = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => {});
    await wait(1500);
    remote.lose();
    let onHost: boolean | undefined;
    const b = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async (p) => void (onHost = p.remote()));
    await Promise.race([b, wait(2500)]);
    expect(onHost).toBe(true);
    held.pop()!();
    await Promise.all([a, b]);
  });

  it('R3 — la ligne de base imbriquée qui finit ne rend pas la machine locale que la porte du lot tient encore', async () => {
    const owner = {};
    await withPlace(opts({}, { owner }), async () => {
      await withPlace(opts({}, { owner }), async () => {});
      const other = localGates().request(1);
      expect(other.started()).toBe(false);
      other.cancel();
    });
    const after = localGates().request(1);
    expect(after.started()).toBe(true);
    after.cancel();
  });

  it('R3 — la même clé de lot rejoue deux portes l\'une après l\'autre : chacune reprend un tour local', async () => {
    const owner = {};
    await withPlace(opts({}, { owner }), async () => {});
    await withPlace(opts({}, { owner }), async () => {});
    expect(said.filter((l) => l.includes('machine locale libre'))).toHaveLength(2);
    const t = localGates().request(1);
    expect(t.started()).toBe(true);
    t.cancel();
  });

  it('R3 — une commande qui lève rend le tour local', async () => {
    await expect(withPlace(opts({}, { owner: {} }), async () => { throw new Error('rouge'); })).rejects.toThrow('rouge');
    const t = localGates().request(1);
    expect(t.started()).toBe(true);
    t.cancel();
  });

  it('R4 — deux portes en attente des deux machines : la première demandée prend la première machine libérée', async () => {
    const localFree = await localGates().acquire(1);
    held.push(await hostGates('box').acquire(1));
    const order: string[] = [];
    const a = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => void order.push('a'));
    await wait(1200);
    const b = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => void order.push('b'));
    await wait(1200);
    localFree();
    await a;
    await b.catch(() => {});
    expect(order[0]).toBe('a');
    held.pop()!();
    await b;
  });
});

describe('L639 — lecture de gate.overflow dans un vrai cadence.yaml (R12, R13)', () => {
  const read = (gate: string) => {
    const file = join(tempDir(), 'cadence.yaml');
    writeFileSync(file, `orchestrate:\n  test: npx vitest run\n  gate:\n${gate}`);
    return () => readOrchestrateConfig(file);
  };
  const MSG = 'orchestrate.gate.overflow : destination ssh attendue (une chaîne sans espace, ne commençant pas par « - »)';

  it('R13 — overflow numérique, liste ou tabulation : refusé avec le message exact', () => {
    for (const v of ['42', '[box]', '"a\\tb"', '"-oProxyCommand=x"', '" "']) expect(read(`    overflow: ${v}\n`), v).toThrow(MSG);
  });

  it('R13 — overflow entouré d\'espaces : rogné comme host', () => {
    expect(read('    overflow: "  box  "\n')().gate?.overflow).toBe('box');
  });

  it('R12 — host: null avec overflow : lu comme overflow seul', () => {
    const c = read('    host: null\n    overflow: box\n')();
    expect(c.gate).toEqual({ overflow: 'box' });
  });

  it('R12 — overflow: null avec host : lu comme host seul', () => {
    expect(read('    host: box\n    overflow: null\n')().gate).toEqual({ host: 'box' });
  });
});
