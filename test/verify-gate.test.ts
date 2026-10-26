import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Dépôt dont `.gitignore` écarte node_modules et .venv, avec une dépendance présente dans l'arbre principal seulement. */
function project(yaml: string): { repo: string; sha: string } {
  const repo = gitRepo();
  writeFileSync(join(repo, 'cadence.yaml'), yaml);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv/\n');
  writeFileSync(join(repo, 'valeur.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x');
  mkdirSync(join(repo, '.venv'));
  return { repo, sha: git(repo, 'rev-parse', 'HEAD').trim() };
}

async function gate(repo: string, sha: string) {
  const lines: string[] = [];
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const leftovers = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

describe('orchestrate.worktreeDeps (L348)', () => {
  it('liste de chemins relatifs, lue dans cadence.yaml', () => {
    const { repo } = project('orchestrate:\n  worktreeDeps: [node_modules, .venv, front/node_modules]\n');
    expect(readOrchestrateConfig(join(repo, 'cadence.yaml')).worktreeDeps).toEqual(['node_modules', '.venv', 'front/node_modules']);
  });

  it.each([['absolu', '[/usr/lib]'], ['qui sort du dépôt', '[../autre]'], ['vide', "['']"], ['pas une liste', 'node_modules']])('refuse un chemin %s', (_, v) => {
    const { repo } = project(`orchestrate:\n  worktreeDeps: ${v}\n`);
    expect(() => readOrchestrateConfig(join(repo, 'cadence.yaml'))).toThrow(/worktreeDeps/);
  });
});

describe('verifyGate : la porte rejouée au sha dans un worktree jetable (L348)', () => {
  it('les dépendances non suivies sont liées depuis l\'arbre principal : vert', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js && test -d .venv\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('vert');
  });

  it('worktreeDeps déclarée : seules ces dépendances sont liées', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules]\n  test: test -f node_modules/dep/index.js && test ! -e .venv\n');
    expect((await gate(repo, sha)).code).toBe(0);
  });

  it('une dépendance déclarée mais absente de l\'arbre principal est dite, sans arrêter la porte', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules, vendor]\n  test: test -f node_modules/dep/index.js\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('vendor');
  });

  it('rejoue au sha demandé, pas à la tête ni dans l\'arbre principal', async () => {
    const { repo, sha } = project('orchestrate:\n  test: grep -q v1 valeur.txt\n');
    writeFileSync(join(repo, 'valeur.txt'), 'v2\n');
    git(repo, 'commit', '-q', '-a', '-m', 'v2');
    expect((await gate(repo, sha)).code).toBe(0);
    expect((await gate(repo, git(repo, 'rev-parse', 'HEAD').trim())).code).toBe(1);
  });

  it('rouge : nomme les suites en échec et sort 1', async () => {
    const { repo, sha } = project(`orchestrate:\n  test: "printf ' FAIL  test/a.test.ts > une règle\\\\n FAIL  test/b.test.ts > une autre\\\\n'; exit 1"\n`);
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('rouge');
    expect(r.text).toContain('test/a.test.ts > une règle');
    expect(r.text).toContain('test/b.test.ts > une autre');
  });

  it('rouge sans test identifiable : dit le code de sortie et la fin de la sortie', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "echo boom; exit 3"\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('code 3');
    expect(r.text).toContain('boom');
  });

  it('le build passe avant les tests, comme dans la porte de la vague, et les deux sont rejoués même si le premier est rouge', async () => {
    const { repo, sha } = project('orchestrate:\n  build: "touch dist-ok; exit 1"\n  test: test -f dist-ok\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('✗ build');
    expect(r.text).toContain('✓ tests');
  });

  it('retire le worktree, vert ou rouge', async () => {
    const green = project('orchestrate:\n  test: "true"\n');
    await gate(green.repo, green.sha);
    expect(leftovers(green.repo)).toBe(1);
    const red = project('orchestrate:\n  test: "false"\n');
    await gate(red.repo, red.sha);
    expect(leftovers(red.repo)).toBe(1);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('cadence-verify-')).length).toBe(0);
  });

  it('l\'arbre principal de dépendances reste intact après le retrait', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n');
    await gate(repo, sha);
    expect(existsSync(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(repo, '.venv'))).toBe(true);
  });

  it('ni test ni build déclarés : rien à rejouer, code 2', async () => {
    const { repo, sha } = project('orchestrate:\n  worktrees: true\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toContain('orchestrate.test');
  });

  it('un sha inconnu : code 2, aucun worktree laissé', async () => {
    const { repo } = project('orchestrate:\n  test: "true"\n');
    const r = await gate(repo, 'deadbeef'.repeat(5));
    expect(r.code).toBe(2);
    expect(leftovers(repo)).toBe(1);
  });
});

describe('cadence verify --gate (L348)', () => {
  const io = (cwd: string) => {
    const lines: string[] = [];
    return { lines, io: { cwd, env: {}, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date('2026-10-26T12:00:00') } };
  };

  it('--gate --sha rejoue la porte du projet courant', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js\n');
    const c = io(repo);
    expect(await run(['verify', '--gate', '--sha', sha.slice(0, 7)], c.io)).toBe(0);
    expect(c.lines.join('\n')).toContain('vert');
  });

  it('--gate sans --sha est refusé (la tête mouvante d\'une vague n\'est pas un sha à re-vérifier)', async () => {
    const { repo } = project('orchestrate:\n  test: "true"\n');
    const c = io(repo);
    expect(await run(['verify', '--gate'], c.io)).toBe(2);
    expect(c.lines.join('\n')).toContain('--sha');
  });

  it('--project désigne un projet du dossier courant', async () => {
    const parent = gitRepo();
    const sub = join(parent, 'app');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: sub });
    writeFileSync(join(sub, 'cadence.yaml'), 'orchestrate:\n  test: "false"\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 'init');
    const c = io(parent);
    expect(await run(['verify', '--gate', '--project', 'app', '--sha', 'HEAD'], c.io)).toBe(1); // la porte du projet app (test: false), pas celle du dossier courant
    expect(c.lines.join('\n')).toContain('rouge');
  });

  it('--project inconnu : code 2 qui nomme le dossier', async () => {
    const parent = gitRepo();
    const c = io(parent);
    expect(await run(['verify', '--gate', '--project', 'absent', '--sha', 'HEAD'], c.io)).toBe(2);
    expect(c.lines.join('\n')).toContain('absent');
  });

  it('--gate refuse --retry (il ne vaut que pour deliver.verify)', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n');
    const c = io(repo);
    expect(await run(['verify', '--gate', '--sha', sha, '--retry', '5'], c.io)).toBe(2);
  });
});
