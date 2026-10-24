import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import type { ClaudeFn, LaunchOutcome } from '../src/orchestrate/launch.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, briefOf, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

// L279 — doublures communes aux tests e2e des worktrees de lot : vrais dépôts git, sessions simulées.
export const WAVE = '2026-10-04-1412';
export type Kind = 'implement' | 'review' | 'fix' | 'review-small' | 'ux';
export type Handler = (cwd: string, brief: string, args: string[]) => LaunchOutcome | Promise<LaunchOutcome>;

export interface LotSpec {
  title: string;
  estimate?: number;
  after?: string[];
  visible?: boolean;
}

/** Un dépôt `a` sous un dossier de lancement, des lots, un cadence.yaml (worktrees par défaut). */
export function setup(lots: LotSpec[] = [{ title: 'un' }, { title: 'deux' }], yaml = 'worktrees: true\n') {
  const parent = tempDir();
  const repo = join(parent, 'a');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(repo, 'docs/plan/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const l of lots) plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 0.5, after: l.after, visible: l.visible });
  plan.enableReview('2026-09-01');
  plan.save();
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n${yaml.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n')}\n`);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return { parent, repo };
}

export const lotOf = (brief: string) => /(?:on lot|Review lot) `([^`]+)`/.exec(brief)?.[1] ?? /lot `([^`]+)`/.exec(brief)?.[1] ?? '?';

export function fake(over: Partial<Record<Kind, Handler>> = {}) {
  const calls: { cwd: string; kind: string; lot: string; brief: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args) as Kind;
    const brief = briefOf(args);
    const lot = lotOf(brief);
    calls.push({ cwd: o.cwd, kind, lot, brief });
    const custom = over[kind];
    if (custom) return custom(o.cwd, brief, args);
    if (kind === 'implement' || kind === 'fix') return claudeOut(workReport({ commits: [commitFile(o.cwd, `${lot}-${kind}.txt`, `${kind === 'fix' ? 'fix' : 'feat'}(${lot}): travail`)] }));
    return claudeOut(reviewReport());
  };
  return { calls, claude };
}

/** Une implémentation qui commite `<lot>.txt` après un `before` éventuel. */
export const writes = (before: () => Promise<unknown> | unknown = () => {}): Handler => async (cwd, brief) => {
  await before();
  const lot = lotOf(brief);
  return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
};

export function run(parent: string, argv: string[], f: ReturnType<typeof fake>, extra: Partial<OrchestrateDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: f.claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, ...extra };
  return orchestrate(argv, io, deps).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

export const branches = (repo: string) => git(repo, 'branch', '--list', 'cadence/*');
export const store = (parent: string) => new RunStore(parent, WAVE);
export const subjects = (repo: string) => git(repo, 'log', '--format=%s', 'main').split('\n');
export const inWorktree = (cwd: string) => cwd.includes('/worktrees/');
export const planOf = (repo: string) => Plan.load(join(repo, 'docs/plan/raf.yaml'));

/** Rendez-vous : chaque appel attend que `n` appels soient en cours (ou un délai de secours) ; prouve que les sessions se chevauchent. */
export function meeting(n: number, safetyMs = 4000) {
  let waiting = 0;
  let release: () => void = () => {};
  const met = new Promise<void>((r) => (release = r));
  return async () => {
    waiting++;
    if (waiting >= n) release();
    await Promise.race([met, new Promise((r) => setTimeout(r, safetyMs))]);
  };
}
