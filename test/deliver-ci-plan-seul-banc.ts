import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliverConfig, DeliverDeps, GhRun } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, sharedStateDir as stateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

// Banc d'essai partagé des tests deliver-ci-plan-seul*.test.ts : un seul endroit à suivre quand DeliverDeps ou DeliverCtx changent.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Dépôt poussé, plan « demo » avec un lot L1, un cadence.yaml, et une première livraison déjà journalisée. */
export async function livre(): Promise<string> {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-09-28');
  plan.add('Cache', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  appendDelivery(stateDir(dir), '2026-09-28', headSha(dir)!);
  return dir;
}

/** Un commit qui ne touche que le plan. */
export function planCommit(dir: string, title: string): void {
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.add(title, '2026-09-28');
  plan.save();
  git(dir, 'add', '.cadence/raf.yaml');
  commit(dir, `chore(plan): ${title}`);
  git(dir, 'push', '-q');
}

export function sourceCommit(dir: string, subject = 'feat: source'): void {
  writeFileSync(join(dir, 'src.txt'), `${subject}\n`);
  git(dir, 'add', 'src.txt');
  commit(dir, subject);
  git(dir, 'push', '-q');
}

export interface Harness {
  deps: DeliverDeps;
  execs: string[];
  ghCalls: string[];
  clock: () => number;
}

export function fakeDeps(start: number, over: Partial<DeliverDeps> & { runs?: GhRun[]; deployMs?: number; exit?: (cmd: string) => number } = {}): Harness {
  let clock = start;
  const execs: string[] = [];
  const ghCalls: string[] = [];
  const { runs, deployMs = 0, exit, ...rest } = over;
  const deps: DeliverDeps = {
    exec: (cmd) => {
      execs.push(cmd);
      if (cmd.startsWith('echo')) clock += deployMs;
      return exit ? exit(cmd) : 0;
    },
    gh: (sha) => {
      ghCalls.push(sha);
      return runs ?? [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    },
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...rest,
  };
  return { deps, execs, ghCalls, clock: () => clock };
}

export function ctx(dir: string, config: DeliverConfig, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    c: {
      root: dir,
      state: stateDir(dir),
      plan: 'plan' in over ? (over.plan as Plan | null) : Plan.load(join(dir, '.cadence/raf.yaml')),
      config,
      today: '2026-09-28',
      dryRun: false,
      args: [] as string[],
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      ...over,
    },
    out,
    err,
  };
}
