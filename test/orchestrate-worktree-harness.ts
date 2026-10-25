import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import type { ClaudeFn, LaunchOutcome } from '../src/orchestrate/launch.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, briefOf, reviewReport, workReport } from './orchestrate-harness.js';
import { existsSync } from 'node:fs';
import { tempDir } from './helpers.js';

// L279 — doublures communes aux tests e2e des worktrees de lot : vrais dépôts git, sessions simulées.
export const WAVE = '2026-10-04-1412';
export type Kind = 'implement' | 'review' | 'fix' | 'review-small' | 'ux' | 'spec' | 'fiche';
export type Handler = (cwd: string, brief: string, args: string[]) => LaunchOutcome | Promise<LaunchOutcome>;

export interface LotSpec {
  title: string;
  estimate?: number;
  after?: string[];
  visible?: boolean;
  /** Lot sans écran à fiche back (`spec: true`). */
  spec?: boolean;
  /** Dépôts voisins (clé de lot `repos:`), chemins relatifs au dépôt du projet. */
  repos?: string[];
  /** Sous-tâches du lot (`L1/t1`…). */
  tasks?: string[];
}

/** Un dépôt `a` sous un dossier de lancement, des lots, un cadence.yaml (worktrees par défaut). */
export function setup(lots: LotSpec[] = [{ title: 'un' }, { title: 'deux' }], yaml = 'worktrees: true\n', files: Record<string, string> = {}) {
  const parent = tempDir();
  const repo = join(parent, 'a');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(repo, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const l of lots) {
    const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 0.5, after: l.after, visible: l.visible, spec: l.spec });
    if (l.repos) plan.setRepos(id, l.repos.map((path) => ({ path })));
    for (const t of l.tasks ?? []) plan.addTask(id, t);
  }
  plan.enableReview('2026-09-01');
  plan.save();
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n${yaml.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n')}\n`);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, f), text);
  git(repo, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml', 'base.txt', ...Object.keys(files));
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

/** `env` : variables en plus (ou `undefined` pour en retirer une). */
export function run(parent: string, argv: string[], f: ReturnType<typeof fake>, extra: Partial<OrchestrateDeps> = {}, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: parent, env: Object.fromEntries(Object.entries({ RAF_TODAY: '2026-10-04', ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: f.claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, ...extra };
  return orchestrate(argv, io, deps).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

export const branches = (repo: string) => git(repo, 'branch', '--list', 'cadence/*');
export const store = (parent: string) => new RunStore(parent, WAVE);
export const subjects = (repo: string) => git(repo, 'log', '--format=%s', 'main').split('\n');
export const inWorktree = (cwd: string) => cwd.includes('/worktrees/');
export const planOf = (repo: string) => Plan.load(join(repo, '.cadence/raf.yaml'));

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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend (au plus 5 s) qu'une condition soit vraie. */
export async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !cond(); i++) await sleep(20);
}

/** Une implémentation qui commite `shared.txt` avec le contenu de son lot ; L1 attend que L2 se soit intégré (le fichier est dans le dépôt du lead) : L1 rebase en conflit. */
export const sharedFile = (repo: string): Handler => async (cwd, brief) => {
  const lot = lotOf(brief);
  if (lot === 'L1') await until(() => existsSync(join(repo, 'shared.txt')));
  writeFileSync(join(cwd, 'shared.txt'), `contenu de ${lot}\n`);
  git(cwd, 'add', '--', 'shared.txt');
  git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
  return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
};

/** Deux lots modifient le même fichier : L2 s'intègre, L1 est rendu pour conflit à l'étape d'intégration, son worktree conservé. */
export async function conflictWave() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({ implement: sharedFile(repo) });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  return { parent, repo, f, r, dir: join(store(parent).dir, 'worktrees', 'a--L1'), branch: `cadence/${WAVE}/a--L1` };
}

/** Un dépôt voisin (non cadence) à côté du projet `a`, avec un commit. */
export function neighbour(parent: string, name = 'voisin'): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '--', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * Un projet dont le plan est tenu par un autre outil (lecture seule pour raf, R21) : `start.sh` et `verdict.sh` écrivent dans le fichier du plan et notent, dans
 * `$TOOL_LOG` (hors du dépôt), le dossier où ils ont été lancés et leurs arguments.
 */
export function setupForeign(titles = ['un', 'deux']) {
  const parent = tempDir();
  const repo = join(parent, 'a');
  mkdirSync(join(repo, 'docs/plan'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'docs/plan/taches.yaml'), `taches:\n${titles.map((t, i) => `- id: T${i + 1}\n  titre: ${t}\n  etat: prevu\n  effort: S\n`).join('')}`);
  writeFileSync(join(repo, 'start.sh'), 'echo "start $1 $(pwd)" >> "$TOOL_LOG"\nsed -i "/^- id: $1\$/,/^- id/ s/etat: prevu/etat: en_cours/" docs/plan/taches.yaml\n');
  writeFileSync(join(repo, 'verdict.sh'), 'echo "verdict $1 $(pwd) :: $2" >> "$TOOL_LOG"\necho "# verdict $1" >> docs/plan/taches.yaml\n');
  writeFileSync(join(repo, 'cadence.yaml'), 'plan:\n  path: docs/plan/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, estimate: effort }\n  statuses: { todo: prevu, doing: en_cours, done: deploye }\n  estimates: { S: 0.5 }\norchestrate:\n  precheck: false\n  worktrees: true\n  start: sh start.sh {lot}\n  verdict: sh verdict.sh {lot} "{verdict}"\n');
  git(repo, 'add', '--', 'docs/plan/taches.yaml', 'start.sh', 'verdict.sh', 'cadence.yaml');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return { parent, repo };
}
