import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verdictFor } from '../src/gate-verdict.js';
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

describe('L444 — le commit de plan au-dessus du sha contrôlé reprend la porte de ce sha', () => {
  const PLAN = '.cadence/raf.yaml';
  const planCommit = (repo: string, msg: string): string => {
    mkdirSync(join(repo, '.cadence'), { recursive: true });
    appendFileSync(join(repo, PLAN), `${msg}\n`);
    git(repo, 'add', PLAN);
    git(repo, 'commit', '-qm', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const gateWithPlan = async (repo: string, sha: string, launch: string, planFile: string | undefined) => {
    const lines: string[] = [];
    const cfg = join(repo, 'cadence.yaml');
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile, out: (l) => lines.push(l) });
    return { code, text: lines.join('\n'), lines };
  };

  it('R1 — un ou deux commits qui ne changent que le plan au-dessus du sha contrôlé : verdict repris, rien rejoué, la sortie nomme le sha contrôlé', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: treeOf(repo, sha), runs: green() });
    planCommit(repo, 'revue enregistrée');
    const top = planCommit(repo, 'raf done');
    const r = await gateWithPlan(repo, top, launch, PLAN);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('verdict repris');
    expect(r.lines[0]).toContain(sha.slice(0, 7));
    expect(ran()).toBe(false);
    expect(verdictFor(repo, top)?.code).toBe(0);
  });

  it('R2 — un commit qui touche aussi un autre fichier, ou sans le plan connu : la porte est rejouée', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: treeOf(repo, sha), runs: green() });
    const onlyPlan = planCommit(repo, 'raf done');
    expect((await gateWithPlan(repo, onlyPlan, launch, undefined)).text).toContain('aucune porte de vague enregistrée');
    expect(ran()).toBe(true);
    rmSync(mark);
    appendFileSync(join(repo, PLAN), 'plus\n');
    writeFileSync(join(repo, 'valeur.txt'), 'v2\n');
    git(repo, 'add', PLAN, 'valeur.txt');
    git(repo, 'commit', '-qm', 'mixte');
    const mixed = git(repo, 'rev-parse', 'HEAD');
    const r = await gateWithPlan(repo, mixed, launch, PLAN);
    expect(r.text).toContain('aucune porte de vague enregistrée');
    expect(r.text).not.toContain('verdict repris');
    expect(ran()).toBe(true);
  });

  it('R3 — le sha contrôlé a un arbre différent de l\'enregistrement : le commit de plan au-dessus ne le sauve pas', async () => {
    const { repo, sha } = project();
    const launch = tempDir();
    wave(launch, repo, { head: sha, tree: '0'.repeat(40), runs: green() });
    const top = planCommit(repo, 'raf done');
    const r = await gateWithPlan(repo, top, launch, PLAN);
    expect(r.text).toContain('arbre différent');
    expect(r.text).not.toContain('verdict repris');
  });

  it('R4 — la commande cadence verify --gate --sha HEAD lit le plan du projet et reprend la porte sous le commit de plan', async () => {
    const { repo } = project();
    mkdirSync(join(repo, '.cadence'), { recursive: true });
    writeFileSync(join(repo, PLAN), 'project: p\nlots: []\n');
    git(repo, 'add', PLAN);
    git(repo, 'commit', '-qm', 'plan initial');
    const checked = git(repo, 'rev-parse', 'HEAD');
    wave(repo, repo, { head: checked, tree: treeOf(repo, checked), runs: green() });
    planCommit(repo, 'raf done');
    const lines: string[] = [];
    const code = await run(['verify', '--gate', '--sha', 'HEAD'], { cwd: repo, env: {}, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date('2026-10-28T12:00:00') });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('verdict repris');
  });
});
