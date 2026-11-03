import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cadenceHome, freeSlots, liveWaves } from '../src/orchestrate/registry.js';
import { claudeOut, commitFile, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, run, setup, store } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L520 — un lot qui attend une dépendance, ou qui est dans la porte de tests (pas de session claude), ne tient pas de créneau de session.
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
const lanes = () => liveWaves(cadenceHome())[0]?.lanes;
const writes = (cwd: string, lot: string) => claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));

describe('L520 — les créneaux libres ne comptent que les lots qui tiennent une session', () => {
  it("R1 — L2 attend L1 (dépendance) : pendant que L1 joue, le registre annonce 1 file (L1), pas 2 ; 2 créneaux libres sur 3", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux', after: ['L1'] }]);
    const seen: Record<string, number | undefined> = {};
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        seen[lot] = lanes();
        if (lot === 'L1') expect(freeSlots(liveWaves(cadenceHome()), 3)).toBe(2);
        return writes(cwd, lot);
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '3'], f);
    expect(r.code).toBe(0);
    expect(seen).toEqual({ L1: 1, L2: 1 }); // L2 joue seul une fois L1 prêt
  });

  it("R2 — le lot L1 dans sa porte de tests ne tient pas de créneau : pendant que L2 écrit, 1 file (L2), pas 2 ; la porte finie, L1 reprend son créneau pour sa revue (2)", async () => {
    const go = join(tempDir(), 'go');
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': `while [ ! -f ${go} ]; do sleep 0.02; done\n` });
    let l1Reviewing = false;
    let inGate: number | undefined;
    let inReview: number | undefined;
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        if (lot === 'L2') {
          await wait(() => !!store(parent).readLot('a', 'L1')?.gate);
          inGate = lanes();
          writeFileSync(go, 'ok');
          await wait(() => l1Reviewing); // L1 revient à une session : L2 écrit encore
        }
        return writes(cwd, lot);
      },
      review: async (_cwd, brief) => {
        if (/Review lot `L1`/.test(brief) && !l1Reviewing) {
          inReview = lanes();
          l1Reviewing = true;
        }
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(inGate).toBe(1);
    expect(inReview).toBe(2);
  });

  it("R3 — une vague sans lot en attente ni en porte annonce toujours un file par lot (L279, L433 inchangés)", async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    const seen: (number | undefined)[] = [];
    let reads = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const timer = setTimeout(release, 10_000);
    const f = fake({
      implement: async (cwd, brief) => {
        seen.push(lanes());
        if (++reads === 2) release();
        await both;
        return writes(cwd, /on lot `([^`]+)`/.exec(brief)![1]);
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    clearTimeout(timer);
    expect(seen).toEqual([2, 2]);
  });
});
