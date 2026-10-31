import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { openPlace } from '../src/orchestrate/gate-place.js';
import type { OrchestrateConfig } from '../src/config.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

afterEach(cleanupTempDirs);

/** cadence lance ssh avec l'environnement du processus : le faux ssh passe en tête du PATH le temps du test. */
let remote: FakeRemote;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  remote = fakeRemote();
  for (const k of ['FAKE_DIR', 'FAKE_REAL_PATH', 'PATH']) process.env[k] = remote.env[k];
});
afterEach(() => {
  process.env = saved;
});

const impl = (file = 'a.txt'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());

const gateHost = { host: 'machine' } as OrchestrateConfig['gate'];

/** Joue le lot L1 avec ces commandes de porte ; rend le contexte, le journal de la vague, le fichier-témoin et les appels. */
async function play(config: Partial<OrchestrateConfig>, script: Parameters<typeof harness>[0] = {}, setup?: (mark: string) => void) {
  const h = harness({ script: { implement: [impl()], review: [ok], ...script.script }, ...script });
  const mark = join(tempDir(), 'ran.log');
  setup?.(mark);
  const journal: string[] = [];
  h.wave.log = (l) => journal.push(l);
  const cfg = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('{MARK}', mark) : v]));
  const ctx = h.lot('L1', {}, cfg as Partial<OrchestrateConfig>);
  await runLot(ctx);
  const marks = existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean) : [];
  return { h, ctx, journal, marks, mark };
}

const TESTS = 'echo "tests $(pwd)" >> {MARK}';
const remoteDir = (h: { repo: string }) => `${remote.home}/.cadence-gate/${h.repo.split('/').pop()}/wt/`;

describe('L403 — la porte d\'un lot sur l\'hôte (C2)', () => {
  it('R7 — worktree propre : porte sur l\'hôte au HEAD du lot', async () => {
    const r = await play({ test: TESTS, gate: gateHost });
    expect(r.ctx.lot.status).toBe('ready');
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0]).toContain(remoteDir(r.h));
    expect(r.ctx.lot.checks?.runs[0].lieu).toMatch(/^hôte machine, sha [0-9a-f]{7}, /);
    expect(r.journal.some((l) => l.includes('porte du lot L1 : porte jouée sur l\'hôte machine'))).toBe(true);
  });

  it('R1 — gate.host absent : aucune commande ssh lancée et aucun lieu dans l\'état du lot', async () => {
    const r = await play({ test: TESTS });
    expect(remote.commands()).toEqual([]);
    expect(r.marks[0]).not.toContain('.cadence-gate');
    expect(r.ctx.lot.checks?.runs[0]).not.toHaveProperty('lieu');
    expect(r.journal.some((l) => l.includes('porte du lot'))).toBe(false);
  });

  it('R7 — worktree sale : porte locale et raison dite', async () => {
    // Le cycle écarte lui-même un dépôt sale après une session (« dépôt sale après implement ») : la règle est tenue par le lieu de la porte, jouée ici sur un worktree salé à la main.
    const h = harness();
    writeFileSync(join(h.repo, 'brouillon.txt'), 'pas validé\n');
    const said: string[] = [];
    const ran: string[] = [];
    const place = await openPlace({ config: { gate: gateHost } as OrchestrateConfig, repo: h.repo, sha: git(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: true, label: 'porte du lot L1', local: async (c) => (ran.push(c), { code: 0, output: '' }), say: (l) => said.push(l) });
    await place.run('npm test');
    expect(said).toEqual(['porte du lot L1 : worktree non validé, jouée en local (l\'hôte ne verrait pas les modifications)']);
    expect(ran).toEqual(['npm test']);
    expect(place.where()).toBeUndefined();
    expect(remote.commands()).toEqual([]);
  });

  it('R4 — hôte injoignable : porte locale pour ce lot, dite, sans arrêter la vague', async () => {
    remote.down();
    const r = await play({ test: TESTS, gate: gateHost });
    expect(r.ctx.lot.status).toBe('ready');
    expect(r.journal.some((l) => /porte du lot L1 : porte déportée indisponible sur machine \(.*Connection refused\) — jouée en local/.test(l))).toBe(true);
    expect(r.marks[0]).not.toContain('.cadence-gate');
  });

  it('R8 — rouge sur l\'hôte (code 1) : compté comme un rouge local, correction, aucun repli', async () => {
    const fixIt: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'fixed.txt', 'fix(L1): fixed')] }));
    const r = await play({ test: 'test -f fixed.txt && ' + TESTS, gate: gateHost }, { script: { implement: [impl()], fix: [fixIt], review: [ok] } });
    expect(r.h.calls.map((c) => c.kind)).toContain('fix');
    expect(r.journal.some((l) => l.includes('connexion perdue'))).toBe(false);
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0]).toContain(remoteDir(r.h));
  });
});

describe('L403 — connexion perdue pendant la porte d\'une vague (R6, C2)', () => {
  it('R6 — vague, 255 sur la commande de porte du lot : rejeu local, dit dans la sortie et le journal de la vague, aucun rouge compté', async () => {
    remote.lose('export CADENCE_TEST_WORKERS');
    const r = await play({ test: TESTS, gate: gateHost });
    expect(r.ctx.lot.status).toBe('ready');
    expect(r.h.calls.map((c) => c.kind)).not.toContain('fix');
    expect(r.journal.some((l) => l.includes('porte du lot L1 : connexion perdue avec machine pendant la porte — rejouée en local'))).toBe(true);
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0]).not.toContain('.cadence-gate');
    expect(r.ctx.lot.checks?.runs[0]).toMatchObject({ label: 'tests', code: 0 });
    expect(r.ctx.lot.checks?.runs[0].lieu).toContain('local (connexion perdue avec machine)');
  });

  const FAILING = `echo "tests $(pwd)" >> {MARK}; echo ' FAIL  a.test.ts > suite > cas'; exit 1`;

  it('R6 — vague, 255 pendant la ligne de base : rejeu local de la ligne de base, aucun rouge compté', async () => {
    // 1er appel de commande : le test du lot (rouge sur l'hôte) ; 2e : la ligne de base, dont la connexion tombe.
    remote.loseNth('export CADENCE_TEST_WORKERS', 2);
    const r = await play({ test: FAILING, gate: gateHost });
    expect(r.journal.some((l) => /porte du lot L1 : connexion perdue avec machine pendant la porte — rejouée en local \(ligne de base [0-9a-f]{7}\)/.test(l))).toBe(true);
    // Rouge au départ aussi : le test déjà rouge n'est pas un défaut du lot, et le 255 n'en a pas fait un rouge de plus.
    expect(r.h.calls.map((c) => c.kind)).not.toContain('fix');
    expect(r.ctx.lot.checks?.runs[0].dejaRouges).toBe(1);
    expect(r.marks.some((m) => !m.includes('.cadence-gate'))).toBe(true);
  });

  it('R6 — vague, 255 pendant le rejeu seul : rejeu local du rejeu, aucun test compté rouge ni instable', async () => {
    // Le test du lot passe seul (le rejeu sort en 0) : le verdict vient du rejeu joué en local, pas du 255.
    const config = { test: `echo "tests $(pwd)" >> {MARK}; test -f fixed.txt || { echo ' FAIL  a.test.ts > suite > cas'; exit 1; }`, testReplay: 'echo ran {files}', gate: gateHost };
    const sans = await play({ ...config, gate: undefined });
    remote.loseNth('export CADENCE_TEST_WORKERS', 4);
    const avec = await play(config);
    expect(avec.journal.some((l) => l.includes('connexion perdue avec machine pendant la porte — rejouée en local'))).toBe(true);
    // Même constat qu'une porte entièrement locale : le 255 n'a ni rougi ni excusé un test.
    expect(avec.ctx.lot.status).toBe(sans.ctx.lot.status);
    expect(avec.ctx.lot.instables ?? []).toEqual(sans.ctx.lot.instables ?? []);
    expect(avec.h.calls.map((c) => c.kind)).toEqual(sans.h.calls.map((c) => c.kind));
  });
});
