import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cli(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-04', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function project() {
  const dir = gitRepo();
  return cli(dir, {}, 'init', '--no-hook').then(async () => {
    await cli(dir, {}, 'add', 'Un lot');
    await cli(dir, {}, 'start', 'L1');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: plan');
    return dir;
  });
}

describe('garde-fous sous CADENCE_ORCHESTRATED', () => {
  it('raf done, raf ux et raf review refusent (code 2), le plan reste intact', async () => {
    const dir = await project();
    const env = { CADENCE_ORCHESTRATED: '2026-10-04-1412' };
    for (const argv of [['done', 'L1'], ['ux', 'L1', 'ok'], ['review', 'L1', 'ok'], ['review', 'enable']]) {
      const r = await cli(dir, env, ...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toContain('refusé pendant une vague orchestrée');
    }
    expect((await cli(dir, {}, 'list', '--status', 'doing')).out).toContain('L1');
    // le reste de raf (lecture, note, commits) n'est pas concerné
    expect((await cli(dir, env, 'now')).code).toBe(0);
    expect((await cli(dir, env, 'note', 'L1', 'une note')).code).toBe(0);
  });

  it('cadence deliver refuse, même en simulation', async () => {
    const dir = await project();
    const r = await cli(dir, { CADENCE_ORCHESTRATED: 'w1' }, 'deliver', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('refusé pendant une vague orchestrée');
  });

  it('cadence deliver refuse un dépôt dont le verrou d\'orchestration est vivant, et le reprend une fois libéré', async () => {
    const dir = await project();
    const lock = join(sharedStateDir(dir), REPO_LOCK);
    mkdirSync(sharedStateDir(dir), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
    const r = await cli(dir, {}, 'deliver', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/orchestration en cours \(vague w9, pid \d+\)/);
    writeFileSync(lock, JSON.stringify({ pid: 99_999_999, wave: 'morte', started: 'x' }));
    const after = await cli(dir, {}, 'deliver', '--dry-run');
    expect(after.err).not.toContain('orchestration en cours');
  });

  describe('verrou vivant : seule la file de CE dépôt refuse (L127)', () => {
    let saved: string | undefined;
    afterEach(() => {
      process.env.CADENCE_HOME = saved;
    });
    const wave = async (statuses: Record<string, LotState['status']>) => {
      const dir = await project();
      const launch = tempDir();
      const home = tempDir();
      const store = RunStore.reserve(launch, 'w7')!;
      store.writeWave({ id: 'w7', status: 'running', created: 'x', lots: Object.keys(statuses) } as never);
      for (const [key, status] of Object.entries(statuses)) {
        const [project, lot] = key.split(':');
        store.writeLot({ ...newLot({ project, repo: project === 'ici' ? dir : join(launch, project), lot, title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
      }
      mkdirSync(sharedStateDir(dir), { recursive: true });
      writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w7', started: 'x' }));
      registerWave(home, { pid: process.pid, wave: 'w7', started: 'x', cwd: launch, repos: [dir] });
      saved = process.env.CADENCE_HOME;
      process.env.CADENCE_HOME = home;
      return dir;
    };

    it('accepte la livraison quand la vague n\'a plus aucun lot en cours ni en file dans ce dépôt', async () => {
      const dir = await wave({ 'ici:L1': 'ready', 'ailleurs:L2': 'implementing', 'autre:L3': 'queued' });
      const r = await cli(dir, {}, 'deliver', '--dry-run');
      expect(r.err).not.toContain('orchestration en cours');
    });

    it('refuse tant qu\'un lot de ce dépôt est en cours ou en file', async () => {
      const dir = await wave({ 'ici:L1': 'ready', 'ici:L4': 'queued' });
      const r = await cli(dir, {}, 'deliver', '--dry-run');
      expect(r.code).toBe(2);
      expect(r.err).toContain('orchestration en cours (vague w7');
    });

    it('refuse aussi depuis un worktree lié du dépôt dont un lot travaille encore', async () => {
      const dir = await wave({ 'ici:L1': 'implementing' });
      const wt = join(tempDir(), 'wt');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'autre', wt], { cwd: dir });
      const r = await cli(wt, {}, 'deliver', '--dry-run');
      expect(r.code).toBe(2);
      expect(r.err).toContain('orchestration en cours (vague w7');
    });
  });
});
