import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { headSha, onRemote, repoStatus } from '../src/git.js';
import { appendDelivery, lastDelivery, pidAlive, readLock, readNext, removeLock, stateDir, writeLock, writeNext } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('faits de dépôt', () => {
  it('sans amont ni commit', () => {
    const dir = gitRepo();
    expect(headSha(dir)).toBeNull();
    commit(dir, 'init');
    writeFileSync(join(dir, 'a.txt'), 'x');
    const s = repoStatus(dir);
    expect(s).toMatchObject({ branch: 'main', dirty: 0, untracked: 1, upstream: null, ahead: 0 });
    expect(headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(onRemote(dir, headSha(dir)!)).toBe(false);
  });

  it('avec une branche amont', () => {
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = gitRepo();
    commit(dir, 'init');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    commit(dir, 'deux');
    writeFileSync(join(dir, 'x'), '');
    git(dir, 'add', 'x');
    expect(repoStatus(dir)).toMatchObject({ upstream: 'origin/main', ahead: 1, dirty: 1 });
    expect(onRemote(dir, headSha(dir)!)).toBe(false);
    git(dir, 'push', '-q');
    expect(repoStatus(dir).ahead).toBe(0);
    expect(onRemote(dir, headSha(dir)!)).toBe(true);
  });
});

describe('état local', () => {
  it('vit dans le dossier git', () => {
    const dir = gitRepo();
    expect(stateDir(dir)).toBe(join(dir, '.git', 'cadence'));
  });

  it('notes, verrou et livraisons', () => {
    const state = stateDir(gitRepo());
    expect(readNext(state)).toBeNull();
    writeNext(state, '2026-09-28', ['finir L3', 'relire L4']);
    expect(readNext(state)).toEqual({ date: '2026-09-28', lines: ['finir L3', 'relire L4'] });
    writeNext(state, '2026-09-28', []);
    expect(readNext(state)).toBeNull();

    expect(readLock(state)).toBeNull();
    expect(writeLock(state, { pid: process.pid, sha: 'abc', started: '2026-09-28T10:00:00.000Z' })).toBe(true);
    expect(writeLock(state, { pid: 1, sha: 'x', started: 'x' })).toBe(false);
    expect(readLock(state)).toEqual({ pid: process.pid, sha: 'abc', started: '2026-09-28T10:00:00.000Z' });
    removeLock(state);
    expect(readLock(state)).toBeNull();

    expect(lastDelivery(state)).toBeNull();
    appendDelivery(state, '2026-09-27', 'aaa');
    appendDelivery(state, '2026-09-28', 'bbb');
    expect(lastDelivery(state)).toBe('bbb');
  });

  it('détecte un pid mort', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
