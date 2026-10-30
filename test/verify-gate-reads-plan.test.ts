import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const PLAN = '.cadence/raf.yaml';

let mark = '';
const BUILD = () => `echo build >> ${mark}`;
const TESTS = () => `echo tests >> ${mark}`;

/** Dépôt dont la porte écrit dans `mark` à chaque commande jouée, et dont `gateYaml` est la clé `orchestrate.gate` (texte YAML indenté de 2 espaces, ou rien). */
function project(gateYaml = ''): { repo: string; sha: string } {
  const repo = gitRepo();
  mark = join(tempDir(), 'ran.log');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: ${BUILD()}\n  test: ${TESTS()}\n${gateYaml}verify:\n  inPlace: false\n`);
  writeFileSync(join(repo, 'valeur.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

function wave(launch: string, repo: string, head: string): void {
  const store = RunStore.reserve(launch, '2026-10-30-0830')!;
  store.writeWave({ created: '2026-10-30T08:30:00.000Z', lots: ['p:L9'] } as never);
  const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
  const checks: LotState['checks'] = { head, tree: git(repo, 'rev-parse', `${head}^{tree}`), runs: [{ label: 'build', command: BUILD(), code: 0 }, { label: 'tests', command: TESTS(), code: 0 }] };
  store.writeLot({ ...l, status: 'ready', checks });
}

function planCommit(repo: string, msg: string): string {
  mkdirSync(join(repo, '.cadence'), { recursive: true });
  appendFileSync(join(repo, PLAN), `${msg}\n`);
  git(repo, 'add', PLAN);
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

async function gate(repo: string, sha: string, launch: string) {
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile: PLAN, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const cfgOf = (repo: string) => readOrchestrateConfig(join(repo, 'cadence.yaml'));

describe('L450 — la porte reprise sous des commits de plan seuls ne vaut pas quand un test lit le plan', () => {
  it('R1 — orchestrate.gate.readsPlan: true : le commit de plan au-dessus du sha contrôlé ne reprend pas le verdict, la porte est rejouée', async () => {
    const { repo, sha } = project('  gate:\n    readsPlan: true\n');
    const launch = tempDir();
    wave(launch, repo, sha);
    const top = planCommit(repo, 'raf done');
    const r = await gate(repo, top, launch);
    expect(r.text).not.toContain('verdict repris');
    expect(r.text).toContain('verdict rejoué');
    expect(r.text).toContain('orchestrate.gate.readsPlan');
    expect(existsSync(mark)).toBe(true);
  });

  it('R2 — readsPlan : liste de chemins de tests : même effet qu\'un true', async () => {
    const { repo, sha } = project('  gate:\n    readsPlan: [e2e/plan-page.e2e.ts]\n');
    expect(cfgOf(repo).gate).toEqual({ readsPlan: ['e2e/plan-page.e2e.ts'] });
    const launch = tempDir();
    wave(launch, repo, sha);
    const top = planCommit(repo, 'raf done');
    expect((await gate(repo, top, launch)).text).toContain('verdict rejoué');
    expect(existsSync(mark)).toBe(true);
  });

  it('R3 — sans la clé, ou readsPlan: false : un commit de plan seul reprend toujours le verdict (L444)', async () => {
    for (const yaml of ['', '  gate:\n    readsPlan: false\n']) {
      const { repo, sha } = project(yaml);
      const launch = tempDir();
      wave(launch, repo, sha);
      const top = planCommit(repo, 'raf done');
      const r = await gate(repo, top, launch);
      expect(r.text).toContain('verdict repris');
      expect(existsSync(mark)).toBe(false);
    }
  });

  it('R4 — readsPlan déclaré, mais la vague a contrôlé le sha demandé lui-même : verdict repris (aucun commit de plan à traverser)', async () => {
    const { repo, sha } = project('  gate:\n    readsPlan: true\n');
    const launch = tempDir();
    wave(launch, repo, sha);
    const r = await gate(repo, sha, launch);
    expect(r.text).toContain('verdict repris');
    expect(existsSync(mark)).toBe(false);
  });

  it('R5 — valeurs refusées à la lecture de cadence.yaml : liste vide, chemin absolu ou avec « .., texte, clé inconnue sous gate', () => {
    for (const v of ['[]', '[/abs/x.ts]', '[../x.ts]', '["  "]', '[1]', 'oui', '{}']) {
      const { repo } = project(`  gate:\n    readsPlan: ${v}\n`);
      expect(() => cfgOf(repo), v).toThrow(/gate\.readsPlan/);
      rmSync(repo, { recursive: true, force: true });
    }
    const { repo } = project('  gate:\n    lit: true\n');
    expect(() => cfgOf(repo)).toThrow(/gate/);
    const { repo: r2 } = project('  gate: true\n');
    expect(() => cfgOf(r2)).toThrow(/gate/);
  });
});
