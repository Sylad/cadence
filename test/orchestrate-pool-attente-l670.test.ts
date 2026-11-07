import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, git, harness, kindOf, reviewReport, workReport } from './orchestrate-harness.js';

// L670 — une file du pool en attente depuis plus de 10 s (slowMs) dit au journal ce qui la retient : les files qui tiennent les créneaux, la dépendance qui joue, la ressource tenue.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 500 && !f(); i++) await sleep(10);
  expect(f()).toBe(true);
};

/** Trois dépôts (a, b, c), un lot chacun ; la première session du dépôt `held` ne finit que quand `release()` le dit ; le journal de la vague est recueilli. */
function setup(held: string, slowMs = 40) {
  const hs = [harness(), harness(), harness()];
  const logs: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let holdOnce = true;
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind === 'implement' && holdOnce && o.cwd === hs[['a', 'b', 'c'].indexOf(held)].repo) {
      holdOnce = false;
      await gate;
    }
    await new Promise((r) => setImmediate(r));
    if (kind === 'implement') return claudeOut(workReport({ commits: [commitFile(o.cwd, `L1-${Math.random()}.txt`, 'feat(L1): x')] }));
    return claudeOut(reviewReport());
  };
  const wave = { ...hs[0].wave, claude, log: (l: string) => logs.push(l), integrate: { slowMs } };
  const ctxs: LotCtx[] = hs.map((h, i) => ({ ...h.lot('L1'), wave }));
  ctxs[0].lot.project = 'a';
  ctxs[1].lot.project = 'b';
  ctxs[2].lot.project = 'c';
  return { ctxs, hs, logs, release: () => release(), waits: () => logs.filter((l) => l.includes(' · attend ')) };
}

describe('L670 — une file du pool qui attend plus de 10 s dit au journal ce qui la retient', () => {
  it('R7 — les créneaux sont tous tenus : la ligne nomme les files qui les tiennent, une fois, et ce que le lot attend (sa session suivante)', async () => {
    const s = setup('a');
    const fin = runPool([s.ctxs[0], s.ctxs[1]], 1);
    await until(() => s.waits().length > 0);
    await sleep(100);
    expect(s.waits()).toEqual(['b:L1 · attend un créneau de session (1 créneau, tenu par la file a:L1) depuis plus de 0.04 s, pour : sa session suivante']);
    s.release();
    await fin;
    expect(s.ctxs.slice(0, 2).map((c) => c.lot.status)).toEqual(['ready', 'ready']);
  });

  it('R7 — une file qui part avant le délai n\'écrit rien', async () => {
    const s = setup('a', 5_000);
    const fin = runPool([s.ctxs[0], s.ctxs[1]], 2);
    await sleep(20);
    s.release();
    await fin;
    expect(s.waits()).toEqual([]);
  });

  it('R7 — un lot pris par la file des demandes (réponse du lead) qui attend un créneau derrière les files qui jouent : la même ligne, pour ce lot', async () => {
    const s = setup('a');
    let given = false;
    const fin = runPool([s.ctxs[0]], 1, [], () => {}, () => false, {
      pollMs: 5,
      take: () => (given ? [] : ((given = true), [s.ctxs[1]])),
    });
    await until(() => s.waits().length > 0);
    expect(s.waits()[0]).toBe('b:L1 · attend un créneau de session (1 créneau, tenu par la file a:L1) depuis plus de 0.04 s, pour : sa session suivante');
    s.release();
    await fin;
    expect(s.ctxs[1].lot.status).toBe('ready');
  });

  it('R7 — la file d\'un lot dont la dépendance joue encore (groupe en parallèle) : la ligne nomme la dépendance', async () => {
    const s = setup('a');
    s.ctxs[1].lot.project = 'a';
    s.ctxs[1].lot.lot = 'L2';
    s.ctxs[1].lot.dependsOn = ['L1'];
    const fin = runPool([s.ctxs[0], s.ctxs[1]], 2, [], () => {}, () => true);
    await until(() => s.waits().length > 0);
    expect(s.waits()[0]).toBe('a:L2 · attend la fin du lot L1 dont il dépend, qui joue encore depuis plus de 0.04 s, pour : sa session suivante');
    s.release();
    await fin;
  });

  it('R7 — la file d\'un lot qui veut une ressource `uses:` qu\'une file qui joue tient : la ligne nomme la ressource', async () => {
    const s = setup('b');
    for (const h of [s.hs[1], s.hs[2]]) {
      writeFileSync(join(dirname(h.repo), 'cadence.yaml'), 'resources: [cycle-ts]\n');
      const plan = h.plan();
      plan.setUses('L1', ['cycle-ts']);
      plan.save();
      git(h.repo, 'add', '--', '.cadence/raf.yaml');
      git(h.repo, 'commit', '-q', '-m', 'chore: uses');
    }
    const fin = runPool([s.ctxs[1], s.ctxs[2]], 3);
    await until(() => s.waits().length > 0);
    expect(s.waits()[0]).toBe('c:L1 · attend la ressource cycle-ts, tenue par une file qui joue depuis plus de 0.04 s, pour : sa session suivante');
    s.release();
    await fin;
    expect(s.ctxs.slice(1).map((c) => c.lot.status)).toEqual(['ready', 'ready']);
  });
});
