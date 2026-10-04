import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import { commit, gitRepo } from './helpers.js';

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
});
