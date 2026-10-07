import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { headSha, onRemote, repoStatus } from '../src/git.js';
import { appendDelivery, clearNext, lastDelivery, lockAlive, lockPath, pidAlive, readLock, readNext, releaseLock, removeStaleFile, removeStaleLock, sharedStateDir, stateDir, writeLock, writeNext } from '../src/state.js';
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
    // Écrire ne sait pas effacer : c'est clearNext, qui rend ce qu'il retire.
    expect(() => writeNext(state, '2026-09-28', [])).toThrow('aucune ligne');
    expect(readNext(state)).toEqual({ date: '2026-09-28', lines: ['finir L3', 'relire L4'] });
    expect(clearNext(state)).toEqual({ date: '2026-09-28', lines: ['finir L3', 'relire L4'] });
    expect(readNext(state)).toBeNull();
    expect(clearNext(state)).toBeNull();

    expect(readLock(state)).toBeNull();
    expect(writeLock(state, { pid: process.pid, sha: 'abc', started: '2026-09-28T10:00:00.000Z' })).toBe(true);
    expect(writeLock(state, { pid: 1, sha: 'x', started: 'x' })).toBe(false);
    expect(readLock(state)).toMatchObject({ pid: process.pid, sha: 'abc', started: '2026-09-28T10:00:00.000Z' });
    releaseLock(state, 1);
    expect(readLock(state)).not.toBeNull();
    releaseLock(state, process.pid);
    expect(readLock(state)).toBeNull();

    expect(lastDelivery(state)).toBeNull();
    appendDelivery(state, '2026-09-27', 'aaa');
    appendDelivery(state, '2026-09-28', 'bbb');
    expect(lastDelivery(state)).toBe('bbb');
  });

  it('verrou commun aux worktrees, notes propres à chacun', () => {
    const dir = gitRepo();
    commit(dir, 'init');
    const wt = join(tempDir(), 'wt');
    git(dir, 'worktree', 'add', '-q', '--detach', wt);
    expect(sharedStateDir(wt)).toBe(sharedStateDir(dir));
    expect(stateDir(wt)).not.toBe(stateDir(dir));
  });

  it('ne retire un verrou périmé que s’il est encore celui qui a été lu', () => {
    const state = stateDir(gitRepo());
    const dead = { pid: 2 ** 22 + 12345, sha: 'a', started: 'x' };
    writeLock(state, dead);
    const seen = readLock(state)!;
    writeFileSync(lockPath(state), JSON.stringify({ pid: process.pid, sha: 'b', started: 'y' }));
    expect(removeStaleLock(state, seen)).toBe(false);
    expect(readLock(state)?.sha).toBe('b');
    writeFileSync(lockPath(state), JSON.stringify(dead));
    expect(removeStaleLock(state, readLock(state)!)).toBe(true);
    expect(readLock(state)).toBeNull();
  });

  it('un verrou illisible tout récent est tenu, ancien il est mort', () => {
    expect(lockAlive({ pid: 0, unreadable: true, ageMs: 100 })).toBe(true);
    expect(lockAlive({ pid: 0, unreadable: true, ageMs: 60_000 })).toBe(false);
  });

  it('détecte un pid mort', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('removeStaleFile (protocole partagé des verrous)', () => {
  it('retire le fichier lu ; s\'il a changé entre la lecture et le renommage, le rend à son porteur', () => {
    const dir = tempDir();
    const file = join(dir, 'x.lock');
    writeFileSync(file, 'ancien');
    expect(removeStaleFile(file, (aside) => readFileSync(aside, 'utf8') === 'ancien')).toBe(true);
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, 'nouveau'); // pris par un tiers après notre lecture de « ancien »
    expect(removeStaleFile(file, (aside) => readFileSync(aside, 'utf8') === 'ancien')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('nouveau');
    expect(readdirSync(dir)).toEqual(['x.lock']);
  });

  it('un tiers qui pose le verrou pendant l\'écart garde le sien', () => {
    const dir = tempDir();
    const file = join(dir, 'x.lock');
    writeFileSync(file, 'nouveau');
    const kept = removeStaleFile(file, (aside) => {
      writeFileSync(file, 'tiers'); // le lien de retour échoue : le tiers fait foi
      return readFileSync(aside, 'utf8') === 'ancien';
    });
    expect(kept).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('tiers');
    expect(readdirSync(dir)).toEqual(['x.lock']);
  });
});
