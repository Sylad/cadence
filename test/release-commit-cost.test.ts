// (L72) isReleaseOnly refuse par nom de fichier avant de lire le moindre contenu (coût de `raf check`).
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo } from './helpers.js';

vi.mock('../src/git.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/git.js')>();
  return { ...orig, fileAt: vi.fn(orig.fileAt) };
});

import { fileAt } from '../src/git.js';
import { isReleaseOnly } from '../src/audit.js';

function commitFiles(dir: string, files: Record<string, string>): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

describe('(L72) isReleaseOnly : le nom de fichier d\'abord', () => {
  it('un fichier hors version dans le commit : false sans lire aucun contenu', () => {
    const dir = gitRepo();
    commitFiles(dir, { 'README.md': 'a\n', 'src/a.ts': 'a\n' });
    const sha = commitFiles(dir, { 'README.md': 'b\n', 'src/a.ts': 'b\n' });
    vi.mocked(fileAt).mockClear();
    expect(isReleaseOnly(sha, dir)).toBe(false);
    expect(fileAt).not.toHaveBeenCalled();
  });
});
