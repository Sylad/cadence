import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { readyFree } from '../src/ready-free.js';
import { declaredFor } from '../src/resources.js';
import { deducedResources, lotDiff } from '../src/orchestrate/lot-diff.js';
import { resourceLock } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore } from '../src/orchestrate/state.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { gitRepo, tempDir } from './helpers.js';

// L558 — ressources par chemins : le diff d'un lot (R6, R12) et les ressources qu'il déduit pour la file (R5, R7) et la ligne des lots prêts libres (R5, A3).

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TABLE = 'resources:\n  cycle-ts:\n    paths: [src/orchestrate/cycle.ts, src/orchestrate/cycle/]\n  banc: {}\n  docs: { paths: [docs/] }\n';
const WAVE = '2026-11-04-0900';

/** Un dépôt sous un parent qui déclare la table, avec un premier commit ; rend le dépôt et une fonction qui crée la branche de lot `L<n>` (worktree) et commite `files` dessus. */
function repoWithTable(yaml = TABLE) {
  const parent = tempDir();
  const repo = gitRepo(parent);
  writeFileSync(join(parent, 'cadence.yaml'), yaml);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '--', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'chore: base');
  const branchOf = (lot: string, project = 'a') => lotBranch(WAVE, project, lot);
  const tree = (lot: string, files: string[] = [], project = 'a') => {
    const dir = join(parent, 'wt', `${project}--${lot}`);
    const made = prepareTree({ repo, dir, branch: branchOf(lot, project), base: 'main', lot: `${project}:${lot}` });
    expect(made.ok).toBe(true);
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), `${Math.random()}\n`);
      git(dir, 'add', '--', f);
      git(dir, 'commit', '-q', '-m', `feat(${lot}): ${f}`);
    }
    return { dir, branch: branchOf(lot, project) };
  };
  return { parent, repo, tree, branchOf };
}

describe('R6 — le diff d\'un lot : les fichiers de ses commits depuis sa base', () => {
  it('R6 — deux commits : les fichiers des deux sont dans le diff', () => {
    const { repo, tree } = repoWithTable();
    const { branch } = tree('L1', ['src/orchestrate/cycle.ts', 'docs/x.md']);
    expect(lotDiff(repo, branch)).toEqual({ files: ['docs/x.md', 'src/orchestrate/cycle.ts'], failure: null });
  });

  it('R6 — renommage de cycle.ts : l\'ancien et le nouveau chemin comptent', () => {
    const { repo, tree } = repoWithTable();
    // le fichier existe sur main avant la branche
    mkdirSync(join(repo, 'src/orchestrate'), { recursive: true });
    writeFileSync(join(repo, 'src/orchestrate/cycle.ts'), 'un contenu assez long pour que git voie un renommage\n');
    git(repo, 'add', '--', 'src/orchestrate/cycle.ts');
    git(repo, 'commit', '-q', '-m', 'chore: cycle');
    const { dir, branch } = tree('L1');
    git(dir, 'mv', 'src/orchestrate/cycle.ts', 'src/orchestrate/cycle2.ts');
    git(dir, 'commit', '-q', '-m', 'feat(L1): renommage');
    expect(lotDiff(repo, branch).files).toEqual(['src/orchestrate/cycle.ts', 'src/orchestrate/cycle2.ts']);
  });

  it('R6 — fichier modifié non commité : absent du diff', () => {
    const { repo, tree } = repoWithTable();
    const { dir, branch } = tree('L1', ['docs/x.md']);
    writeFileSync(join(dir, 'base.txt'), 'modifié\n');
    mkdirSync(join(dir, 'src/orchestrate'), { recursive: true });
    writeFileSync(join(dir, 'src/orchestrate/cycle.ts'), 'neuf\n');
    expect(lotDiff(repo, branch).files).toEqual(['docs/x.md']);
  });

  it('R6 — branche supprimée ou sans cadence-base : diff vide, aucune erreur', () => {
    const { repo, tree, branchOf } = repoWithTable();
    expect(lotDiff(repo, branchOf('L9'))).toEqual({ files: [], failure: null });
    const { dir, branch } = tree('L1', ['docs/x.md']);
    git(repo, 'config', '--local', '--unset', `branch.${branch}.cadence-base`);
    expect(lotDiff(repo, branch)).toEqual({ files: [], failure: null });
    git(repo, 'worktree', 'remove', '--force', dir);
    git(repo, 'branch', '-D', branch);
    expect(lotDiff(repo, branch)).toEqual({ files: [], failure: null });
  });

  it('R6 — lot sans commit : diff vide', () => {
    const { repo, tree } = repoWithTable();
    expect(lotDiff(repo, tree('L1').branch)).toEqual({ files: [], failure: null });
  });
});

describe('R12 — un échec de git en lisant le diff rend un diff vide, avec sa cause', () => {
  it('R12 — branche de base notée dans cadence-base supprimée : resourceLock rend les uses: seuls, sans exception', () => {
    const { repo, tree } = repoWithTable();
    const { branch } = tree('L1', ['src/orchestrate/cycle.ts']);
    git(repo, 'config', '--local', `branch.${branch}.cadence-base`, 'disparue');
    const d = lotDiff(repo, branch);
    expect(d.files).toEqual([]);
    expect(d.failure).toMatch(/disparue|Not a valid|unknown revision/i);
    const causes: string[] = [];
    expect(deducedResources(repo, branch, declaredFor(repo), (c) => causes.push(c))).toEqual([]);
    expect(causes).toHaveLength(1);
  });

  it('R12 — git merge-base ne rend rien : diff vide, aucune erreur', () => {
    const { repo, tree } = repoWithTable();
    const { branch } = tree('L1', ['src/orchestrate/cycle.ts']);
    // une base sans ancêtre commun : merge-base sort en code 1 sans rien écrire
    git(repo, 'checkout', '-q', '--orphan', 'orpheline');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'racine');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'config', '--local', `branch.${branch}.cadence-base`, 'orpheline');
    const d = lotDiff(repo, branch);
    expect(d.files).toEqual([]);
    expect(d.failure).not.toBeNull();
  });

  it('R12 — dépôt illisible : diff vide, aucune exception', () => {
    expect(lotDiff(join(tempDir(), 'nulle-part'), 'cadence/x/a--L1')).toEqual({ files: [], failure: null });
  });

  it('R12 — relecture à chaque appel, sans cache : un commit ajouté après un premier appel est vu', () => {
    const { repo, tree } = repoWithTable();
    const { dir, branch } = tree('L1', ['docs/x.md']);
    const declared = declaredFor(repo);
    expect(deducedResources(repo, branch, declared)).toEqual(['docs']);
    mkdirSync(join(dir, 'src/orchestrate'), { recursive: true });
    writeFileSync(join(dir, 'src/orchestrate/cycle.ts'), 'neuf\n');
    git(dir, 'add', '--', 'src/orchestrate/cycle.ts');
    git(dir, 'commit', '-q', '-m', 'feat(L1): cycle');
    expect(deducedResources(repo, branch, declared)).toEqual(['cycle-ts', 'docs']);
  });
});

/** Un LotCtx minimal pour `resourceLock` : le plan du dépôt (uses:), le worktree du lot et son état. */
function ctxOf(repo: string, lot: string, tree: { dir: string; branch: string } | undefined, status: LotCtx['lot']['status'] = 'implementing'): LotCtx {
  const state = newLot({ project: 'a', repo, lot, title: lot, visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  state.status = status;
  return { lot: state, loadPlan: () => Plan.load(join(repo, '.cadence/raf.yaml')), ...(tree ? { tree: { ...tree, base: 'main', active: true } } : {}) } as LotCtx;
}

/** Le plan du dépôt : L1, L2 (uses: [cycle-ts]), L3 (uses: [banc]), commité. */
function planWithUses(repo: string) {
  const plan = Plan.create(join(repo, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  plan.add('un', '2026-10-01', { estimate: 1 });
  plan.add('deux', '2026-10-01', { estimate: 1, uses: ['cycle-ts'] });
  plan.add('trois', '2026-10-01', { estimate: 1, uses: ['banc'] });
  plan.save();
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
}

describe('R5 / R7 — les ressources tenues par une file qui joue : uses: et diff', () => {
  it('R7 — lot d\'une file qui joue encore, ayant déjà un commit sur cycle.ts : la file voisine qui veut cycle-ts attend', () => {
    const { repo, tree } = repoWithTable();
    planWithUses(repo);
    const l1 = ctxOf(repo, 'L1', tree('L1', ['src/orchestrate/cycle/sh.ts']));
    const l2 = ctxOf(repo, 'L2', undefined, 'queued');
    const l3 = ctxOf(repo, 'L3', undefined, 'queued');
    const lock = resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l1, l2, l3]));
    expect(lock.wants([l2])).toBe(true);
    expect(lock.wants([l3])).toBe(false);
  });

  it('R7 — lot sans commit : aucune ressource déduite, le lot prêt voisin est offert', () => {
    const { repo, tree } = repoWithTable();
    planWithUses(repo);
    const l1 = ctxOf(repo, 'L1', tree('L1'));
    const l2 = ctxOf(repo, 'L2', undefined, 'queued');
    expect(resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l1, l2])).wants([l2])).toBe(false);
  });

  it('R5 — lot « uses: [banc] » sans diff : banc reste tenu', () => {
    const { repo, tree } = repoWithTable();
    planWithUses(repo);
    const l3 = ctxOf(repo, 'L3', tree('L3'));
    const other = ctxOf(repo, 'L3', undefined, 'queued');
    expect(resourceLock(new Map([[Promise.resolve(), [l3]]]), new Set([l3, other])).wants([other])).toBe(true);
  });

  it('R5 — fichier sous deux ressources : les deux sont tenues', () => {
    const { repo, tree } = repoWithTable('resources:\n  cycle-ts: { paths: [src/orchestrate/cycle.ts] }\n  src: { paths: [src] }\n');
    const { branch } = tree('L1', ['src/orchestrate/cycle.ts']);
    expect(deducedResources(repo, branch, declaredFor(repo))).toEqual(['cycle-ts', 'src']);
  });

  it('R5 — lot fini : plus aucune ressource tenue', () => {
    const { repo, tree } = repoWithTable();
    planWithUses(repo);
    const l1 = ctxOf(repo, 'L1', tree('L1', ['src/orchestrate/cycle.ts']), 'ready');
    const l2 = ctxOf(repo, 'L2', undefined, 'queued');
    // une file finie n'est plus dans `live`
    expect(resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l2])).wants([l2])).toBe(false);
  });

  it('R1 — resources en liste de noms : resourceLock ne lit aucun diff (le résultat d\'avant)', () => {
    const { repo, tree } = repoWithTable('resources: [cycle-ts, banc]\n');
    planWithUses(repo);
    const l1 = ctxOf(repo, 'L1', tree('L1', ['src/orchestrate/cycle.ts']));
    const l2 = ctxOf(repo, 'L2', undefined, 'queued');
    expect(resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l1, l2])).wants([l2])).toBe(false);
  });

  it('R12 — un diff illisible : la file ne tient que ses uses:, la cause est rendue une fois par lot', () => {
    const { repo, tree } = repoWithTable();
    planWithUses(repo);
    const t = tree('L1', ['src/orchestrate/cycle.ts']);
    git(repo, 'config', '--local', `branch.${t.branch}.cadence-base`, 'disparue');
    const l1 = ctxOf(repo, 'L1', t);
    const l2 = ctxOf(repo, 'L2', undefined, 'queued');
    const warned: string[] = [];
    const lock = resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l1, l2]), (c, cause) => warned.push(`${c.lot.lot}:${cause}`));
    expect(lock.wants([l2])).toBe(false);
    expect(lock.wants([l2])).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^L1:/);
  });
});

describe('R5 / A3 — la ligne des lots prêts libres voit le diff des lots d\'une vague vivante', () => {
  /** Deux projets alpha (dans la vague, sans uses:) et beta (prêt, uses: [cycle-ts]) sous un parent qui déclare la table. */
  function parentWith() {
    const parent = tempDir();
    writeFileSync(join(parent, 'cadence.yaml'), TABLE);
    const dirs: Record<string, string> = {};
    for (const [name, uses] of [['alpha', undefined], ['beta', ['cycle-ts']]] as const) {
      const dir = join(parent, name);
      mkdirSync(dir, { recursive: true });
      for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(dir, ...a);
      const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
      plan.add('Un', '2026-10-01', { estimate: 1, uses: uses ? [...uses] : undefined });
      plan.save();
      writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
      git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
      git(dir, 'commit', '-q', '-m', 'chore: plan');
      dirs[name] = dir;
    }
    return { parent, dirs };
  }

  /** Une vague vivante sur alpha:L1, avec son worktree et `files` commités dessus. */
  function liveWave(parent: string, alpha: string, files: string[], status: LotCtx['lot']['status'] = 'implementing') {
    const store = RunStore.reserve(parent, WAVE)!;
    store.writeWave({ id: store.id, created: '2026-11-04T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: ['alpha:L1'] });
    const state = newLot({ project: 'alpha', repo: alpha, lot: 'L1', title: 'Un', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    state.status = status;
    store.writeLot(state);
    const dir = lotTreeDir(store.dir, 'alpha', 'L1');
    expect(prepareTree({ repo: alpha, dir, branch: lotBranch(store.id, 'alpha', 'L1'), base: 'main', lot: 'alpha:L1' }).ok).toBe(true);
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x\n');
      git(dir, 'add', '--', f);
      git(dir, 'commit', '-q', '-m', `feat(L1): ${f}`);
    }
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-11-04T09:00:00Z', cwd: parent, repos: [alpha], cap: 2 });
    return { store, dir };
  }

  const freeOf = (parent: string, dirs: Record<string, string>) => [...readyFree([dirs.alpha, dirs.beta], cadenceHome()).entries()].map(([d, lots]) => `${d.slice(parent.length + 1)}:${lots.map((l) => l.id).join(',')}`);

  it('R5 — lot sans uses: dont le diff touche cycle.ts : readyFree n\'offre pas un lot prêt « uses: [cycle-ts] »', () => {
    const { parent, dirs } = parentWith();
    liveWave(parent, dirs.alpha, ['src/orchestrate/cycle.ts']);
    try {
      expect(freeOf(parent, dirs)).toEqual([]);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R7 — lot de la vague sans commit sur la ressource : le lot prêt voisin est offert', () => {
    const { parent, dirs } = parentWith();
    liveWave(parent, dirs.alpha, ['docs/x.md']);
    try {
      expect(freeOf(parent, dirs)).toEqual(['beta:L1']);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R12 — branche de base renommée : readyFree offre le lot voisin et le tour du lead ne plante pas', async () => {
    const { parent, dirs } = parentWith();
    const { store } = liveWave(parent, dirs.alpha, ['src/orchestrate/cycle.ts']);
    git(dirs.alpha, 'config', '--local', `branch.${lotBranch(store.id, 'alpha', 'L1')}.cadence-base`, 'renommee');
    try {
      expect(freeOf(parent, dirs)).toEqual(['beta:L1']);
      const out: string[] = [];
      const code = await run(['lead', 'tour'], { cwd: parent, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-11-04T09:00:00') });
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('tirables, ressources libres : beta:L1 Un (cycle-ts)');
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });
});
