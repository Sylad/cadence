import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const PLAN = '.cadence/raf.yaml';

interface Opts {
  files?: Record<string, string>;
  gateYaml?: string;
  replay?: boolean;
  recordedCode?: number;
  planCommits?: number;
  /** Fichier non-plan ajouté dans le commit du dessus (commit mixte). */
  mixed?: boolean;
}

async function play(o: Opts) {
  const repo = gitRepo();
  const mark = join(tempDir(), 'ran.log');
  const replay = o.replay === false ? '' : `  testReplay: printf '%s\\n' replay {files} >> ${mark}; exit 0\n`;
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: echo build >> ${mark}\n  test: echo tests >> ${mark}\n${replay}${o.gateYaml ?? ''}verify:\n  inPlace: false\n`);
  for (const [p, c] of Object.entries(o.files ?? {})) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const launch = tempDir();
  const store = RunStore.reserve(launch, '2026-11-03-0830')!;
  store.writeWave({ created: '2026-11-03T08:30:00.000Z', lots: ['p:L9'] } as never);
  const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
  const checks: LotState['checks'] = { head: sha, tree: git(repo, 'rev-parse', `${sha}^{tree}`), runs: [{ label: 'build', command: `echo build >> ${mark}`, code: o.recordedCode ?? 0 }, { label: 'tests', command: `echo tests >> ${mark}`, code: o.recordedCode ?? 0 }] };
  store.writeLot({ ...l, status: 'ready', checks });
  for (let i = 0; i < (o.planCommits ?? 1); i++) {
    mkdirSync(join(repo, '.cadence'), { recursive: true });
    appendFileSync(join(repo, PLAN), `raf done ${i}\n`);
    git(repo, 'add', PLAN);
    if (o.mixed && i === (o.planCommits ?? 1) - 1) { writeFileSync(join(repo, 'autre.txt'), 'x'); git(repo, 'add', 'autre.txt'); }
    git(repo, 'commit', '-qm', `raf done ${i}`);
  }
  const top = git(repo, 'rev-parse', 'HEAD');
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha: top, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile: PLAN, out: (x) => lines.push(x) });
  return { code, text: lines.join('\n'), log: existsSync(mark) ? readFileSync(mark, 'utf8') : '' };
}

const READER = { 'test/plan-page.test.ts': `readFileSync('${PLAN}')\n` };

describe('L566 probe — bords du rejeu restreint sous commit de plan', () => {
  it('P1 — deux commits de plan empilés : le verdict de dessous est traversé, seul le lecteur est rejoué', async () => {
    const r = await play({ files: READER, planCommits: 2 });
    expect(r.log).toBe('replay\ntest/plan-page.test.ts\n');
  });

  it('P2 — commit du dessus qui touche aussi un autre fichier que le plan : rien n\'est repris, porte entière', async () => {
    const r = await play({ files: READER, mixed: true });
    expect(r.log).toBe('build\ntests\n');
    expect(r.text).not.toContain('verdict repris');
  });

  it('P3 — la porte du dessous est rouge : rien n\'est repris, la porte entière est rejouée', async () => {
    const r = await play({ files: READER, recordedCode: 1 });
    expect(r.log).toBe('build\ntests\n');
    expect(r.text).not.toContain('verdict repris');
  });

  it('P4 — readsPlan: [] (liste vide) : refusé à la lecture de cadence.yaml', async () => {
    await expect(play({ files: READER, gateYaml: '  gate:\n    readsPlan: []\n' })).rejects.toThrow(/readsPlan/);
  });

  it('P5 — readsPlan: false : la détection reste active, le test est rejoué seul', async () => {
    const r = await play({ files: READER, gateYaml: '  gate:\n    readsPlan: false\n' });
    expect(r.log).toBe('replay\ntest/plan-page.test.ts\n');
  });

  it('P6 — aucun fichier ne cite le plan, readsPlan absent : verdict du dessous traversé comme avant (L397), rien rejoué', async () => {
    const r = await play({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    expect(r.log).toBe('');
    expect(r.code).toBe(0);
  });

  it('P7 — readsPlan liste + src qui cite le plan : la déclaration prime, seuls les fichiers déclarés sont rejoués', async () => {
    const r = await play({ files: { 'src/lit.ts': `'${PLAN}'\n` }, gateYaml: '  gate:\n    readsPlan: [test/x.test.ts]\n' });
    expect(r.log).toBe('replay\ntest/x.test.ts\n');
  });

  it('P8 — chemin déclaré avec $ et ; : cité pour le shell, aucune injection', async () => {
    const r = await play({ gateYaml: "  gate:\n    readsPlan: [\"test/a;touch pwn$(id).test.ts\"]\n" });
    expect(r.log).toBe('replay\ntest/a;touch pwn$(id).test.ts\n');
  });

  it('P9 — test lecteur sous un dossier à majuscules (Test/) : détecté comme test, rejoué seul', async () => {
    const r = await play({ files: { 'Test/Plan.Test.ts': `'${PLAN}'\n` } });
    expect(r.log).toBe('replay\nTest/Plan.Test.ts\n');
  });

  it('P10 — fichier de test au nom à espace qui cite le plan (détecté, pas déclaré) : cité pour le shell', async () => {
    const r = await play({ files: { 'test/mon test.test.ts': `'${PLAN}'\n` } });
    expect(r.log).toBe('replay\ntest/mon test.test.ts\n');
  });

  it('P11 — script sous scripts/ qui cite le plan avec readsPlan: true déclaré : porte entière par prudence', async () => {
    const r = await play({ files: { 'scripts/x.sh': `cat ${PLAN}\n` }, gateYaml: '  gate:\n    readsPlan: true\n' });
    expect(r.log).toBe('build\ntests\n');
  });

  it('P12 — plan cité seulement dans un .md et un docs/ : ignoré, verdict traversé', async () => {
    const r = await play({ files: { 'README.md': `${PLAN}\n`, 'docs/a.txt': `${PLAN}\n` } });
    expect(r.log).toBe('');
  });
});
