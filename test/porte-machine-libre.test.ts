import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { withPlace, type PlaceOpts } from '../src/orchestrate/gate-place.js';
import { hostGates, localGates } from '../src/orchestrate/gate-host-slots.js';
import { acquireSlot, liveSlots } from '../src/orchestrate/registry.js';
import type { OrchestrateConfig } from '../src/config.js';
import { commitFile, git, harness } from './orchestrate-harness.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT = 'en attente d\'un créneau de porte sur box';

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

/** Options d'une porte avec `gate.overflow: box` (ou la gate donnée) ; chaque appel d'un test peut y poser un autre `owner`. */
const opts = (gate: Record<string, unknown> = {}, extra: Partial<PlaceOpts> = {}, config: Partial<OrchestrateConfig> = {}): PlaceOpts => ({
  config: { test: 'true', gate: { overflow: 'box', ...gate }, ...config } as OrchestrateConfig,
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
const probes = () => remote.commands().filter((c) => c.includes('uname -s')).length;
const sshCalls = () => remote.commands().length;
const count = (needle: string) => said.filter((l) => l.includes(needle)).length;
/** La machine locale est tenue par la porte d'un autre lot jusqu'à `held` libéré. */
const occupyLocal = async () => void held.push(await localGates().acquire(1));

describe('L639 — la porte joue sur la machine libre : le local d\'abord', () => {
  it('R1 — overflow, local libre : la porte joue en local et aucun appel ssh n\'est fait', async () => {
    let ran = false;
    await withPlace(opts(), async (p) => {
      expect(p.remote()).toBe(false);
      await p.run('x');
      ran = true;
    });
    expect(ran).toBe(true);
    expect(sshCalls()).toBe(0);
  });

  it('R1 — overflow, local libre : une seule ligne de lieu est écrite', async () => {
    await withPlace(opts(), async () => {});
    expect(said).toEqual(['porte du lot L1 : jouée en local, machine locale libre']);
  });

  it('R1 — porte locale libre puis ligne de base du même lot avec local occupé : le préflight a lieu alors, une fois', async () => {
    const owner = {};
    await withPlace(opts({}, { owner }), async () => {});
    expect(probes()).toBe(0);
    await occupyLocal();
    await withPlace(opts({}, { owner }), async (p) => expect(p.remote()).toBe(true));
    expect(probes()).toBe(1);
  });

  it('R2 — overflow, local occupé, hôte joignable : la porte joue sur l\'hôte avec la ligne existante', async () => {
    await occupyLocal();
    await withPlace(opts(), async (p) => {
      expect(p.remote()).toBe(true);
      expect(p.stamp().lieu).toMatch(/^hôte box, sha [0-9a-f]{7}, /);
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^porte du lot L1 : porte jouée sur l'hôte box \(sha [0-9a-f]{7}, .+\)$/);
  });

  it('R3 — overflow, deux portes simultanées avec hôte joignable : une locale, une sur l\'hôte', async () => {
    const places: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = withPlace(opts({}, { owner: {} }), async (p) => (places.push(p.remote()), await gate));
    const b = withPlace(opts({}, { owner: {} }), async (p) => (places.push(p.remote()), await gate));
    await wait(1500);
    expect(places.sort()).toEqual([false, true]);
    release();
    await Promise.all([a, b]);
  });

  it('R3 — la ligne de base d\'un lot qui tient la machine locale ne s\'attend pas elle-même', async () => {
    const owner = {};
    let nested = false;
    await withPlace(opts({}, { owner }), async () => {
      await Promise.race([withPlace(opts({}, { owner }), async (p) => ((nested = true), expect(p.remote()).toBe(false))), wait(1500)]);
    });
    expect(nested).toBe(true);
    expect(sshCalls()).toBe(0);
  });

  it('R3 — une session claude active ne rend pas le local occupé : seule une porte de la machine locale compte', async () => {
    const home = tempDir();
    held.push(await acquireSlot(home, 1, { wave: 'w' })); // le seul créneau de session est pris
    expect(liveSlots(home)).toHaveLength(1);
    let ran = false;
    await withPlace(opts({}, { owner: {} }), async (p) => ((ran = true), expect(p.remote()).toBe(false)));
    expect(ran).toBe(true);
    expect(sshCalls()).toBe(0);
    expect(count('jouée en local, machine locale libre')).toBe(1);
  });
});

describe('L639 — deux machines occupées : l\'attente (R4, R13)', () => {
  it('R4 — deux machines occupées : la porte attend et la ligne d\'attente est écrite une fois', async () => {
    await occupyLocal();
    held.push(await hostGates('box').acquire(1));
    let waits = 0;
    let ran = false;
    const p = withPlace(opts({ maxParallel: 1 }, { owner: {}, onWait: () => waits++ }), async () => void (ran = true));
    await wait(1200);
    expect(ran).toBe(false);
    expect(count(WAIT)).toBe(1);
    expect(waits).toBe(1);
    expect(said.find((l) => l.includes(WAIT))).toBe(`porte du lot L1 : ${WAIT} (1 porte(s) simultanée(s) au plus)`);
    held.pop()!(); // l'hôte se libère : la porte part dessus
    await p;
    expect(ran).toBe(true);
  });

  it('R4 — la première machine libérée prend la porte en attente', async () => {
    const localFree = await localGates().acquire(1);
    const hostFree = await hostGates('box').acquire(1);
    held.push(hostFree);
    let where: boolean | undefined;
    const p = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async (pl) => void (where = pl.remote()));
    await wait(1200);
    localFree();
    await p;
    expect(where).toBe(false);
    expect(count('machine locale libre')).toBe(1);
  });

  it('R4 — hôte indisponible : la porte attend le tour local sans tour de l\'hôte', async () => {
    remote.down();
    const localFree = await localGates().acquire(1);
    let ran = false;
    const p = withPlace(opts({}, { owner: {} }), async () => void (ran = true));
    await wait(1200);
    expect(ran).toBe(false);
    const probe = hostGates('box').request(1);
    expect(probe.started()).toBe(true); // aucun tour de l'hôte n'est tenu ni demandé
    probe.cancel();
    localFree();
    await p;
    expect(ran).toBe(true);
  });

  it('R13 — maxParallel borne les portes simultanées sur l\'hôte de débordement', async () => {
    await occupyLocal();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let second = false;
    const a = withPlace(opts({ maxParallel: 1 }, { owner: {} }), () => gate);
    await wait(1200);
    const b = withPlace(opts({ maxParallel: 1 }, { owner: {} }), async () => void (second = true));
    await wait(1500);
    expect(second).toBe(false);
    expect(count(WAIT)).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(second).toBe(true);
  });
});

describe('L639 — la décision d\'hôte, une fois par lot (R5, R6, R7, R8, R10)', () => {
  it('R5 — porte puis ligne de base d\'un même lot, local occupé : un seul préflight', async () => {
    await occupyLocal();
    const owner = {};
    await withPlace(opts({}, { owner }), async () => {
      await withPlace(opts({}, { owner }), async (p) => expect(p.remote()).toBe(true));
    });
    expect(probes()).toBe(1);
  });

  it('R5 — deux lots : un préflight chacun', async () => {
    await occupyLocal();
    await withPlace(opts({}, { owner: {} }), async () => {});
    await withPlace(opts({}, { owner: {} }), async () => {});
    expect(probes()).toBe(2);
  });

  it('R5 — sans owner : aucune décision gardée', async () => {
    await occupyLocal();
    await withPlace(opts(), async () => {});
    await withPlace(opts(), async () => {});
    expect(probes()).toBe(2);
  });

  it('R5 — deux lieux du même lot demandés en même temps : un préflight', async () => {
    await occupyLocal();
    const owner = {};
    await Promise.all([withPlace(opts({}, { owner }), async () => {}), withPlace(opts({}, { owner }), async () => {})]);
    expect(probes()).toBe(1);
  });

  it('R5 — échec de push : la ligne de base ne retente ni push ni cache', async () => {
    await occupyLocal();
    remote.lose('git-receive-pack');
    const owner = {};
    const first = withPlace(opts({}, { owner }), async () => {});
    await wait(1500);
    held.pop()!(); // le tour local passe à la porte repliée
    await first;
    const before = sshCalls();
    await withPlace(opts({}, { owner }), async (p) => expect(p.remote()).toBe(false));
    expect(sshCalls()).toBe(before);
    expect(count('cache de dépendances impossible sur box (push du sha impossible')).toBe(1);
    expect(count('porte déportée indisponible')).toBe(0);
  });

  it('R5 — porte locale libre puis ligne de base avec local occupé : décision prise à ce moment', async () => {
    const owner = {};
    await withPlace(opts({}, { owner }), async () => {});
    expect(probes()).toBe(0);
    await occupyLocal();
    await withPlace(opts({}, { owner }), async () => {});
    expect(probes()).toBe(1);
  });

  it('R6 — l\'appel ssh du préflight d\'overflow passe exactement ConnectTimeout=3 (échoue à 5)', async () => {
    await occupyLocal();
    await withPlace(opts({}, { owner: {} }), async () => {});
    expect(remote.options()[1]).toBe('ConnectTimeout=3');
    expect(remote.options()).not.toContain('ConnectTimeout=5');
  });

  it('R6 — hôte injoignable : la décision du lot est indisponible', async () => {
    await occupyLocal();
    remote.down();
    const owner = {};
    const p = withPlace(opts({}, { owner }), async () => {});
    await wait(800);
    expect(said).toEqual([expect.stringMatching(/^porte du lot L1 : porte déportée indisponible sur box \(.*Connection refused.*\) — jouée en local$/)]);
    held.pop()!();
    await p;
    const before = sshCalls();
    await occupyLocal();
    const q = withPlace(opts({}, { owner }), async () => {});
    await wait(300);
    held.pop()!();
    await q;
    expect(sshCalls()).toBe(before);
  });

  it('R6 — sonde connectée puis bloquée : coupée à la borne totale, décision indisponible', async () => {
    const bin = join(tempDir(), 'bin');
    const sh = join(bin, 'ssh');
    mkdirSync(bin);
    writeFileSync(sh, '#!/bin/sh\nexec sleep 60\n');
    chmodSync(sh, 0o755);
    await occupyLocal();
    const started = Date.now();
    const p = withPlace(opts({}, { owner: {}, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } }), async () => {});
    while (!count('porte déportée indisponible') && Date.now() - started < 18_000) await wait(100);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(9_500); // la sonde bloquée n'est coupée qu'à la borne totale de 10 s…
    expect(elapsed).toBeLessThan(16_000); // …et pas à celle de 30 s de gate.host
    expect(said.join('\n')).toMatch(/porte déportée indisponible sur box \(délai dépassé \(10 s\)\) — jouée en local/);
    held.pop()!();
    await p;
  }, 20_000);

  it('R6 — gate.host : la sonde garde ConnectTimeout=5', async () => {
    await withPlace(opts({ overflow: undefined, host: 'box' }), async () => {});
    expect(remote.options()[1]).toBe('ConnectTimeout=5');
  });

  it('R7 — hôte injoignable, porte et ligne de base : une seule ligne « porte déportée indisponible »', async () => {
    remote.down();
    const owner = {};
    await occupyLocal();
    const first = withPlace(opts({}, { owner }), async () => {
      await withPlace(opts({}, { owner }), async () => {});
    });
    await wait(800);
    held.pop()!();
    await first;
    expect(count('porte déportée indisponible')).toBe(1);
  });

  it('R7 — lieux suivants du lot : aucun appel ssh', async () => {
    remote.down();
    const owner = {};
    await occupyLocal();
    const first = withPlace(opts({}, { owner }), async () => {});
    await wait(800);
    const afterProbe = sshCalls();
    held.pop()!();
    await first;
    await occupyLocal();
    const second = withPlace(opts({}, { owner }), async () => {});
    await wait(300);
    held.pop()!();
    await second;
    expect(afterProbe).toBe(1);
    expect(sshCalls()).toBe(afterProbe);
  });

  it('R7 — échec de cache : une seule ligne « cache de dépendances impossible » par lot', async () => {
    commitFile(h.repo, 'package-lock.json', 'chore: lock');
    await occupyLocal();
    const owner = {};
    const first = withPlace(opts({ install: 'exit 1' }, { owner }), async () => {
      await withPlace(opts({ install: 'exit 1' }, { owner }), async () => {});
    });
    await wait(2500);
    held.pop()!();
    await first;
    expect(count('cache de dépendances impossible sur box')).toBe(1);
    expect(count('porte déportée indisponible')).toBe(0);
  });

  it('R7 — échec de push : la ligne de repli est « cache de dépendances impossible », pas « porte déportée indisponible »', async () => {
    await occupyLocal();
    remote.lose('git-receive-pack');
    const first = withPlace(opts({}, { owner: {} }), async () => {});
    await wait(1500);
    held.pop()!();
    await first;
    expect(said.filter((l) => l.includes('impossible'))).toEqual([expect.stringMatching(/^porte du lot L1 : cache de dépendances impossible sur box \(push du sha impossible.*\) — jouée en local$/)]);
  });

  it('R8 — connexion perdue en cours de porte : rejeu local et ligne dite une fois', async () => {
    await occupyLocal();
    const replayed: string[] = [];
    await withPlace(opts({}, { owner: {}, local: async (c) => (replayed.push(c), { code: 0, output: '' }) }), async (p) => {
      remote.lose('PERDUE');
      await p.run('echo PERDUE');
      await p.run('echo PERDUE');
    });
    expect(replayed).toEqual(['echo PERDUE', 'echo PERDUE']);
    expect(count('connexion perdue avec box pendant la porte — rejouée en local')).toBe(1);
  });

  it('R8 — connexion perdue pendant la ligne de base imbriquée : la porte du lot ne retente pas l\'hôte', async () => {
    await occupyLocal();
    const owner = {};
    const replayed: string[] = [];
    const local = async (c: string) => (replayed.push(c), { code: 0, output: '' });
    await withPlace(opts({}, { owner, local }), async (outer) => {
      await withPlace(opts({}, { owner, local }), async (nested) => {
        remote.lose('PERDUE');
        await nested.run('echo PERDUE');
      });
      const before = sshCalls();
      await outer.run('echo SUITE');
      expect(sshCalls()).toBe(before);
      expect(outer.remote()).toBe(false);
    });
    expect(replayed).toEqual(['echo PERDUE', 'echo SUITE']);
    expect(count('connexion perdue avec box pendant la porte — rejouée en local')).toBe(1);
  });

  it('R8 — après connexion perdue, la ligne de base du lot ne sonde plus l\'hôte', async () => {
    await occupyLocal();
    const owner = {};
    let after = 0;
    await withPlace(opts({}, { owner }), async (p) => {
      remote.lose('PERDUE');
      await p.run('echo PERDUE');
      after = sshCalls();
      held.pop()!(); // la machine locale se libère : la ligne de base du lot y joue sans toucher l'hôte
      await withPlace(opts({}, { owner }), async (n) => expect(n.remote()).toBe(false));
      expect(sshCalls()).toBe(after);
    });
    expect(probes()).toBe(1);
    expect(count('porte déportée indisponible')).toBe(0);
  });

  it('R10 — lot A voit l\'hôte tomber, lot B démarré après : nouveau préflight', async () => {
    await occupyLocal();
    remote.down();
    const a = withPlace(opts({}, { owner: {} }), async () => {});
    await wait(800);
    held.pop()!();
    await a;
    remote.down(false);
    await occupyLocal();
    await withPlace(opts({}, { owner: {} }), async (p) => expect(p.remote()).toBe(true));
    expect(probes()).toBe(2);
  });
});

describe('L639 — ce qui ne change pas (R9, R11)', () => {
  it('R9 — sans overflow ni host : aucune ligne nouvelle et aucun ssh', async () => {
    await withPlace(opts({ overflow: undefined }, {}, { gate: undefined }), async () => {});
    expect(said).toEqual([]);
    expect(sshCalls()).toBe(0);
  });

  it('R9 — overflow, sans commande build ni test : locale, ni ligne ni ssh ni tour', async () => {
    await occupyLocal();
    await withPlace(opts({}, {}, { test: undefined }), async (p) => expect(p.remote()).toBe(false));
    expect(said).toEqual([]);
    expect(sshCalls()).toBe(0);
  });

  it('R9 — overflow, worktree non validé : même ligne qu\'avant', async () => {
    writeFileSync(join(h.repo, 'sale.txt'), 'x');
    await withPlace(opts(), async () => {});
    expect(said).toEqual(['porte du lot L1 : worktree non validé, jouée en local (l\'hôte ne verrait pas les modifications)']);
    expect(sshCalls()).toBe(0);
  });

  it('R9 — overflow, sha invalide : même ligne qu\'avant', async () => {
    await withPlace(opts({}, { sha: 'zz;rm' }), async () => {});
    expect(said).toEqual(['porte du lot L1 : sha invalide pour la porte déportée (hexadécimal attendu), jouée en local']);
  });

  it('R11 — host seul : une porte seule joue sur l\'hôte avec la ligne « porte jouée sur l\'hôte »', async () => {
    await withPlace(opts({ overflow: undefined, host: 'box' }), async (p) => expect(p.remote()).toBe(true));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('porte jouée sur l\'hôte box');
    expect(count('machine locale libre')).toBe(0);
  });

  it('R11 — les pages docs/remote-gate.md, orchestrate-gate.md et config.md mentionnent gate.overflow et gardent le sens de host (la porte est jouée sur l\'hôte)', () => {
    for (const page of ['remote-gate.md', 'orchestrate-gate.md', 'config.md']) {
      const text = readFileSync(join(__dirname, '..', 'docs', page), 'utf8');
      expect(text, page).toContain('gate.overflow');
      expect(text, page).toMatch(/gate\.host.{0,80}the gate is played on the host/s);
    }
  });
});
