import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const PLAN = '.cadence/raf.yaml';

function project(files: Record<string, string>, gateYaml = ''): { repo: string; sha: string; mark: string } {
  const repo = gitRepo();
  const mark = join(tempDir(), 'ran.log');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: echo build >> ${mark}\n  test: echo tests >> ${mark}\n${gateYaml}verify:\n  inPlace: false\n`);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD'), mark };
}

function wave(launch: string, repo: string, head: string, mark: string): void {
  const store = RunStore.reserve(launch, '2026-10-30-0830')!;
  store.writeWave({ created: '2026-10-30T08:30:00.000Z', lots: ['p:L9'] } as never);
  const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
  const checks: LotState['checks'] = { head, tree: git(repo, 'rev-parse', `${head}^{tree}`), runs: [{ label: 'build', command: `echo build >> ${mark}`, code: 0 }, { label: 'tests', command: `echo tests >> ${mark}`, code: 0 }] };
  store.writeLot({ ...l, status: 'ready', checks });
}

function planCommit(repo: string): string {
  mkdirSync(join(repo, '.cadence'), { recursive: true });
  appendFileSync(join(repo, PLAN), 'raf done\n');
  git(repo, 'add', PLAN);
  git(repo, 'commit', '-qm', 'raf done');
  return git(repo, 'rev-parse', 'HEAD');
}

async function gate(files: Record<string, string>, opts: { hops?: number; planFile?: string | undefined; atRecorded?: boolean; gateYaml?: string } = {}) {
  const { repo, sha, mark } = project(files, opts.gateYaml);
  const launch = tempDir();
  wave(launch, repo, sha, mark);
  let top = sha;
  if (!opts.atRecorded) for (let i = 0; i < (opts.hops ?? 1); i++) top = planCommit(repo);
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const planFile = 'planFile' in opts ? opts.planFile : PLAN;
  await verifyGate({ repo, sha: top, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile, out: (l) => lines.push(l) });
  return { text: lines.join('\n'), ran: existsSync(mark) };
}

describe('L482 — bords de la détection du plan cité', () => {
  it.each([
    ['docs/guide.json', 'docs'],
    ['.cadence/notes.json', '.cadence'],
    ['CHANGELOG', 'CHANGELOG'],
  ])('E0 — %s cite le plan : exclu (%s), verdict repris', async (file) => {
    const r = await gate({ [file]: `'${PLAN}'\n` });
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
  });

  it('E0 — cadence.yaml qui cite le plan en commentaire : exclu, verdict repris', async () => {
    const r = await gate({}, { gateYaml: `# le plan est ${PLAN}\n` });
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
  });

  it('E1 — un lecteur dans docsite/ (préfixe de « docs » seulement) compte : porte rejouée', async () => {
    const r = await gate({ 'docsite/p.test.ts': `'${PLAN}'\n` });
    expect(r.text).toContain('verdict rejoué');
    expect(r.text).toContain('docsite/p.test.ts');
  });

  it('E2 — un lecteur nommé CHANGELOGGER.ts (pas le journal) compte : porte rejouée', async () => {
    const r = await gate({ 'CHANGELOGGER.ts': `'${PLAN}'\n` });
    expect(r.text).toContain('verdict rejoué');
  });

  it('E3 — un lecteur dans src/CHANGELOGS/x.ts compte : porte rejouée', async () => {
    const r = await gate({ 'src/CHANGELOGS/x.ts': `'${PLAN}'\n` });
    expect(r.text).toContain('verdict rejoué');
  });

  it('E4 — plus de trois lecteurs : trois nommés puis « … »', async () => {
    const files: Record<string, string> = {};
    for (const n of ['a', 'b', 'c', 'd', 'e']) files[`t/${n}.ts`] = `'${PLAN}'\n`;
    const r = await gate(files);
    expect(r.text).toContain('t/a.ts, t/b.ts, t/c.ts, …');
    expect(r.text).not.toContain('t/d.ts');
  });

  it('E5 — deux commits de plan empilés au-dessus : porte rejouée aussi', async () => {
    const r = await gate({ 'e2e/p.ts': `'${PLAN}'\n` }, { hops: 2 });
    expect(r.text).toContain('verdict rejoué');
    expect(r.ran).toBe(true);
  });

  it('E6 — le sha enregistré lui-même (aucun commit de plan) avec un lecteur : verdict repris', async () => {
    const r = await gate({ 'e2e/p.ts': `'${PLAN}'\n` }, { atRecorded: true });
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
  });

  it('E7 — planFile absent (undefined) avec un lecteur : aucune note « readsPlan absent », pas d\'erreur', async () => {
    const r = await gate({ 'e2e/p.ts': `'${PLAN}'\n` }, { planFile: undefined });
    expect(r.text).not.toContain('readsPlan absent');
  });

  it('E8 — planFile vide (\'\') : pas de note, pas d\'erreur', async () => {
    const r = await gate({ 'e2e/p.ts': `'${PLAN}'\n` }, { planFile: '' });
    expect(r.text).not.toContain('readsPlan absent');
  });

  it('E9 — un lecteur binaire citant le plan est ignoré : verdict repris', async () => {
    const r = await gate({ 'bin/x.dat': `\0\0${PLAN}\0\n` });
    expect(r.text).toContain('verdict repris');
  });

  it('E10 — un lecteur au nom non ASCII est nommé lisiblement (sans guillemets ni octaux)', async () => {
    const r = await gate({ 'tests/tést.ts': `'${PLAN}'\n` });
    expect(r.text).toContain('tests/tést.ts');
    expect(r.text).not.toContain('\\303');
  });

  it('E11 — un lecteur dont le nom contient « : » est nommé en entier', async () => {
    const r = await gate({ 'tests/a:b.ts': `'${PLAN}'\n` });
    expect(r.text).toContain('tests/a:b.ts');
  });

  it('E12 — un plan au chemin avec espace et crochets est cherché littéralement', async () => {
    const plan = 'plans/mon plan [1].yaml';
    const r = await gate({ 'e2e/p.ts': `'${plan}'\n` }, { planFile: plan });
    expect(r.text).toContain('verdict rejoué');
    expect(r.text).toContain('e2e/p.ts');
  });

  it('E13 — un lecteur dans .github/workflows (YAML) compte : porte rejouée', async () => {
    const r = await gate({ '.github/workflows/ci.yml': `run: cat ${PLAN}\n` });
    expect(r.text).toContain('verdict rejoué');
  });
});
