import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { headSha } from '../src/git.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { appendFailedDelivery, sharedStateDir } from '../src/state.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// L435 — verify lit le verrou du dépôt sans refuser : une tâche locale du lead (L519) n'empêche pas de rejouer les vérifications.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
  cleanupTempDirs();
});

async function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('L435 — verify sous une tâche locale du lead', () => {
  it('verify --sha rejoue et inscrit sa ligne malgré le verrou local:L1', async () => {
    const dir = gitRepo();
    await cli(dir, 'init', '--project', 'demo', '--no-hook');
    await cli(dir, 'add', 'un', '--local');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    commit(dir, 'chore: init');
    const state = sharedStateDir(dir);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'local:L1', started: '2026-11-02T09:00:00.000Z', until: '2099-01-01T00:00:00.000Z' }));
    const sha = headSha(dir)!;
    appendFailedDelivery(state, '2026-11-02', sha, 'vérification en échec', 'verification');
    const r = await cli(dir, 'verify', '--sha', sha);
    expect(r.err).not.toContain('tâche locale');
    expect(r.code).toBe(0);
    expect(r.out).toContain('inscrit au journal des livraisons');
    expect(readFileSync(join(state, 'deliveries.log'), 'utf8')).toBe(`2026-11-02 ${sha}\n`);
  });
});
