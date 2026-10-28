import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Dépôt dont la porte ajoute une ligne à `mark` à chaque commande jouée (hors de la copie jetable, qui est retirée) : un fichier vide prouve que rien n'a tourné. */
let mark = '';
const BUILD = () => `echo build >> ${mark}`;
const TESTS = () => `echo tests >> ${mark}`;
function project(): { repo: string; sha: string } {
  const repo = gitRepo();
  mark = join(tempDir(), 'ran.log');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: ${BUILD()}\n  test: ${TESTS()}\nverify:\n  inPlace: false\n`);
  writeFileSync(join(repo, 'valeur.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

type Runs = NonNullable<LotState['checks']>['runs'];
const green = (): Runs => [{ label: 'build', command: BUILD(), code: 0 }, { label: 'tests', command: TESTS(), code: 0 }];

/** Une vague dans `launch` dont le lot L9 du dépôt a enregistré ses contrôles au `head` donné. */
function wave(launch: string, repo: string, checks: LotState['checks'], id = '2026-10-28-0830'): void {
  const store = RunStore.reserve(launch, id)!;
  store.writeWave({ created: '2026-10-28T08:30:00.000Z', lots: ['p:L9'] } as never);
  const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
  store.writeLot({ ...l, status: 'ready', checks });
}

async function gate(repo: string, sha: string, launch: string) {
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], out: (l) => lines.push(l) });
  return { code, text: lines.join('\n'), lines };
}

const treeOf = (repo: string, sha: string) => git(repo, 'rev-parse', `${sha}^{tree}`);
const ran = () => existsSync(mark);

describe('L397 — verify --gate reprend la porte enregistrée par la vague', () => {
  it('R1 — même sha et même arbre, build et tests verts enregistrés : rien n\'est rejoué, code 0, la sortie dit la vague et le lot', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: treeOf(repo, sha), runs: green() });
    const r = await gate(repo, sha, launch);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('verdict repris');
    expect(r.lines[0]).toContain('2026-10-28-0830');
    expect(r.lines[0]).toContain('L9');
    expect(r.text).toContain(`✓ build (${BUILD()})`);
    expect(r.text).toContain(`✓ tests (${TESTS()})`);
    expect(r.lines.at(-1)).toContain('vert');
    expect(ran()).toBe(false);
  });

  it('R2 — le sha n\'est pas celui qui a été contrôlé (intégration, rebase) : la porte est rejouée et la sortie le dit', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: treeOf(repo, sha), runs: green() });
    writeFileSync(join(repo, 'valeur.txt'), 'v2\n');
    git(repo, 'commit', '-qam', 'suite');
    const next = git(repo, 'rev-parse', 'HEAD');
    const r = await gate(repo, next, launch);
    expect(r.code).toBe(0);
    expect(r.text).toContain('rejoué');
    expect(r.text).toContain('aucune porte de vague enregistrée');
    expect(r.text).not.toContain('verdict repris');
    expect(ran()).toBe(true);
  });

  it('R3 — aucune vague (ni dossier d\'état) : la porte est rejouée, comme avant', async () => {
    const { repo, sha } = project();
    const r = await gate(repo, sha, tempDir());
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('porte jouée');
    expect(r.text).toContain('rejoué : aucune porte de vague enregistrée');
  });

  it('R4 — l\'arbre enregistré n\'est pas celui du sha, ou n\'est pas enregistré : rejouée', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: '0'.repeat(40), runs: green() });
    expect((await gate(repo, sha, launch)).text).toContain('arbre différent');
    const other = tempDir();
    wave(other, repo, { head: sha, runs: green() } as never);
    const r = await gate(repo, sha, other);
    expect(r.text).toContain('arbre non enregistré');
    expect(r.text).not.toContain('verdict repris');
  });

  it('R5 — l\'enregistrement ne couvre pas la porte actuelle (commande changée, build absent, étape rouge) : rejouée', async () => {
    const { repo, sha } = project();
    const tree = treeOf(repo, sha);
    for (const [runs, why] of [
      [[{ label: 'build', command: BUILD(), code: 0 }, { label: 'tests', command: 'npx vitest run', code: 0 }], 'commande'],
      [[{ label: 'tests', command: TESTS(), code: 0 }], 'build'],
      [[{ label: 'build', command: BUILD(), code: 0 }, { label: 'tests', command: TESTS(), code: 1 }], 'rouge'],
    ] as [Runs, string][]) {
      const launch = tempDir();
      wave(launch, repo, { head: sha, tree, runs });
      const r = await gate(repo, sha, launch);
      expect(r.text, why).toContain('rejoué');
      expect(r.text, why).not.toContain('verdict repris');
    }
  });

  it('R6 — le dépôt d\'un autre projet ne fournit pas de verdict', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, tempDir(), { head: sha, tree: treeOf(repo, sha), runs: green() });
    expect((await gate(repo, sha, launch)).text).toContain('aucune porte de vague enregistrée');
  });

  it('R7 — des tests instables enregistrés sont dits dans la ligne reprise', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: treeOf(repo, sha), runs: [green()[0], { ...green()[1], instables: ['test/a.test.ts > x'] }] });
    const r = await gate(repo, sha, launch);
    expect(r.code).toBe(0);
    expect(r.text).toContain('1 test(s) instable(s) sous charge');
  });

  it('R8 — la commande lit l\'état de la vague du dossier d\'où elle est lancée', async () => {
    const { repo, sha } = project();
    wave(repo, repo, { head: sha, tree: treeOf(repo, sha), runs: green() });
    const lines: string[] = [];
    const code = await run(['verify', '--gate', '--sha', sha], { cwd: repo, env: {}, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date('2026-10-28T12:00:00') });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('verdict repris');
  });
});
