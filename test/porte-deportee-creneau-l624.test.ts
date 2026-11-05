import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { setGate } from '../src/orchestrate/cycle/ctx.js';
import { withPlace } from '../src/orchestrate/gate-place.js';
import { newLot, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { renderTable } from '../src/orchestrate/table.js';
import { GATE_HOST_DEFAULT, hostGates } from '../src/orchestrate/gate-host-slots.js';
import type { OrchestrateConfig } from '../src/config.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport } from './orchestrate-harness.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const yamlWith = (gate: string): string => {
  const dir = tempDir();
  const file = join(dir, 'cadence.yaml');
  writeFileSync(file, `orchestrate:\n  test: npm test\n  gate:\n    host: box\n${gate}`);
  return file;
};

describe('L624 — gate.maxParallel, la borne des portes simultanées sur l\'hôte', () => {
  it('R4 — un entier positif est lu ; absent, la clé reste absente (le défaut se pose à l\'usage)', () => {
    expect(readOrchestrateConfig(yamlWith('    maxParallel: 3\n')).gate?.maxParallel).toBe(3);
    expect(readOrchestrateConfig(yamlWith('')).gate?.maxParallel).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', '"2"', 'true', '[]'])('R4 — %s est refusé, la clé nommée', (v) => {
    expect(() => readOrchestrateConfig(yamlWith(`    maxParallel: ${v}\n`))).toThrow(/orchestrate\.gate\.maxParallel : entier positif attendu/);
  });

  it('R4 — maxParallel seul (sans host) ne déclare pas de porte : readsPlan reste refusé comme avant', () => {
    const dir = tempDir();
    const file = join(dir, 'cadence.yaml');
    writeFileSync(file, 'orchestrate:\n  gate:\n    maxParallel: 2\n');
    expect(readOrchestrateConfig(file).gate).toEqual({ maxParallel: 2 });
  });
});

describe('L624 — le nombre de portes simultanées sur un hôte', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it('R5 — avec la borne 2, la troisième porte attend qu\'une des deux libère', async () => {
    const gates = hostGates('hote-r5');
    const a = await gates.acquire(2);
    const b = await gates.acquire(2);
    let third = false;
    const c = gates.acquire(2).then((r) => ((third = true), r));
    await tick();
    expect(third).toBe(false);
    a();
    const rc = await c;
    expect(third).toBe(true);
    b();
    rc();
  });

  it('R5 — libérer deux fois ne rend qu\'un créneau', async () => {
    const gates = hostGates('hote-r5-deux');
    const a = await gates.acquire(1);
    let second = false;
    const p = gates.acquire(1).then((r) => ((second = true), r));
    a();
    a();
    const rb = await p;
    let third = false;
    const q = gates.acquire(1).then((r) => ((third = true), r));
    await tick();
    expect(third).toBe(false); // sans le garde, le second a() aurait ouvert un créneau de trop
    rb();
    (await q)();
    expect(second).toBe(true);
  });

  it('R5 — un autre hôte a sa propre borne', async () => {
    const a = await hostGates('hote-x').acquire(1);
    const b = await Promise.race([hostGates('hote-y').acquire(1), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    expect(b).not.toBeNull();
    a();
    b?.();
  });

  it('R5 — le défaut est 2', () => {
    expect(GATE_HOST_DEFAULT).toBe(2);
  });
});

describe('L624 — une porte jouée sur l\'hôte rend le créneau de session du lot (pool)', () => {
  /** Deux lots de deux dépôts, un créneau : L1 est dans sa porte (posée par la session) tant que L2 n'a pas démarré. */
  async function play(remoteGate: boolean) {
    const hs = [harness(), harness()];
    let l2Started: () => void = () => {};
    const started = new Promise<void>((r) => (l2Started = r));
    const ctxs: LotCtx[] = [];
    const claude = async (args: string[], o: { cwd: string }) => {
      const lot = /on lot `(L\d)`/.exec(args[1] ?? '')?.[1];
      if (!lot) return claudeOut(reviewReport());
      const mine = ctxs.find((c) => c.lot.repo === o.cwd)!;
      if (o.cwd === hs[0].repo) {
        setGate(mine, { label: 'tests', started: new Date().toISOString(), ...(remoteGate ? { remote: true as const } : {}) });
        await Promise.race([started, new Promise((r) => setTimeout(r, 300))]);
        setGate(mine, undefined);
      } else l2Started();
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${lot}-${Math.random()}.txt`, `feat(${lot}): x`)] }));
    };
    const wave = { ...hs[0].wave, claude: claude as never };
    ctxs.push({ ...hs[0].lot('L1'), wave }, { ...hs[1].lot('L1'), wave });
    ctxs[1].lot.project = 'b';
    let l2WhileGate = false;
    started.then(() => (l2WhileGate = !!ctxs[0].lot.gate));
    await runPool(ctxs, 1);
    return l2WhileGate;
  }

  it('R1 — un lot dont la porte est sur l\'hôte ne tient plus de file : le lot suivant part pendant la porte (un seul créneau)', async () => {
    expect(await play(true)).toBe(true);
  });

  it('R2 — une porte locale occupe encore son créneau : le lot suivant attend la fin de la porte', async () => {
    expect(await play(false)).toBe(false);
  });
});

describe('L624 — le lieu de la porte dit au lot si elle est sur l\'hôte', () => {
  let remote: FakeRemote;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    remote = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });
  const opts = (h: ReturnType<typeof harness>, config: Partial<OrchestrateConfig>, said: string[]) => ({ config: { test: 'true', ...config } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: (l: string) => said.push(l) });

  it('R3 — remote() est vrai sur l\'hôte, faux sans hôte', async () => {
    const h = harness();
    const said: string[] = [];
    await withPlace(opts(h, { gate: { host: 'machine' } }, said), async (p) => expect(p.remote()).toBe(true));
    await withPlace(opts(h, {}, said), async (p) => expect(p.remote()).toBe(false));
  });

  it('R3 — remote() redevient faux quand la connexion est perdue (la commande rejouée en local pèse sur la machine)', async () => {
    const h = harness();
    const said: string[] = [];
    await withPlace(opts(h, { gate: { host: 'machine' } }, said), async (p) => {
      expect(p.remote()).toBe(true);
      remote.lose('PERDUE');
      await p.run('echo PERDUE');
      expect(p.remote()).toBe(false);
    });
  });

  it('R5 — la porte distante tient un créneau de l\'hôte jusqu\'à close ; une porte locale n\'en prend pas', async () => {
    const h = harness();
    const said: string[] = [];
    const cfg = { gate: { host: 'machine', maxParallel: 1 } };
    let second = false;
    await withPlace(opts(h, cfg, said), async () => {
      const p2 = withPlace(opts(h, cfg, said), async () => void (second = true));
      await withPlace(opts(h, {}, said), async () => {}); // locale : passe sans attendre
      await new Promise((r) => setTimeout(r, 100));
      expect(second).toBe(false);
      expect(said.some((l) => l.includes('en attente d\'un créneau de porte sur machine'))).toBe(true);
      void p2;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(second).toBe(true);
  });
});

describe('L624 — la ligne de base ne reprend pas le tour que la porte du lot tient', () => {
  let saved: NodeJS.ProcessEnv;
  let remote: FakeRemote;
  beforeEach(() => {
    saved = { ...process.env };
    remote = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  it('R5 — une porte ouverte pour le même lot pendant que sa porte tient le tour (ligne de base) n\'attend pas, même avec maxParallel 1', async () => {
    const h = harness();
    const owner = {};
    const o = { config: { test: 'true', gate: { host: 'machine-lb', maxParallel: 1 } } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: () => {}, owner };
    let nested = false;
    const run = withPlace(o, async () => {
      await withPlace(o, async () => void (nested = true));
    });
    await Promise.race([run, new Promise((r) => setTimeout(r, 3000))]);
    expect(nested).toBe(true);
  });

  it('R5 — un autre lot, lui, attend le tour tenu', async () => {
    const h = harness();
    const base = { config: { test: 'true', gate: { host: 'machine-lb2', maxParallel: 1 } } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: () => {} };
    let other = false;
    await withPlace({ ...base, owner: {} }, async () => {
      void withPlace({ ...base, owner: {} }, async () => void (other = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(other).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(other).toBe(true);
  });

  it('R3 — la connexion perdue prévient le lot (onLocal) avant que la commande ne soit rejouée en local', async () => {
    const h = harness();
    const events: string[] = [];
    const o = { config: { test: 'true', gate: { host: 'machine-lost' } } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => (events.push('local'), { code: 0, output: '' }), say: () => {}, onLocal: () => events.push('perdue') };
    await withPlace(o, async (p) => {
      remote.lose('PERDUE');
      await p.run('echo PERDUE');
    });
    expect(events).toEqual(['perdue', 'local']);
  });
});

describe('L624 — le cycle pose la porte du lot « sur l\'hôte » pendant la commande', () => {
  let saved: NodeJS.ProcessEnv;
  let remote: FakeRemote;
  beforeEach(() => {
    saved = { ...process.env };
    remote = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  const seen = async (config: Partial<OrchestrateConfig>) => {
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }))], review: [() => claudeOut(reviewReport())] } });
    const ctx = h.lot('L1', {}, { test: 'true', ...config });
    const gates: (boolean | undefined)[] = [];
    h.wave.slotsChanged = () => ctx.lot.gate && gates.push(ctx.lot.gate.remote);
    await runLot(ctx);
    return gates;
  };

  it('R3 — avec gate.host, la porte du lot est posée remote ; sans hôte, elle ne l\'est pas', async () => {
    expect(await seen({ gate: { host: 'machine' } })).toEqual([true]);
    expect(await seen({})).toEqual([undefined]);
  });

  it('R3 — la connexion perdue retire « sur l\'hôte » de la porte du lot avant le rejeu local', async () => {
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }))], review: [() => claudeOut(reviewReport())] } });
    const ctx = h.lot('L1', {}, { test: 'echo PERDUE', gate: { host: 'machine' } });
    const gates: (boolean | undefined)[] = [];
    h.wave.slotsChanged = () => ctx.lot.gate && gates.push(ctx.lot.gate.remote);
    remote.lose('PERDUE');
    await runLot(ctx);
    expect(gates.slice(0, 2)).toEqual([true, undefined]);
  });
});

describe('L624 — une porte qui attend son créneau sur l\'hôte rend aussi le créneau de session (pool réel)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    const fake = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = fake.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  it('R1 — un créneau, borne 1 sur l\'hôte : le troisième lot part pendant que le deuxième attend l\'hôte, et son état dit l\'attente', async () => {
    const hs = [harness(), harness(), harness()];
    const ctxs: LotCtx[] = [];
    const gatesAtStart: ({ remote?: true; waiting?: true } | undefined)[][] = [];
    const claude = async (args: string[], o: { cwd: string }) => {
      const lot = /on lot `(L\d)`/.exec(args[1] ?? '')?.[1];
      if (!lot) return claudeOut(reviewReport());
      gatesAtStart.push(ctxs.map((c) => (c.lot.repo === o.cwd ? undefined : c.lot.gate && { ...(c.lot.gate.remote ? { remote: true as const } : {}), ...(c.lot.gate.waiting ? { waiting: true as const } : {}) })));
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${lot}-${Math.random()}.txt`, `feat(${lot}): x`)] }));
    };
    const wave = { ...hs[0].wave, claude: claude as never };
    const config = { test: 'sleep 1.5', gate: { host: 'machine-pool-r1', maxParallel: 1 } };
    ctxs.push(...hs.map((h, i) => ({ ...h.lot('L1', {}, config), wave })));
    ctxs[1].lot.project = 'b';
    ctxs[2].lot.project = 'c';
    await runPool(ctxs, 1);
    // Trois implémentations : au départ de la troisième, la porte du lot a tourne sur l'hôte et celle du lot b attend son créneau — aucune session n'est tenue par eux.
    expect(gatesAtStart).toHaveLength(3);
    expect(gatesAtStart[2]).toEqual([{ remote: true }, { remote: true, waiting: true }, undefined]);
  });

  it('R1 — le tableau de --status dit « porte en attente de l\'hôte », pas « implémentation » ni « porte tests »', () => {
    const wave: WaveState = { id: 'w1', created: '2026-11-05T08:30:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'running', pid: 1, lots: ['demo:L1'] };
    const l: LotState = newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    l.status = 'implementing';
    l.next = 'review';
    l.gate = { label: 'tests', started: new Date(Date.now() - 3 * 60_000).toISOString(), remote: true, waiting: true };
    const row = renderTable(wave, [l])[1];
    expect(row).toMatch(/porte en attente de l'hôte \(3 min\)/);
    expect(row).not.toContain('implémentation');
    expect(row).not.toContain('porte tests');
  });
});

describe('L624 — la ligne de base d\'un lot rouge sur l\'hôte, dans le cycle', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    const fake = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = fake.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });
  const lot = (h: ReturnType<typeof harness>, test: string) => h.lot('L1', {}, { test, gate: { host: 'machine-cycle-lb', maxParallel: 1 } });
  const scripted = () => harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }))], review: [() => claudeOut(reviewReport())] } });

  it('R5 — avec maxParallel 1, la ligne de base jouée pendant la porte du lot ne l\'attend pas : le lot finit, le rouge déjà rouge au départ est listé à part', async () => {
    const h = scripted();
    const ctx = lot(h, "echo ' FAIL  test/a.test.ts > tiroir'; exit 1");
    const done = await Promise.race([runLot(ctx).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))]);
    expect(done).toBe(true);
    expect(ctx.lot.status).not.toBe('implementing');
    expect(ctx.lot.warnings.some((w) => w.includes('déjà rouge(s) au sha de départ'))).toBe(true);
    expect(h.calls.map((c) => c.kind)).toEqual(['implement', 'review']);
  });

  it('R3 — hôte tombé avant la ligne de base : repliée en local, elle retire « sur l\'hôte » de la porte du lot, puis le rend quand elle est finie', async () => {
    const h = scripted();
    // La commande de la porte coupe l'hôte derrière elle : la ligne de base qui suit ne peut plus l'ouvrir.
    const ctx = lot(h, `touch "$FAKE_DIR/down"; echo ' FAIL  test/a.test.ts > tiroir'; exit 1`);
    const gates: (boolean | undefined)[] = [];
    h.wave.slotsChanged = () => ctx.lot.gate && gates.push(ctx.lot.gate.remote);
    await runLot(ctx);
    expect(gates).toEqual([true, undefined, true]);
    expect(ctx.lot.warnings.some((w) => w.includes('déjà rouge(s) au sha de départ'))).toBe(true);
  });
});
