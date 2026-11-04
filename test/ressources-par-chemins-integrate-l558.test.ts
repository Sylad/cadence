import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { declaredFor } from '../src/resources.js';
import type { LotCtx, WaveCtx } from '../src/orchestrate/cycle.js';
import { awaitOlder, blockingOlder, works } from '../src/orchestrate/cycle/integrate-wait.js';
import { takeRepoWrite } from '../src/orchestrate/integrate.js';
import { conflictNotes } from '../src/orchestrate/lot-diff.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { gitRepo, tempDir } from './helpers.js';

// L558 — ressources par chemins, étape integrate : le lot tardif attend l'ancien qui travaille sur la même ressource (R8, R9, R10), le message de conflit nomme la ressource (R11), un diff illisible n'arrête rien (R12).

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TABLE = 'resources:\n  cycle-ts:\n    paths: [src/orchestrate/cycle.ts, src/orchestrate/cycle/]\n  docs: { paths: [docs/] }\n';
const WAVE = '2026-11-04-0900';
const CYCLE = 'src/orchestrate/cycle.ts';
const SH = 'src/orchestrate/cycle/sh.ts';
const ALL_STATUS: LotState['status'][] = ['queued', 'implementing', 'reviewing', 'fixing', 'question', 'ready', 'handed-back', 'failed', 'suspended'];

function commitFiles(dir: string, lot: string, files: string[]) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), `${Math.random()}\n`);
    git(dir, 'add', '--', f);
    git(dir, 'commit', '-q', '-m', `feat(${lot}): ${f}`);
  }
}

/** Une vague sur le dépôt `a` d'un parent qui déclare la table : `lot()` écrit l'état d'un lot et crée sa branche de worktree avec `files` commités. */
function wave(yaml = TABLE, order = ['a:L1', 'a:L2', 'a:L3']) {
  const parent = tempDir();
  const repo = gitRepo(parent);
  writeFileSync(join(parent, 'cadence.yaml'), yaml);
  mkdirSync(join(repo, 'src/orchestrate'), { recursive: true });
  writeFileSync(join(repo, CYCLE), 'ligne 1\nligne 2\n');
  git(repo, 'add', '--', CYCLE);
  git(repo, 'commit', '-q', '-m', 'chore: base');
  const plan = Plan.create(join(repo, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const t of ['un', 'deux', 'trois']) plan.add(t, '2026-10-01', { estimate: 1 });
  plan.save();
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  const store = new RunStore(parent, WAVE);
  store.writeWave({ id: WAVE, created: '2026-11-04T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.pid, lots: order });
  const log: string[] = [];
  const wctx = { id: WAVE, store, log: (l: string) => log.push(l), integrate: { pollMs: 10, waitMs: 30 } } as unknown as WaveCtx;
  const lot = (id: string, files: string[], over: Partial<LotState> = {}, lotRepo = repo) => {
    const state = newLot({ project: 'a', repo: lotRepo, lot: id, title: id, visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    Object.assign(state, { status: 'implementing' }, over);
    store.writeLot(state);
    const dir = lotTreeDir(store.dir, 'a', id);
    const branch = lotBranch(WAVE, 'a', id);
    expect(prepareTree({ repo: lotRepo, dir, branch, base: 'main', lot: `a:${id}` }).ok).toBe(true);
    commitFiles(dir, id, files);
    const ctx: LotCtx = { wave: wctx, lot: state, config: { ...readOrchestrateConfig('/nope'), precheck: false }, loadPlan: () => Plan.load(join(repo, '.cadence/raf.yaml')), tree: { dir, branch, base: 'main', active: true } };
    return ctx;
  };
  const set = (c: LotCtx, over: Partial<LotState>) => {
    Object.assign(c.lot, over);
    store.writeLot(c.lot);
  };
  return { parent, repo, store, log, lot, set };
}

/** Le tardif L2 à l'étape integrate, avec un commit sur sh.ts (ressource cycle-ts). */
const tardif = (w: ReturnType<typeof wave>, files = [SH]) => w.lot('L2', files, { status: 'reviewing', next: 'integrate' });
const noWarn = () => {};
const DEFERRED = 'a:L2 intégration différée : a:L1 touche la ressource « cycle-ts » (src/orchestrate/cycle.ts)';

/** `awaitOlder` lancé ; `settled()` dit s'il a rendu la main après `ms`. */
async function started(c: LotCtx) {
  let done = false;
  const p = awaitOlder(c).then(() => (done = true));
  const settled = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    return done;
  };
  return { p, settled };
}

describe('R8 — le tardif attend l\'ancien qui travaille sur la même ressource', () => {
  it('R8 — ancien ayant déjà un commit sur cycle.ts, tardif fini en premier : il attend puis s\'intègre', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    const c = tardif(w);
    expect(blockingOlder(c, declaredFor(w.repo), noWarn)).toMatchObject({ lot: { lot: 'L1' }, resource: 'cycle-ts', path: CYCLE });
    const { p, settled } = await started(c);
    expect(await settled(60)).toBe(false);
    w.set(old, { status: 'ready' });
    await p;
    expect(c.lot.status).toBe('reviewing');
  });

  it('R8 — ligne de journal « intégration différée » : lot attendu, ressource et chemin assertés', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    const c = tardif(w);
    const { p, settled } = await started(c);
    expect(await settled(60)).toBe(false);
    w.set(old, { status: 'ready' });
    await p;
    expect(w.log).toEqual([DEFERRED]); // une seule fois malgré plusieurs tours
  });

  it('R8 — ancien sans commit sur la ressource : le tardif s\'intègre sans attendre', async () => {
    const w = wave();
    w.lot('L1', ['README.md']);
    const c = tardif(w);
    expect(blockingOlder(c, declaredFor(w.repo), noWarn)).toBeNull();
    await awaitOlder(c);
    expect(w.log).toEqual([]);
  });

  it('R8 — l\'ancien touche une autre ressource que le tardif : pas d\'attente', () => {
    const w = wave();
    w.lot('L1', ['docs/x.md']);
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R8 — aucun lot plus ancien en jeu : pas d\'attente', async () => {
    const w = wave();
    const c = tardif(w);
    await awaitOlder(c);
    expect(w.log).toEqual([]);
  });

  it.each([
    ['question', false],
    ['suspended', false],
    ['queued', false],
    ['handed-back', false],
    ['failed', false],
    ['implementing', true],
    ['fixing', true],
    ['reviewing', true],
  ] as [LotState['status'], boolean][])('R8 — ancien %s, avec un commit sur cycle.ts : %s', (status, waits) => {
    const w = wave();
    w.lot('L1', [CYCLE], { status });
    const b = blockingOlder(tardif(w), declaredFor(w.repo), noWarn);
    expect(b !== null).toBe(waits);
  });

  it('R8 — ancien implementing, avec un commit sur cycle.ts : attente puis intégration (le tardif n\'est pas rendu)', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE], { status: 'implementing' });
    const c = tardif(w);
    const { p, settled } = await started(c);
    expect(await settled(40)).toBe(false);
    w.set(old, { status: 'ready' });
    await p;
    expect(c.lot.status).toBe('reviewing');
    expect(c.lot.next).toBe('integrate');
  });

  it('R1 — aucun chemin déclaré : l\'étape integrate ne lit aucun diff d\'un autre lot', async () => {
    const w = wave('resources: [cycle-ts, docs]\n');
    w.lot('L1', [CYCLE]);
    const c = tardif(w);
    let reads = 0;
    expect(blockingOlder(c, declaredFor(w.repo), noWarn, () => (reads++, { files: [CYCLE], failure: null }))).toBeNull();
    expect(reads).toBe(0);
    await awaitOlder(c);
    expect(w.log).toEqual([]);
  });
});

describe('R9 — le contrôle est rejoué à chaque passage, sans borne, sans tenir le verrou', () => {
  it('R9 — ancien repassant à une étape après le premier contrôle : le tardif réévalue', () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE], { status: 'question' });
    const c = tardif(w);
    const declared = declaredFor(w.repo);
    expect(blockingOlder(c, declared, noWarn)).toBeNull();
    w.set(old, { status: 'implementing' });
    expect(blockingOlder(c, declared, noWarn)).not.toBeNull();
  });

  it('R9 — deux lots à integrate sur la même ressource : aucun n\'attend l\'autre, pas d\'interblocage', async () => {
    const w = wave();
    const l1 = w.lot('L1', [CYCLE], { status: 'reviewing', next: 'integrate' });
    const l2 = tardif(w, [CYCLE]);
    await Promise.all([awaitOlder(l1), awaitOlder(l2)]);
    expect(w.log).toEqual([]);
  });

  it('R9 — ancien rendu (handed-back) : le tardif s\'intègre', async () => {
    const w = wave();
    w.lot('L1', [CYCLE], { status: 'handed-back', next: 'integrate' });
    await awaitOlder(tardif(w));
    expect(w.log).toEqual([]);
  });

  it.each(['question', 'suspended', 'handed-back', 'failed'] as LotState['status'][])('R9 — ancien implementing qui passe en %s pendant l\'attente : le tardif s\'intègre au passage suivant', async (status) => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    const { p, settled } = await started(tardif(w));
    expect(await settled(40)).toBe(false);
    w.set(old, { status });
    await p;
    expect(w.log).toEqual([DEFERRED]);
  });

  it('R9 — ancien en attente d\'un créneau, passe fini : le tardif s\'intègre', async () => {
    const w = wave();
    // entre deux étapes : status de la dernière session (reviewing), prochaine étape fix
    const old = w.lot('L1', [CYCLE], { status: 'reviewing', next: 'fix' });
    const { p, settled } = await started(tardif(w));
    expect(await settled(40)).toBe(false);
    w.set(old, { status: 'ready', next: null });
    await p;
  });

  it('R9 — ancien encore en jeu bien après INTEGRATE_WAIT_MS : le tardif attend toujours, n\'est pas rendu', async () => {
    const w = wave(); // integrate.waitMs = 30 ms
    const old = w.lot('L1', [CYCLE]);
    const c = tardif(w);
    const { p, settled } = await started(c);
    expect(await settled(300)).toBe(false);
    expect(c.lot.status).toBe('reviewing');
    expect(w.log.filter((l) => l.includes('handed-back'))).toEqual([]);
    w.set(old, { status: 'ready' });
    await p;
  });

  it('R9 — pendant l\'attente, le verrou d\'intégration du dépôt n\'est pas tenu : un autre lot s\'intègre', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    const { p, settled } = await started(tardif(w));
    expect(await settled(40)).toBe(false);
    const grant = await takeRepoWrite(w.repo, { wave: 'autre' }, { waitMs: 200, pollMs: 10 });
    expect(grant.ok).toBe(true);
    if (grant.ok) grant.release();
    w.set(old, { status: 'ready' });
    await p;
  });
});

describe('R10 — quels lots sont examinés, et lesquels travaillent', () => {
  it('R10 — lot lancé après le tardif, avec un commit sur la même ressource : le tardif n\'attend pas', () => {
    const w = wave();
    w.lot('L3', [CYCLE]);
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R10 — lot d\'une autre vague touchant la ressource : pas d\'attente', () => {
    const w = wave();
    const other = new RunStore(w.parent, '2026-11-04-0800');
    other.writeWave({ id: other.id, created: '2026-11-04T08:00:00Z', cwd: w.parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.pid, lots: ['a:L1'] });
    const state = newLot({ project: 'a', repo: w.repo, lot: 'L1', title: 'L1', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    state.status = 'implementing';
    other.writeLot(state);
    const dir = lotTreeDir(other.dir, 'a', 'L1');
    expect(prepareTree({ repo: w.repo, dir, branch: lotBranch(other.id, 'a', 'L1'), base: 'main', lot: 'a:L1' }).ok).toBe(true);
    commitFiles(dir, 'L1', [CYCLE]);
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R10 — lot d\'un autre dépôt touchant le même chemin : pas d\'attente', () => {
    const w = wave();
    const repo2 = gitRepo(tempDir());
    writeFileSync(join(repo2, 'x.txt'), 'x\n');
    git(repo2, 'add', '--', 'x.txt');
    git(repo2, 'commit', '-q', '-m', 'chore: base');
    w.lot('L1', [CYCLE], {}, repo2);
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R10 — aucun lot plus ancien en jeu : pas d\'attente', () => {
    const w = wave();
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R10 — les 9 valeurs de LotStatus : seules implementing, fixing et reviewing comptent comme « travaille »', () => {
    expect(ALL_STATUS).toHaveLength(9);
    expect(ALL_STATUS.filter((status) => works({ status, next: null }))).toEqual(['implementing', 'reviewing', 'fixing']);
  });

  it('R10 — reviewing avec next integrate : ne travaille pas, n\'est pas attendu', () => {
    expect(works({ status: 'reviewing', next: 'integrate' })).toBe(false);
    const w = wave();
    w.lot('L1', [CYCLE], { status: 'reviewing', next: 'integrate' });
    expect(blockingOlder(tardif(w), declaredFor(w.repo), noWarn)).toBeNull();
  });

  it('R10 — implementing avec next integrate : ne travaille pas (next testé avant le status)', () => {
    expect(works({ status: 'implementing', next: 'integrate' })).toBe(false);
    expect(works({ status: 'fixing', next: 'integrate' })).toBe(false);
  });

  it('R10 — queued : ne travaille pas ; un lot reviewing entre deux étapes (en attente d\'un créneau) : travaille', () => {
    expect(works({ status: 'queued', next: null })).toBe(false);
    expect(works({ status: 'reviewing', next: 'fix' })).toBe(true);
    expect(works({ status: 'implementing', next: 'review' })).toBe(true);
  });

  it('R10 — la liste vient de c.wave.store.lots() relu à chaque passage : un lot passé de question à implementing entre deux passages est vu', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE], { status: 'question' });
    const c = tardif(w);
    expect(blockingOlder(c, declaredFor(w.repo), noWarn)).toBeNull();
    // écrit sur le disque seul, hors de tout objet que le tardif tiendrait
    w.store.writeLot({ ...old.lot, status: 'implementing' });
    expect(blockingOlder(c, declaredFor(w.repo), noWarn)).toMatchObject({ lot: { lot: 'L1', status: 'implementing' } });
  });
});

describe('R12 — un diff illisible à l\'étape integrate : pas d\'attente, un avertissement', () => {
  it('R12 — étape integrate, base de l\'ancien disparue : le tardif s\'intègre sans attendre, sans exception', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    git(w.repo, 'config', '--local', `branch.${old.tree!.branch}.cadence-base`, 'disparue');
    await awaitOlder(tardif(w));
    expect(w.log).toHaveLength(1);
    expect(w.log[0]).toMatch(/^a:L1 diff illisible \(git : .+\) : aucune ressource déduite$/);
  });

  it('R12 — étape integrate, base du tardif disparue : pas d\'attente, le lot s\'intègre', async () => {
    const w = wave();
    w.lot('L1', [CYCLE]);
    const c = tardif(w);
    git(w.repo, 'config', '--local', `branch.${c.tree!.branch}.cadence-base`, 'disparue');
    await awaitOlder(c);
    expect(w.log).toHaveLength(1);
    expect(w.log[0]).toMatch(/^a:L2 diff illisible \(git : .+\) : aucune ressource déduite$/);
  });

  it('R12 — diff illisible : un avertissement journalisé, pas de ligne d\'erreur', async () => {
    const w = wave();
    const old = w.lot('L1', [CYCLE]);
    git(w.repo, 'config', '--local', `branch.${old.tree!.branch}.cadence-base`, 'disparue');
    const c = tardif(w);
    await awaitOlder(c);
    expect(w.log.filter((l) => /→ (failed|handed-back)|erreur/.test(l))).toEqual([]);
    expect(c.lot.status).toBe('reviewing');
  });
});

describe('R11 — le message de conflit nomme la ressource, le fichier et les commits de la base', () => {
  /** Un lot L1 parti de main, puis `n` commits de main sur cycle.ts (et un sur README.md) après son départ. */
  function diverged(n: number) {
    const w = wave();
    const c = w.lot('L1', [CYCLE]);
    const shas: string[] = [];
    for (let i = 1; i <= n; i++) {
      writeFileSync(join(w.repo, CYCLE), `main ${i}\n`);
      git(w.repo, 'commit', '-q', '-am', `feat(L9): main ${i}`);
      shas.push(git(w.repo, 'rev-parse', '--short=7', 'HEAD'));
    }
    writeFileSync(join(w.repo, 'README.md'), 'r\n');
    git(w.repo, 'add', '--', 'README.md');
    git(w.repo, 'commit', '-q', '-m', 'docs: readme');
    return { w, c, shas };
  }

  it('R11 — conflit sur cycle.ts : le message garde le texte d\'avant et nomme cycle-ts, le fichier et le commit de base', () => {
    const { w, c, shas } = diverged(1);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).toBe(` ; ressource « cycle-ts » : ${CYCLE} modifié dans main depuis le départ du lot par ${shas[0]} feat(L9): main 1`);
  });

  it('R11 — deux commits de base sur le fichier : les deux sont listés', () => {
    const { w, c, shas } = diverged(2);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).toBe(` ; ressource « cycle-ts » : ${CYCLE} modifié dans main depuis le départ du lot par ${shas[1]} feat(L9): main 2, ${shas[0]} feat(L9): main 1`);
  });

  it('R11 — quatre commits : trois puis « +1 autre »', () => {
    const { w, c, shas } = diverged(4);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).toBe(` ; ressource « cycle-ts » : ${CYCLE} modifié dans main depuis le départ du lot par ${shas[3]} feat(L9): main 4, ${shas[2]} feat(L9): main 3, ${shas[1]} feat(L9): main 2, +1 autre`);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).not.toContain('autres');
  });

  it('R11 — cinq commits : « +2 autres »', () => {
    const { w, c } = diverged(5);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).toMatch(/, \+2 autres$/);
  });

  it('R11 — conflit sur un fichier hors ressource : message identique à celui d\'avant', () => {
    const { w, c } = diverged(1);
    expect(conflictNotes(c.tree!.dir, 'main', ['README.md'], declaredFor(w.repo))).toBe('');
  });

  it('R11 — conflit sans liste de fichiers : message identique à celui d\'avant', () => {
    const { w, c } = diverged(1);
    expect(conflictNotes(c.tree!.dir, 'main', [], declaredFor(w.repo))).toBe('');
  });

  it('R11 — fichier sous deux ressources : une note par ressource', () => {
    const w = wave('resources:\n  cycle-ts: { paths: [src/orchestrate/cycle.ts] }\n  src: { paths: [src] }\n');
    const c = w.lot('L1', [CYCLE]);
    writeFileSync(join(w.repo, CYCLE), 'main\n');
    git(w.repo, 'commit', '-q', '-am', 'feat(L9): main');
    const notes = conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo));
    expect(notes).toMatch(/^ ; ressource « cycle-ts » : .* ; ressource « src » : /);
  });

  it('R11 — sans ressource à chemins : rien d\'ajouté', () => {
    const w = wave('resources: [cycle-ts]\n');
    const c = w.lot('L1', [CYCLE]);
    expect(conflictNotes(c.tree!.dir, 'main', [CYCLE], declaredFor(w.repo))).toBe('');
  });
});
