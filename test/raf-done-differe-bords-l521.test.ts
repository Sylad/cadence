import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { gitRepo, tempDir } from './helpers.js';

// L521 — bords de « raf done différé » : sous-dossier, répétition, lot inconnu, ordre des options, autres états, autre commande.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function raf(dir: string, env: Record<string, string> = {}, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-31', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-31T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function vague(status: LotState['status']) {
  const dir = gitRepo();
  raf(dir, {}, 'init', '--project', 'demo', '--no-hook');
  raf(dir, {}, 'add', 'un');
  raf(dir, {}, 'start', 'L1');
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'plan'], { stdio: 'ignore' });
  const launch = tempDir();
  const store = RunStore.reserve(launch, 'w9')!;
  store.writeWave({ id: 'w9', status: 'running', created: 'x', lots: ['demo:L1'] } as never);
  store.writeLot({ ...newLot({ project: 'demo', repo: dir, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
  registerWave(process.env.CADENCE_HOME!, { pid: process.pid, wave: 'w9', started: 'x', cwd: launch, repos: [dir] });
  return dir;
}
const dirty = (dir: string) => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

describe('raf done différé — bords (L521)', () => {
  it('B1 — lancé depuis un sous-dossier du dépôt : refusé aussi, plan intact', () => {
    const dir = vague('implementing');
    const sub = join(dir, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const r = raf(sub, {}, 'done', 'L1', '--force');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/done différé/);
    expect(dirty(dir)).toBe('');
  });
  it('B2 — deux fois de suite : refusé les deux fois, jamais écrit', () => {
    const dir = vague('implementing');
    expect(raf(dir, {}, 'done', 'L1', '--force').code).toBe(2);
    expect(raf(dir, {}, 'done', 'L1', '--force').code).toBe(2);
    expect(dirty(dir)).toBe('');
  });
  it('B3 — --now avant l\'identifiant : écrit, et le message de refus nomme le bon lot', () => {
    const dir = vague('implementing');
    const refused = raf(dir, {}, 'done', 'L1', '--force');
    expect(refused.err).toContain('raf done L1');
    expect(raf(dir, {}, 'done', '--now', '--force', 'L1').code).toBe(0);
    expect(dirty(dir)).not.toBe('');
  });
  it('B4 — identifiant absent : usage (code 2), pas le refus différé', () => {
    const dir = vague('implementing');
    const r = raf(dir, {}, 'done');
    expect(r.code).toBe(2);
    expect(r.err).not.toMatch(/done différé/);
  });
  it('B5 — lot inconnu pendant la vague : « lot inconnu » plutôt que « done différé » (rien à différer)', () => {
    const dir = vague('implementing');
    const r = raf(dir, {}, 'done', 'L99', '--force');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/lot inconnu/);
  });
  it('B6 — lots en attente, en question, rendus, en échec : done écrit', () => {
    for (const status of ['queued', 'question', 'ready', 'handed-back', 'failed', 'suspended'] as const) {
      const dir = vague(status as never);
      const r = raf(dir, {}, 'done', 'L1', '--force');
      expect(r.code, status).toBe(0);
    }
  });
  it('B7 — depuis une session de la vague (CADENCE_ORCHESTRATED) : le refus est celui du lead-only, pas « done différé »', () => {
    const r = raf(vague('implementing'), { CADENCE_ORCHESTRATED: '1' }, 'done', 'L1', '--force');
    expect(r.err).toMatch(/refusé pendant une vague orchestrée/);
    expect(r.err).not.toMatch(/done différé/);
  });
  it('B8 — depuis un worktree du dépôt (.git est un fichier) : écrit, sans refus', () => {
    const dir = vague('implementing');
    const wt = join(tempDir(), 'wt');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'autre', wt], { stdio: 'ignore' });
    const r = raf(wt, {}, 'done', 'L1', '--force');
    expect(r.code).toBe(0);
  });
  it('B9 — --now sur start, drop ou note : accepté sans erreur d\'option', () => {
    for (const argv of [['note', 'L1', 'x', '--now'], ['drop', 'L1', '--now']]) expect(raf(vague('implementing'), {}, ...argv).code, argv[0]).toBe(0);
  });
  it('B10 — l\'aide mentionne --now pour raf done', () => {
    const r = raf(vague('implementing'), {}, '--help');
    expect(r.out + r.err).toMatch(/raf done <id> \[--force\] \[--now\]/);
  });
  it('B11 — --now sur un lot déjà done : pas de refus différé', () => {
    const dir = vague('ready');
    raf(dir, {}, 'done', 'L1', '--force');
    const r = raf(dir, {}, 'done', 'L1', '--force', '--now');
    expect(r.err).not.toMatch(/done différé/);
  });
});
