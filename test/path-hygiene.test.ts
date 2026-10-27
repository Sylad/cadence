import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { sanitizePath } from './path-hygiene.js';

afterAll(cleanupTempDirs);

/** Un dossier de PATH qui porte les exécutables donnés. */
function binDir(...names: string[]): string {
  const dir = join(tempDir(), 'bin');
  mkdirSync(dir);
  for (const n of names) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
  return dir;
}

const sanitize = (dirs: string[], repo = tempDir()) => {
  const mirrors = tempDir();
  return { ...sanitizePath(dirs.join(delimiter), repo, mirrors), mirrors };
};

describe('la suite tourne sans raf ni cadence installés dans le PATH (L384)', () => {
  it('R1 — un dossier du PATH qui porte raf est retiré', () => {
    const outil = binDir('raf');
    const autre = binDir('git');
    const { path } = sanitize([outil, autre]);
    expect(path.split(delimiter)).not.toContain(outil);
    expect(path.split(delimiter)).toContain(autre);
  });

  it('R2 — un dossier qui porte cadence est retiré', () => {
    const outil = binDir('cadence');
    expect(sanitize([outil]).path.split(delimiter)).not.toContain(outil);
  });

  it('R3 — un dossier du dépôt lui-même n\'est pas touché, même avec un raf', () => {
    const repo = tempDir();
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'raf'), '');
    expect(sanitize([bin], repo).path.split(delimiter)).toEqual([bin]);
  });

  it('R4 — les autres outils d\'un dossier retiré restent atteignables, sans raf ni cadence (le dossier de node peut porter les deux)', () => {
    const mixte = binDir('raf', 'cadence', 'node-simule');
    const { path } = sanitize([mixte]);
    const found = spawnSync('/bin/sh', ['-c', 'command -v node-simule; command -v raf; command -v cadence'], { env: { PATH: path }, encoding: 'utf8' });
    expect(found.stdout.trim().split('\n')).toHaveLength(1);
    expect(found.stdout).toContain('node-simule');
  });

  it('R5 — l\'ordre des autres dossiers est conservé, et un PATH sans outil installé reste identique', () => {
    const a = binDir('git');
    const b = binDir('node');
    const dirs = [a, b];
    const { path, removed } = sanitize(dirs);
    expect(path).toBe(dirs.join(delimiter));
    expect(removed).toEqual([]);
  });

  it('R6 — la suite elle-même ne trouve ni raf ni cadence dans son PATH (rouge sur la machine du développeur comme en CI)', () => {
    const found = spawnSync('sh', ['-c', 'command -v raf; command -v cadence'], { env: process.env, encoding: 'utf8' });
    expect(found.stdout.trim()).toBe('');
  });

  it('R7 — un dossier de PATH inexistant ou vide est conservé tel quel', () => {
    const inexistant = join(tempDir(), 'absent');
    expect(existsSync(inexistant)).toBe(false);
    expect(sanitize([inexistant, '']).path).toBe([inexistant, ''].join(delimiter));
  });
});
