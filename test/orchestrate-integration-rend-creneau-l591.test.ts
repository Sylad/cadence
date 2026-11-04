import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { Plan } from '../src/plan.js';
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

describe("L591 — le lot repris à son tour ne redemande pas de créneau, et compte de nouveau", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
  /** Change la ligne `n` de f.txt dans `cwd` et commite ; deux lignes voisines (l4, l7) se rebasent sans conflit mais le contexte de l'une contient l'autre : le patch-id change (R17, revue courte). */
  const edit = (cwd: string, n: number, who: string) => {
    writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${who}\n`));
    git(cwd, 'add', '--', 'f.txt');
    git(cwd, 'commit', '-q', '-m', `feat(${who}): travail`);
    return { sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${who}): travail` };
  };
  /** Un second projet `b`, un lot, sans worktree : juste de quoi tenir un créneau. */
  const projectB = (parent: string) => {
    const dir = join(parent, 'b');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'b', 'L', '2026-09-01');
    plan.add('lot', '2026-10-01', { estimate: 0.5 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 250 && !cond(); i++) await sleep(20);
  };

  it("R6 — a:L1 reprend son tour alors que a:L2 et b:L1 tiennent les 2 créneaux : sa revue courte part sans attendre un créneau", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
    projectB(parent);
    const repoA = join(parent, 'a');
    const queue = mutexFor(`integrate:${gitCommonDir(repoA)}`);
    let turn: (() => void) | undefined;
    let l2Started = false;
    const holding = new Set<string>();
    let smallSaw: string[] | undefined;
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        const project = /on project `([^`]+)`/.exec(brief)?.[1] ?? (cwd.includes('/b') && !cwd.includes('/a') ? 'b' : 'a');
        if (project === 'a' && lot === 'L1') {
          await wait(() => l2Started); // les écritures de plan de a sont passées : la file d'intégration peut être tenue
          turn = (await queue.acquire())!; // « une autre intégration de a est en cours »
          edit(repoA, 7, 'voisin'); // main avance : le rebase change le contexte du diff de L1, une revue courte sera jouée
          return claudeOut(workReport({ commits: [edit(cwd, 4, 'L1')] }));
        }
        const key = `${project}:${lot}`;
        if (key === 'a:L2') l2Started = true;
        holding.add(key);
        if (key === 'b:L1') {
          await sleep(100); // b:L1 est parti sur le créneau rendu par a:L1 ; les deux créneaux sont tenus
          turn?.(); // le tour de a:L1 vient
        }
        await until(() => smallSaw !== undefined); // les deux porteurs gardent leur créneau jusqu'à la revue courte de a:L1 (ou 5 s)
        holding.delete(key);
        return claudeOut(workReport({ commits: [commitFile(cwd, `${key.replace(':', '-')}.txt`, `feat(${lot}): travail`)] }));
      },
      'review-small': async () => {
        smallSaw = [...holding].sort();
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', 'b:L1', '--max-sessions', '2'], f, { slotPollMs: 20 });
    expect(r.code).toBe(0);
    expect(smallSaw).toEqual(['a:L2', 'b:L1']); // la revue courte a joué pendant que les deux créneaux étaient tenus : aucun n'a été redemandé
    expect(r.out).toMatch(/a:L1 · reprend son tour d'intégration sans redemander de créneau/);
    expect(r.out).not.toMatch(/a:L1 · en attente d'un créneau de session/);
  });

  it("R7 — à son tour, integrateLot recompte le lot : pendant sa revue courte, le registre annonce de nouveau sa file (2 avec L2), plus 1", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
    const repoA = join(parent, 'a');
    const queue = mutexFor(`integrate:${gitCommonDir(repoA)}`);
    let turn: (() => void) | undefined;
    let l2Started = false;
    let lanesDuringSmall: number | undefined;
    let waitsTurnSeen = false;
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        if (lot === 'L1') {
          await wait(() => l2Started);
          turn = (await queue.acquire())!;
          edit(repoA, 7, 'voisin');
          return claudeOut(workReport({ commits: [edit(cwd, 4, 'L1')] }));
        }
        l2Started = true;
        await wait(() => liveWaves(cadenceHome())[0]?.lanes === 1); // L1 attend son tour : il ne compte plus
        waitsTurnSeen = true;
        turn?.();
        await until(() => lanesDuringSmall !== undefined); // L2 reste en session pendant la revue courte de L1
        return claudeOut(workReport({ commits: [commitFile(cwd, 'L2.txt', 'feat(L2): travail')] }));
      },
      'review-small': async () => {
        lanesDuringSmall = liveWaves(cadenceHome())[0]?.lanes;
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '3'], f, { slotPollMs: 20 });
    expect(r.code).toBe(0);
    expect(waitsTurnSeen).toBe(true);
    expect(lanesDuringSmall).toBe(2); // L1 repris et L2 : le lot repris a repris sa place
  });
});
