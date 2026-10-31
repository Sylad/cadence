import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig, type OrchestrateConfig } from '../src/config.js';
import { verdictFor } from '../src/gate-verdict.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { withPlace } from '../src/orchestrate/gate-place.js';
import { verifyGate } from '../src/verify-gate.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { claudeOut, commitFile, git as hgit, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/* ---------- C1 : verify --gate ---------- */

function project(orchestrate: string) {
  const remote = fakeRemote();
  const mark = join(tempDir(), 'ran.log');
  const repo = join(tempDir(), 'depot');
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n${orchestrate.replaceAll('{MARK}', mark)}verify:\n  inPlace: false\n`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package-lock.json'), '{"v":1}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD'), remote, mark, work: join(remote.home, '.cadence-gate', 'depot') };
}
type Proj = ReturnType<typeof project>;
const marks = (p: Proj) => (existsSync(p.mark) ? readFileSync(p.mark, 'utf8').split('\n').filter(Boolean) : []);
async function gate(p: Proj) {
  const lines: string[] = [];
  const cfg = join(p.repo, 'cadence.yaml');
  const code = await verifyGate({ repo: p.repo, sha: p.sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), env: p.remote.env, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n'), lines };
}
const HOST = '  gate:\n    host: machine\n    install: mkdir -p node_modules\n';

describe('L403 probe — R6 (C1) : bords de la connexion perdue de verify --gate', () => {
  it('R6 — 255 pendant la 2e étape (tests) après un build vert distant : le build n\'est dit qu\'une fois, rejeu local complet', async () => {
    const p = project(`  build: echo "build $(pwd)" >> {MARK}\n  test: echo "tests $(pwd)" >> {MARK}\n${HOST}`);
    // 1er appel de commande de porte = build, 2e = tests.
    p.remote.loseNth('export CADENCE_TEST_WORKERS', 2);
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.startsWith('✓ build'))).toHaveLength(1);
    expect(r.lines.filter((l) => l.startsWith('✓ tests'))).toHaveLength(1);
    expect(r.text).toContain('connexion perdue avec machine pendant la porte — rejouée en local');
    // Le build local a bien été rejoué (le build distant ne vaut pas pour le verdict).
    expect(marks(p).filter((m) => m.startsWith('build')).some((m) => !m.includes('.cadence-gate'))).toBe(true);
    expect(verdictFor(p.repo, p.sha)?.code).toBe(0);
  });

  it('R6 — 255 pendant le rejeu seul d\'un rouge : rejeu local, ni rouge ni instable déduit du 255', async () => {
    const p = project(`  test: sh -c 'test -f fixed.txt || { echo " FAIL  a.test.ts > suite > cas"; exit 1; }'\n  testReplay: echo ran {files}\n${HOST}`);
    // 1: tests (rouge), 2: rejeu seul → perdu.
    p.remote.loseNth('export CADENCE_TEST_WORKERS', 2);
    const r = await gate(p);
    expect(r.text).toContain('connexion perdue avec machine pendant la porte — rejouée en local');
    // Rejoué en local, le même scénario rend le verdict d'une porte locale (tests rouges puis rejeu qui passe = instable → vert).
    const local = project(`  test: sh -c 'test -f fixed.txt || { echo " FAIL  a.test.ts > suite > cas"; exit 1; }'\n  testReplay: echo ran {files}\n`);
    const l = await gate(local);
    expect(r.code).toBe(l.code);
  });

  it('R6 — 255 sur chaque commande successive (hôte instable) : une seule ligne « connexion perdue », verdict local', async () => {
    const p = project(`  build: echo b\n  test: echo t\n${HOST}`);
    p.remote.lose('export CADENCE_TEST_WORKERS');
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.includes('connexion perdue'))).toHaveLength(1);
  });

  it('R6 — 255 puis code 1 local : le rouge local reste rouge (code 1), non confondu avec la perte', async () => {
    const p = project(`  test: echo ' FAIL  a.test.ts > suite > cas'; exit 1\n${HOST}`);
    p.remote.lose('export CADENCE_TEST_WORKERS');
    const r = await gate(p);
    expect(r.code).toBe(1);
    expect(r.text).toContain('rejouée en local');
    expect(verdictFor(p.repo, p.sha)?.code).toBe(1);
  });

  it('R8 — code distant 2 ou 127 ou 130 : rouge, pas de repli', async () => {
    for (const c of [2, 127, 130, 254]) {
      const p = project(`  test: echo "tests $(pwd)" >> {MARK}; exit ${c}\n${HOST}`);
      const r = await gate(p);
      expect(r.code, `exit ${c}`).toBe(1);
      expect(r.text, `exit ${c}`).not.toContain('rejouée en local');
      expect(marks(p), `exit ${c}`).toHaveLength(1);
    }
  });
});

/* ---------- C2 : vague ---------- */

let remote: FakeRemote;
let saved: NodeJS.ProcessEnv;

const impl = (file = 'a.txt'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const gateHost = { host: 'machine' } as OrchestrateConfig['gate'];

async function play(config: Partial<OrchestrateConfig>) {
  const h = harness({ script: { implement: [impl()], review: [ok] } });
  const mark = join(tempDir(), 'ran.log');
  const journal: string[] = [];
  h.wave.log = (l) => journal.push(l);
  const cfg = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('{MARK}', mark) : v]));
  const ctx = h.lot('L1', {}, cfg as Partial<OrchestrateConfig>);
  await runLot(ctx);
  return { h, ctx, journal, marks: existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean) : [] };
}

describe('L403 probe — R6 (C2) : bords de la connexion perdue en vague', () => {
  beforeEach(() => {
    saved = { ...process.env };
    remote = fakeRemote();
    for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  it('R6 — 255 pendant le build du lot : une seule ligne au journal, les tests suivants en local, lieu local sur les deux contrôles', async () => {
    remote.loseNth('export CADENCE_TEST_WORKERS', 1);
    const r = await play({ build: 'echo "build $(pwd)" >> {MARK}', test: 'echo "tests $(pwd)" >> {MARK}', gate: gateHost });
    expect(r.ctx.lot.status).toBe('ready');
    expect(r.journal.filter((l) => l.includes('connexion perdue avec machine'))).toHaveLength(1);
    const runs = r.ctx.lot.checks?.runs ?? [];
    expect(runs.map((x) => x.code)).toEqual([0, 0]);
    for (const run of runs) expect(run.lieu).toContain('local');
    expect(r.marks.every((m) => !m.includes('.cadence-gate'))).toBe(true);
    expect(r.h.calls.map((c) => c.kind)).not.toContain('fix');
  });

  it('R6 — 255 sur toutes les commandes : le lot n\'a aucun constat rouge et aucune correction', async () => {
    remote.lose('export CADENCE_TEST_WORKERS');
    const r = await play({ build: 'echo b', test: 'echo t', gate: gateHost });
    expect(r.ctx.lot.status).toBe('ready');
    expect(r.h.calls.map((c) => c.kind)).not.toContain('fix');
    expect(r.ctx.lot.checks?.runs.every((x) => x.code === 0)).toBe(true);
  });

  it('R8 — code distant 2 (hors 255) en vague : rouge compté, correction demandée, aucun repli', async () => {
    const r = await play({ test: 'echo "tests $(pwd)" >> {MARK}; exit 2', gate: gateHost });
    expect(r.journal.some((l) => l.includes('connexion perdue'))).toBe(false);
    expect(r.ctx.lot.status).not.toBe('ready');
  });

  it('R7 — seul un fichier non suivi : porte locale et raison dite', async () => {
    const h = harness();
    writeFileSync(join(h.repo, 'nouveau.txt'), 'x\n');
    const said: string[] = [];
    await withPlace({ config: { gate: gateHost, test: 'npm test' } as OrchestrateConfig, repo: h.repo, sha: hgit(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: (l) => said.push(l) }, async (place) => {
      await place.run('npm test');
    });
    expect(said).toEqual(['porte du lot L1 : worktree non validé, jouée en local (l\'hôte ne verrait pas les modifications)']);
    expect(remote.commands()).toEqual([]);
  });

  it('R1 — gate.host sans build ni test : aucune sonde ssh', async () => {
    const h = harness();
    await withPlace({ config: { gate: gateHost } as OrchestrateConfig, repo: h.repo, sha: hgit(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: () => {} }, async (place) => {
      expect(place.stamp()).toEqual({});
    });
    expect(remote.commands()).toEqual([]);
  });

  it('R10 — fn qui lève : le worktree de l\'hôte est quand même retiré', async () => {
    const h = harness();
    const said: string[] = [];
    await expect(withPlace({ config: { gate: gateHost, test: 'true' } as OrchestrateConfig, repo: h.repo, sha: hgit(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: false, label: 'porte', local: async () => ({ code: 0, output: '' }), say: (l) => said.push(l) }, async (place) => {
      await place.run('true');
      throw new Error('boum');
    })).rejects.toThrow('boum');
    const wt = join(remote.home, '.cadence-gate', h.repo.split('/').pop()!, 'wt');
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });

  it('R4 — sha invalide (« HEAD ») donné à withPlace : porte locale dite, aucune commande ssh', async () => {
    const h = harness();
    const said: string[] = [];
    await withPlace({ config: { gate: gateHost, test: 'true' } as OrchestrateConfig, repo: h.repo, sha: 'HEAD', dir: h.repo, needClean: false, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: (l) => said.push(l) }, async (place) => {
      await place.run('true');
    });
    expect(said.join('\n')).toContain('jouée en local');
    expect(remote.commands()).toEqual([]);
  });
});
