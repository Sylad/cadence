import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { sealAcceptation } from '../src/orchestrate/accept.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type WaveState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { git } from './orchestrate-harness.js';
import { ecritAcceptation } from './accept-helpers.js';
import { gitRepo, tempDir } from './helpers.js';

// L366 : les refus de `spec green` devant une vague (arrêtée ou vivante) parlent de spec green, pas du rescellé.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const WAVE = '2026-10-26-1000';

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt dont L1 (en cours) a une acceptation scellée à vert: false, avec une commande d'acceptation verte. */
function depot() {
  const repo = gitRepo();
  const a = ecritAcceptation(repo);
  sealAcceptation(repo, a.json);
  git(repo, 'add', '--', a.json);
  git(repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', a.json);
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n  accept: "true"\n');
  const paths = ['.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore', 'cadence.yaml'];
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', 'plan: L1', '--', ...paths);
  return { repo, a };
}

/** Une vague dont L1 attend une réponse. */
function vague(repo: string, status: WaveState['status']) {
  const store = RunStore.reserve(repo, WAVE)!;
  store.writeWave({ id: store.id, status, created: 'x', lots: ['ici:L1'] } as never);
  store.writeLot({ ...newLot({ project: 'ici', repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status: 'question' });
}

const vertDe = (repo: string, json: string) => JSON.parse(readFileSync(join(repo, json), 'utf8')).vert;

describe('spec green devant une vague non terminée (L366)', () => {
  it('R6 — vague arrêtée qui garde L1 ouvert : le refus nomme spec green, la vague et la commande de reprise, jamais le rescellé ; rien n\'est changé', () => {
    const { repo, a } = depot();
    vague(repo, 'interrupted');
    const r = cli(repo, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('spec green : refusé');
    expect(r.err).toContain(`vague ${WAVE} (arrêtée, lancée depuis ${repo}) : ici:L1 (question)`);
    expect(r.err).toContain(`cd ${repo} && cadence orchestrate --resume --wave ${WAVE} --drop ici:L1`);
    expect(r.err).toContain('puis relancer spec green');
    expect(r.err).not.toMatch(/reseal|rescellé/);
    expect(vertDe(repo, a.json)).toBe(false);
  });

  it('R6 — vague vivante qui tient le verrou : le refus nomme spec green et dit d\'attendre, jamais le rescellé', () => {
    const { repo, a } = depot();
    vague(repo, 'running' as never);
    writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: WAVE, started: 'x' }));
    registerWave(cadenceHome(), { pid: process.pid, wave: WAVE, started: '2026-10-26T10:00:00Z', cwd: repo, repos: [repo] });
    try {
      const r = cli(repo, 'spec', 'green', 'L1');
      expect(r.code).toBe(2);
      expect(r.err).toContain('spec green : refusé');
      expect(r.err).toContain(`vague ${WAVE} (vivante, pid ${process.pid}, lancée depuis ${repo}) : ici:L1 (question)`);
      expect(r.err).toContain(`vague ${WAVE} : orchestration en cours, à attendre`);
      expect(r.err).not.toMatch(/reseal|rescellé/);
      expect(vertDe(repo, a.json)).toBe(false);
    } finally {
      unregisterWave(cadenceHome(), process.pid);
      rmSync(join(sharedStateDir(repo), REPO_LOCK), { force: true });
    }
  });
});
