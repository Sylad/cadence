import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { run } from '../src/cli.js';
import { waveLaunchDirs } from '../src/gate-record.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

describe('L652 — waveLaunchDirs : le dossier courant, la racine du dépôt et leurs ancêtres', () => {
  it('cwd = repo : la liste commence par le dépôt, finit à la racine du disque, sans doublon', () => {
    const repo = tempDir();
    const dirs = waveLaunchDirs(repo, repo);
    expect(dirs[0]).toBe(resolve(repo));
    expect(dirs[dirs.length - 1]).toBe(resolve(sep));
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).toContain(dirname(dirname(repo)));
  });

  it('cwd sous le dépôt : cwd en premier, puis le dépôt, tous les ancêtres une seule fois', () => {
    const repo = tempDir();
    const cwd = join(repo, 'a', 'b');
    const dirs = waveLaunchDirs(cwd, repo);
    expect(dirs.slice(0, 4)).toEqual([cwd, join(repo, 'a'), repo, dirname(repo)]);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('cwd hors du dépôt (autre branche de l\'arbre) : les ancêtres des deux sont présents', () => {
    const a = tempDir();
    const b = tempDir();
    const dirs = waveLaunchDirs(a, b);
    for (const d of [a, b, dirname(a), dirname(b), resolve(sep)]) expect(dirs).toContain(d);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('chemin relatif et barre finale : normalisés en absolus', () => {
    const repo = tempDir();
    const dirs = waveLaunchDirs(`${repo}${sep}`, repo);
    expect(dirs.every((d) => d === resolve(d))).toBe(true);
    expect(dirs[0]).toBe(resolve(repo));
    expect(waveLaunchDirs('.', '.')[0]).toBe(resolve('.'));
  });

  it('la racine du disque comme dossier : une seule entrée, pas de boucle', () => {
    expect(waveLaunchDirs(resolve(sep), resolve(sep))).toEqual([resolve(sep)]);
  });
});

describe('L652 — verify --gate lit une vague lancée à N niveaux au-dessus', () => {
  const BUILD = (mark: string) => `echo build >> ${mark}`;
  const TESTS = (mark: string) => `echo tests >> ${mark}`;

  async function scenario(depth: number, cwdInside: boolean) {
    let launch = tempDir();
    let parent = launch;
    for (let i = 0; i < depth; i++) {
      parent = join(parent, `n${i}`);
      mkdirSync(parent);
    }
    const repo = gitRepo(parent);
    const mark = join(tempDir(), 'ran.log');
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: ${BUILD(mark)}\n  test: ${TESTS(mark)}\nverify:\n  inPlace: false\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const runs: NonNullable<LotState['checks']>['runs'] = [{ label: 'build', command: BUILD(mark), code: 0 }, { label: 'tests', command: TESTS(mark), code: 0 }];
    const store = RunStore.reserve(launch, '2026-11-06-0900')!;
    store.writeWave({ created: '2026-11-06T09:00:00.000Z', lots: ['p:L9'] } as never);
    const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
    store.writeLot({ ...l, status: 'ready', checks: { head: sha, tree: git(repo, 'rev-parse', `${sha}^{tree}`), runs } });
    let cwd = repo;
    if (cwdInside) {
      cwd = join(repo, 'sub');
      mkdirSync(cwd);
    }
    const lines: string[] = [];
    const code = await run(['verify', '--gate', '--sha', sha], { cwd, env: {}, out: (x: string) => lines.push(x), err: (x: string) => lines.push(x), now: () => new Date('2026-11-06T12:00:00') });
    return { code, text: lines.join('\n'), ran: existsSync(mark) };
  }

  for (const depth of [3, 4]) {
    it(`vague ${depth} niveaux au-dessus du dépôt : verdict repris, rien rejoué`, async () => {
      const r = await scenario(depth, false);
      expect(r.text).toContain('verdict repris');
      expect(r.text).not.toContain('aucune porte de vague enregistrée');
      expect(r.ran).toBe(false);
      expect(r.code).toBe(0);
    });
  }

  it('lancé depuis un sous-dossier du dépôt, vague deux niveaux au-dessus : verdict repris', async () => {
    const r = await scenario(2, true);
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
    expect(r.code).toBe(0);
  });
});
