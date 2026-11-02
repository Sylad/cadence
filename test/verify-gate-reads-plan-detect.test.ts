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

/** Dépôt dont la porte écrit dans `mark` ; `files` (chemin → contenu) sont suivis dès le premier commit, `gateYaml` est la clé `orchestrate.gate`. */
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

async function gateAbovePlan(files: Record<string, string>, gateYaml = '') {
  const { repo, sha, mark } = project(files, gateYaml);
  const launch = tempDir();
  wave(launch, repo, sha, mark);
  const top = planCommit(repo);
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  await verifyGate({ repo, sha: top, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile: PLAN, out: (l) => lines.push(l) });
  return { text: lines.join('\n'), ran: existsSync(mark) };
}

describe('L482 — le code du projet cite le plan sans gate.readsPlan : la porte héritée n\'est pas reprise', () => {
  it('R1 — un test qui cite le chemin du plan : le verdict n\'est pas repris sous le commit de plan, la porte est rejouée et la raison nomme le fichier', async () => {
    const r = await gateAbovePlan({ 'e2e/plan-page.e2e.ts': `readFileSync('${PLAN}')\n` });
    expect(r.text).not.toContain('verdict repris');
    expect(r.text).toContain('verdict rejoué');
    expect(r.text).toContain('e2e/plan-page.e2e.ts');
    expect(r.text).toContain('gate.readsPlan absent');
    expect(r.ran).toBe(true);
  });

  it('R2 — un chemin de plan cité seulement dans la documentation, un .md ou le plan lui-même : le verdict est encore repris (L444)', async () => {
    const r = await gateAbovePlan({ 'README.md': `voir ${PLAN}\n`, 'docs/guide.txt': `voir ${PLAN}\n`, [PLAN]: 'lots: []\n' });
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
  });

  it('R3 — aucune source ne cite le plan : verdict repris', async () => {
    const r = await gateAbovePlan({ 'src/a.ts': 'export const a = 1;\n' });
    expect(r.text).toContain('verdict repris');
    expect(r.ran).toBe(false);
  });

  it('R4 — gate.readsPlan déclaré : un seul message, celui de L450, sans « readsPlan absent »', async () => {
    const r = await gateAbovePlan({ 'e2e/p.ts': `'${PLAN}'\n` }, '  gate:\n    readsPlan: true\n');
    expect(r.text).toContain('orchestrate.gate.readsPlan : un test lit le plan');
    expect(r.text).not.toContain('readsPlan absent');
  });

  it('R5 — le chemin du plan avec des caractères spéciaux (point) est cherché tel quel, pas comme un motif', async () => {
    const r = await gateAbovePlan({ 'src/b.ts': "'.cadenceXraf.yaml'\n" });
    expect(r.text).toContain('verdict repris');
  });
});
