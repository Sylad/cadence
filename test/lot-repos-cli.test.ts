import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { resolveLotRepos, repoShas, repoWork } from '../src/repos.js';
import { commit as commitAt, tempDir } from './helpers.js';

/** Commits datés après l'adoption du plan (RAF_TODAY) : les plus anciens ne sont pas comptés. */
const commit = (dir: string, message: string) => commitAt(dir, message, '2026-10-08T10:00:00');

const git = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

async function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-08' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-08T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un projet cadence (lot L1 en cours, qui déclare `repos`) et un dépôt voisin non cadence, frères dans le même dossier. */
async function setup(repos: (neighbour: string) => string[] = (n) => [n]) {
  const parent = tempDir();
  const dir = join(parent, 'projet');
  const neighbour = join(parent, 'voisin');
  for (const d of [dir, neighbour]) {
    mkdirSync(d);
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 't@example.com');
    git(d, 'config', 'user.name', 'T');
    git(d, 'config', 'commit.gpgsign', 'false');
  }
  await raf(dir, 'init', '--no-hook', '--prefix', 'L');
  await raf(dir, 'add', 'Un lot');
  await raf(dir, 'start', 'L1');
  const rel = relative(dir, neighbour);
  const file = join(dir, 'docs/plan/raf.yaml');
  const list = repos(rel).map((r) => JSON.stringify(r)).join(', ');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/- id: L1\n/, `- id: L1\n    repos: [${list}]\n`));
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  return { dir, neighbour, rel };
}

describe('resolveLotRepos', () => {
  it('rend la racine git de chaque dépôt voisin existant, sous le chemin déclaré', async () => {
    const { dir, neighbour, rel } = await setup();
    const r = resolveLotRepos(dir, { repos: [rel] });
    expect(r.problems).toEqual([]);
    expect(r.repos.map((x) => x.rel)).toEqual([rel]);
    expect(r.repos[0].path).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: neighbour, encoding: 'utf8' }).trim());
  });

  it('refuse un dossier introuvable et un dossier qui n\'est pas un dépôt git, chacun nommé', async () => {
    const { dir } = await setup();
    const plain = tempDir();
    const r = resolveLotRepos(dir, { repos: ['../nulle-part', relative(dir, plain)] });
    expect(r.repos).toEqual([]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain('../nulle-part');
    expect(r.problems[0]).toContain('introuvable');
    expect(r.problems[1]).toContain("n'est pas dans un dépôt git");
  });

  it('un doublon, ou le dépôt du projet lui-même, n\'est compté qu\'une fois', async () => {
    const { dir, rel } = await setup();
    const r = resolveLotRepos(dir, { repos: [rel, `${rel}/`, '.', '../projet'] });
    expect(r.problems).toEqual([]);
    expect(r.repos.map((x) => x.rel)).toEqual([rel]);
  });
});

describe('raf commits / raf show : les commits du lot dans les dépôts voisins', () => {
  it('raf commits liste ceux du projet, puis ceux du voisin qui citent le lot (jamais les autres)', async () => {
    const { dir, neighbour, rel } = await setup();
    commit(dir, 'feat(L1): côté projet');
    commit(neighbour, 'fix(L1): côté voisin');
    commit(neighbour, 'chore: sans rapport');
    const r = await raf(dir, 'commits', 'L1');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{7} feat\(L1\): côté projet$/);
    expect(lines[1]).toBe(`dépôt ${rel} :`);
    expect(lines[2]).toMatch(/^ {2}[0-9a-f]{7} fix\(L1\): côté voisin$/);
    expect(lines).toHaveLength(3);
  });

  it('un voisin sans commit du lot le dit ; un voisin introuvable est signalé sans faire échouer la lecture', async () => {
    const { dir, rel } = await setup((n) => [n, '../disparu']);
    commit(dir, 'feat(L1): côté projet');
    const r = await raf(dir, 'commits', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`dépôt ${rel} : aucun commit du lot`);
    expect(r.out).toMatch(/dépôt \.\.\/disparu : introuvable/);
  });

  it('sans clé repos, la sortie est inchangée (aucune ligne « dépôt »)', async () => {
    const { dir } = await setup(() => []);
    commit(dir, 'feat(L1): seul');
    const r = await raf(dir, 'commits', 'L1');
    expect(r.out).not.toContain('dépôt');
    expect(r.out.split('\n')).toHaveLength(1);
  });

  it('raf show les compte aussi', async () => {
    const { dir, neighbour, rel } = await setup();
    commit(neighbour, 'fix(L1): côté voisin');
    const r = await raf(dir, 'show', 'L1');
    expect(r.out).toContain('commits (0) :');
    expect(r.out).toContain(`dépôt ${rel} :`);
    expect(r.out).toMatch(/ {4}[0-9a-f]{7} fix\(L1\): côté voisin/);
  });
});

describe('raf review : le sha lu de chaque dépôt', () => {
  it('le verdict enregistre le dernier commit du lot du projet ET de chaque voisin', async () => {
    const { dir, neighbour, rel } = await setup();
    commit(dir, 'feat(L1): côté projet');
    commit(neighbour, 'fix(L1): premier voisin');
    commit(neighbour, 'fix(L1): dernier voisin');
    commit(neighbour, 'chore: sans rapport');
    const lastNeighbour = git(neighbour, 'rev-parse', 'HEAD~1');
    const r = await raf(dir, 'review', 'L1', 'conforme');
    expect(r.code).toBe(0);
    const review = Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L1').review!;
    expect(review.commit).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(review.repos).toEqual({ [rel]: lastNeighbour });
  });

  it('un voisin sans commit du lot s\'enregistre null', async () => {
    const { dir, rel } = await setup();
    commit(dir, 'feat(L1): côté projet');
    await raf(dir, 'review', 'L1', 'conforme');
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L1').review!.repos).toEqual({ [rel]: null });
  });

  it('un voisin introuvable fait refuser le verdict : on n\'enregistre pas un sha qu\'on n\'a pas lu', async () => {
    const { dir } = await setup((n) => [n, '../disparu']);
    commit(dir, 'feat(L1): côté projet');
    const r = await raf(dir, 'review', 'L1', 'conforme');
    expect(r.code).toBe(2);
    expect(r.err).toContain('../disparu');
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L1').review).toBeUndefined();
  });

  it('sans clé repos, le verdict est celui d\'avant (pas de repos)', async () => {
    const { dir } = await setup(() => []);
    commit(dir, 'feat(L1): seul');
    await raf(dir, 'review', 'L1', 'conforme');
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).lot('L1').review).not.toHaveProperty('repos');
  });
});

describe('repoWork / repoShas', () => {
  it('lisent les commits qui citent le lot selon les références du plan', async () => {
    const { dir, neighbour, rel } = await setup();
    commit(neighbour, 'feat(L1): a');
    commit(neighbour, 'feat(L10): autre lot');
    const plan = Plan.load(join(dir, 'docs/plan/raf.yaml'));
    const { repos } = resolveLotRepos(dir, plan.lot('L1'));
    expect(repoWork(plan, repos[0], 'L1').map((c) => c.subject)).toEqual(['feat(L1): a']);
    expect(repoShas(plan, repos, 'L1')).toEqual({ [rel]: git(neighbour, 'rev-parse', 'HEAD~1') });
  });
});
