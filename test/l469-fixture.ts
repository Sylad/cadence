import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deliver, parseDeliverConfig, type DeliverCtx, type DeliverDeps } from '../src/deliver.js';
import { Plan, type PlanSettings } from '../src/plan.js';
import { sharedStateDir } from '../src/state.js';
import { commit, tempDir } from './helpers.js';

export const DAY = '2026-10-09';
export const sh = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
export const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

export const STATES: PlanSettings = {
  states: { states: { a_faire: 'todo', en_cours: 'doing', termine: 'done', livre: 'done', autre: 'done' }, done: 'termine', delivered: 'livre' },
};

export interface Fx {
  dir: string;
  planFile: string;
  settings: PlanSettings;
  yaml: string;
  out: string[];
  err: string[];
  state: string;
}

/** Dépôt poussé : plan natif de trois lots (L1, L2, L3 en cours), cadence.yaml, une première livraison verte à jouer (`first`). */
export function fx(o: { settings?: PlanSettings; blocks?: boolean; yaml?: string; prelude?: (plan: Plan) => void } = {}): Fx {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = join(tempDir(), 'demo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.x');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.fileMode', 'false');
  const planFile = join(dir, '.cadence/raf.yaml');
  const plan = Plan.create(planFile, 'demo', 'L', '2026-10-01');
  for (const t of ['Alertes', 'Carte', 'Fonds']) plan.add(t, '2026-10-01');
  for (const id of ['L1', 'L2', 'L3']) plan.setStatus(id, 'doing', '2026-10-02');
  plan.save();
  o.prelude?.(Plan.load(planFile, o.settings));
  const yaml = o.yaml ?? `deliver:\n  ci: none\n  verify:\n    - command: "true"\n${o.blocks ? '  blocks:\n    api: [src/api]\n    web: [src/web/]\n' : ''}`;
  write(dir, 'cadence.yaml', yaml);
  write(dir, 'README.md', 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, planFile, settings: o.settings ?? {}, yaml, out: [], err: [], state: sharedStateDir(dir) };
}

/** Modifie le plan, le commite (commit « plan seul ») et le pousse. */
export function edit(f: Fx, fn: (plan: Plan) => void, push = true): void {
  const plan = Plan.load(f.planFile, f.settings);
  fn(plan);
  plan.save();
  git(f.dir, 'add', '-A', '.cadence');
  commit(f.dir, 'plan: maj');
  if (push) git(f.dir, 'push', '-q');
}

/** Un commit de travail qui touche `files`, cité par `subject`, poussé. */
export function ship(f: Fx, files: string[], subject: string): void {
  for (const file of files) write(f.dir, file, `${subject}\n${Math.random()}`);
  git(f.dir, 'add', '--', ...files);
  commit(f.dir, subject);
  git(f.dir, 'push', '-q');
}

export const noDeps = (exec: DeliverDeps['exec'] = () => 0): DeliverDeps => ({ exec, gh: () => [], ghReady: () => null, fetch: async () => ({ status: 200, text: 'ok' }), sleep: async () => {}, now: () => 0 });

/** Joue `cadence deliver` (HEAD) sur le dépôt ; rend le code de sortie. */
export function go(f: Fx, o: { block?: string; dryRun?: boolean; exec?: DeliverDeps['exec']; config?: string; settings?: PlanSettings } = {}): Promise<number> {
  const config = parseDeliverConfig(o.config ?? f.yaml, 'cadence.yaml');
  const ctx: DeliverCtx = {
    root: f.dir,
    state: f.state,
    plan: Plan.load(f.planFile, o.settings ?? f.settings),
    config,
    today: DAY,
    dryRun: !!o.dryRun,
    args: [],
    ...(o.block === undefined ? {} : { block: o.block }),
    out: (l) => f.out.push(l),
    err: (l) => f.err.push(l),
  };
  return deliver(ctx, noDeps(o.exec));
}

export const planOf = (f: Fx, settings?: PlanSettings) => Plan.load(f.planFile, settings ?? f.settings);
export const head = (f: Fx) => sh(f.dir, 'rev-parse', 'HEAD');
