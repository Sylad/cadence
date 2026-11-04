import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir } from '../src/git.js';
import { cadenceHome, liveWaves } from '../src/orchestrate/registry.js';
import { INTEGRATION_LOCK, takeRepoWrite } from '../src/orchestrate/integrate.js';
import { mutexFor } from '../src/orchestrate/mutex.js';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, run, setup } from './orchestrate-worktree-harness.js';
import { gitRepo, tempDir } from './helpers.js';
import { sharedStateDir } from '../src/state.js';

// L591 — un lot qui attend son tour d'intégration rend son créneau (pool et registre) et reprend à son tour.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (until: () => boolean) => {
  for (let i = 0; i < 1000 && !until(); i++) await sleep(10);
  expect(until()).toBe(true);
};

function repo() {
  const r = gitRepo();
  writeFileSync(join(r, 'a'), 'a\n');
  git(r, 'add', '--', 'a');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

describe('L591 — takeRepoWrite dit quand un lot attend son tour', () => {
  it("R1 — dépôt libre : le tour est immédiat, ni attente ni reprise annoncées", async () => {
    const events: string[] = [];
    const g = await takeRepoWrite(repo(), { wave: 'w' }, { onWait: () => events.push('wait'), onTurn: () => events.push('turn') });
    expect(g.ok).toBe(true);
    if (g.ok) g.release();
    expect(events).toEqual([]);
  });

  it("R1 — dépôt tenu par un autre lot : l'attente est annoncée avant le tour, la reprise une fois le verrou pris", async () => {
    const r = repo();
    const first = await takeRepoWrite(r, { wave: 'w' });
    if (!first.ok) throw new Error('premier tour refusé');
    const events: string[] = [];
    const second = takeRepoWrite(r, { wave: 'w' }, { onWait: () => events.push('wait'), onTurn: () => events.push('turn') });
    await wait(() => events.length > 0);
    expect(events).toEqual(['wait']);
    first.release();
    const g = await second;
    expect(events).toEqual(['wait', 'turn']);
    if (g.ok) g.release();
  });

  it("R1 — verrou fichier d'un autre processus tenu plus que la borne : refus, et la reprise est annoncée (le lot ne reste pas marqué en attente)", async () => {
    const r = repo();
    // pid du parent : vivant, et pas le nôtre — le verrou fichier n'est pas à nous
    writeFileSync(join(sharedStateDir(r), INTEGRATION_LOCK), JSON.stringify({ pid: process.ppid, wave: 'autre', started: new Date().toISOString() }));
    const events: string[] = [];
    const g = await takeRepoWrite(r, { wave: 'w' }, { waitMs: 60, pollMs: 10, onWait: () => events.push('wait'), onTurn: () => events.push('turn') });
    expect(g.ok).toBe(false);
    expect(events).toEqual(['wait', 'turn']);
  });
});

describe('L591 — le pool ne compte pas un lot qui attend son tour', () => {
  /** `n` dépôts, un lot chacun ; la session `implement` du lot d'indice `held[i]` tient jusqu'à `free[i]()`. */
  function pool(n: number, held: number[]) {
    const hs = Array.from({ length: n }, () => harness());
    const started: string[] = [];
    const free: (() => void)[] = [];
    const holds = new Map<string, Promise<void>>();
    held.forEach((i) => holds.set(hs[i].lot('L1').lot.repo, new Promise<void>((r) => (free[i] = r))));
    const claude = async (args: string[], o: { cwd: string }) => {
      const kind = kindOf(args);
      started.push(`${o.cwd}:${kind}`);
      if (kind === 'implement') {
        await holds.get(o.cwd);
        return claudeOut(workReport({ commits: [commitFile(o.cwd, `x-${Math.random()}.txt`, 'feat(L1): x')] }));
      }
      return claudeOut(reviewReport());
    };
    const wave = { ...hs[0].wave, claude } as LotCtx['wave'];
    const ctxs: LotCtx[] = hs.map((h, i) => {
      const c = { ...h.lot('L1'), wave } as LotCtx;
      c.lot.project = String.fromCharCode(97 + i);
      return c;
    });
    const began = (c: LotCtx) => started.some((x) => x.startsWith(c.lot.repo));
    return { ctxs, started, free, began };
  }

  it("R2 — avec un seul créneau, le lot en attente de son tour laisse partir la file suivante, sans attendre sa fin", async () => {
    const s = pool(3, [0]);
    const [a, b] = s.ctxs;
    const done = runPool(s.ctxs, 1);
    await wait(() => s.began(a)); // a joue, b attend un créneau
    expect(s.began(b)).toBe(false);
    a.waitsTurn = true;
    a.turnChanged?.();
    await wait(() => s.began(b));
    expect(a.lot.status).not.toBe('ready'); // a n'a pas fini : b est parti pendant son attente
    a.waitsTurn = false;
    s.free[0]();
    await done;
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready', 'ready']);
  });

  it("R3 — le lot qui reprend son tour compte de nouveau : avec 2 créneaux et a, c en cours (b fini), d ne part pas", async () => {
    const s = pool(4, [0, 1, 2]);
    const [a, , c, d] = s.ctxs;
    const done = runPool(s.ctxs, 2);
    await wait(() => s.began(s.ctxs[1])); // a et b jouent, c et d attendent
    a.waitsTurn = true;
    a.turnChanged?.();
    await wait(() => s.began(c)); // a rend son créneau : c part (3 files en cours)
    a.waitsTurn = false;
    a.turnChanged?.();
    s.free[1](); // b finit : restent a (repris) et c, soit 2 créneaux tenus
    await sleep(80);
    expect(s.began(d)).toBe(false);
    s.free[0]();
    s.free[2]();
    await done;
    expect(s.began(d)).toBe(true);
  });
});

describe("L591 — le registre ne compte plus le lot qui attend son tour d'intégration", () => {
  it("R4 — L1 attend l'intégration pendant que L2 écrit : 1 file annoncée (L2), pas 2 ; au tour de L1 elle repart", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    const queue = mutexFor(`integrate:${gitCommonDir(join(parent, 'a'))}`);
    let turn: (() => void) | undefined;
    let l2Started = false;
    let seen: number | undefined;
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        if (lot === 'L1') {
          await wait(() => l2Started);
          turn = (await queue.acquire())!; // un autre lot intègre : L1 attendra son tour à l'intégration
        } else {
          l2Started = true;
          await wait(() => liveWaves(cadenceHome())[0]?.lanes === 1);
          seen = liveWaves(cadenceHome())[0]?.lanes;
          turn?.(); // le tour de L1 vient
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '3'], f);
    expect(r.code).toBe(0);
    expect(seen).toBe(1);
  });

  it("R5 — un lot neuf démarre pendant une intégration du même dépôt : son écriture de plan passe devant les intégrations en file, il ne reste pas sans session derrière elles", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }, { title: 'trois' }]);
    const queue = mutexFor(`integrate:${gitCommonDir(join(parent, 'a'))}`);
    let turn: (() => void) | undefined;
    let l2Started = false;
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        if (lot === 'L1') {
          await wait(() => l2Started);
          turn = (await queue.acquire())!; // un autre lot intègre : L1 attendra son tour à l'intégration
        } else if (lot === 'L2') {
          l2Started = true;
          await wait(() => liveWaves(cadenceHome())[0]?.lanes === 2); // L1 attend son tour (L2 et L3 restent à jouer)
          await sleep(300); // le pool a lancé L3 sur le créneau rendu : son écriture de plan est en file derrière celle de L1
          turn?.();
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', 'a:L3', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    const log = git(join(parent, 'a'), 'log', '--format=%s', 'main').split('\n').reverse();
    const planL3 = log.findIndex((m) => m.startsWith('plan:') && m.includes('L3') && m.includes('démarré'));
    expect(planL3).toBeGreaterThan(-1);
    expect(planL3).toBeLessThan(log.findIndex((m) => m.includes('feat(L1)'))); // le plan de L3 est écrit avant l'intégration de L1, en file depuis plus longtemps
  });
});
