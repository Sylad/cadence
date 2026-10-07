import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

// Les appels système sont interceptés pour provoquer les pannes : un système de fichiers sans liens physiques, et un
// verrou remplacé par un autre porteur entre sa lecture et son renommage.
const hooks = vi.hoisted(() => ({
  link: null as null | NodeJS.ErrnoException,
  beforeRename: null as null | ((from: string) => void),
}));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    linkSync: (a: string, b: string) => {
      if (hooks.link) throw hooks.link;
      return fs.linkSync(a, b);
    },
    renameSync: (a: string, b: string) => {
      const h = hooks.beforeRename;
      hooks.beforeRename = null;
      h?.(a);
      return fs.renameSync(a, b);
    },
  };
});

const { linkNewFile } = await import('../src/state.js');
const { startApp, takeUrlLock, uxLockFile } = await import('../src/orchestrate/app.js');

const dir = tempDir();
afterEach(() => {
  hooks.link = null;
  hooks.beforeRename = null;
});

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('linkNewFile : seul EEXIST veut dire « déjà là »', () => {
  it('EEXIST : false, aucun fichier temporaire ne traîne', () => {
    const f = join(dir, 'exists');
    writeFileSync(f, 'a');
    expect(linkNewFile(f, 'b', 't')).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('a');
    expect(readdirSync(dir).filter((n) => n.startsWith('exists.'))).toEqual([]);
  });

  it.each(['EPERM', 'EMLINK', 'ENOSYS', 'EACCES'])('%s : relancée, pas prise pour un verrou tenu', (code) => {
    const f = join(dir, `nolink-${code}`);
    hooks.link = errno(code);
    expect(() => linkNewFile(f, 'x', 't')).toThrow(code);
    expect(existsSync(f)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith(`nolink-${code}.`))).toEqual([]);
  });
});

describe('takeUrlLock : verrou remplacé entre la lecture et le renommage', () => {
  it('le nouveau porteur vivant garde son verrou, rien ne traîne', () => {
    const lock = join(dir, 'race.lock');
    writeFileSync(lock, String(spawnSync('true').pid)); // pid mort : périmé
    // Entre la lecture du pid mort et le renommage, une autre vague reprend le verrou.
    hooks.beforeRename = () => writeFileSync(lock, String(process.ppid));
    expect(takeUrlLock(lock, process.pid)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    expect(readdirSync(dir).filter((n) => n.startsWith('race.lock.'))).toEqual([]);
    rmSync(lock, { force: true });
  });
});

describe('startApp : verrou impossible à poser', () => {
  it('EPERM : non vérifiée avec la cause (la revue de code suit), rien lancé, pas d\'exception', async () => {
    const url = 'http://127.0.0.1:59871/';
    hooks.link = errno('EPERM');
    const app = await startApp({ command: 'exit 1', url, cwd: dir, log: join(dir, 'app.log'), timeoutMs: 1000, every: 10 });
    expect(app.state.kind === 'unverified' && app.state.cause).toContain('EPERM');
    expect(existsSync(uxLockFile(url))).toBe(false);
    expect(existsSync(join(dir, 'app.log'))).toBe(false);
  });
});
