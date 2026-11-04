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
  /** Trois dépôts, un lot chacun ; la session `implement` de L1 du dépôt a tient jusqu'à `freeA`. */
  function pool() {
    const hs = [harness(), harness(), harness()];
    const started: string[] = [];
    let freeA!: () => void;
    const hold = new Promise<void>((r) => (freeA = r));
    const claude = async (args: string[], o: { cwd: string }) => {
      const kind = kindOf(args);
      const lot = o.cwd;
      started.push(`${lot}:${kind}`);
      if (kind === 'implement') {
        if (lot === hs[0].lot('L1').lot.repo) await hold;
        return claudeOut(workReport({ commits: [commitFile(o.cwd, `x-${Math.random()}.txt`, 'feat(L1): x')] }));
      }
      return claudeOut(reviewReport());
    };
    const wave = { ...hs[0].wave, claude } as LotCtx['wave'];
    const ctxs: LotCtx[] = hs.map((h, i) => {
      const c = { ...h.lot('L1'), wave } as LotCtx;
      c.lot.project = ['a', 'b', 'c'][i];
      return c;
    });
    return { ctxs, started, freeA, hs };
  }

  it("R2 — avec un seul créneau, le lot en attente de son tour laisse partir la file suivante, sans attendre sa fin", async () => {
    const s = pool();
    const [a, b] = s.ctxs;
    const done = runPool(s.ctxs, 1);
    await wait(() => s.started.length > 0); // a joue, b attend un créneau
    expect(s.started.some((x) => x.startsWith(b.lot.repo))).toBe(false);
    a.waitsTurn = true;
    a.turnChanged?.();
    await wait(() => s.started.some((x) => x.startsWith(b.lot.repo)));
    expect(a.lot.status).not.toBe('ready'); // a n'a pas fini : b est parti pendant son attente
    a.waitsTurn = false;
    s.freeA();
    await done;
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready', 'ready']);
  });

  it("R3 — le lot qui reprend son tour compte de nouveau : un créneau seul ne repart pas pour une troisième file tant que a et b jouent", async () => {
    const s = pool();
    const [a, , c] = s.ctxs;
    const done = runPool(s.ctxs, 1);
    await wait(() => s.started.length > 0);
    a.waitsTurn = true;
    a.turnChanged?.();
    await wait(() => s.started.some((x) => x.startsWith(s.ctxs[1].lot.repo)));
    a.waitsTurn = false;
    a.turnChanged?.();
    await sleep(60);
    // a joue encore (tenue) : c, troisième file, ne part pas avec 1 créneau déjà occupé par a
    expect(s.started.some((x) => x.startsWith(c.lot.repo) && x.endsWith('implement')) && s.ctxs[1].lot.status !== 'ready').toBe(false);
    s.freeA();
    await done;
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
});
