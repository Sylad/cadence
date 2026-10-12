import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

/** Copie du paquet (sources et scripts) : on y lance les scripts npm sans toucher au dist/ en service du dépôt. */
function copyOfPackage(): string {
  const dir = tempDir();
  for (const n of ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) cpSync(join(REPO, n), join(dir, n), { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const npm = (dir: string, script: string) => execFileSync('npm', ['run', '--silent', script], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, npm_config_loglevel: 'error' } });

describe('le dist/ en service (L195)', () => {
  const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts as Record<string, string>;

  it('npm run build vérifie la compilation sans écrire dist/ : une session de vague ne met pas du code non revu en service', () => {
    const dir = copyOfPackage();
    npm(dir, 'build');
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it('npm run build échoue sur une erreur de type, comme avant', () => {
    const dir = copyOfPackage();
    execFileSync('node', ['-e', "require('fs').appendFileSync('src/dates.ts', '\\nexport const casse: number = \"x\";\\n')"], { cwd: dir });
    expect(() => npm(dir, 'build')).toThrow();
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it('prepare (npm install, publication) construit dist/ : le paquet publié l’embarque ; il n’y a plus de build:service', () => {
    expect(scripts.prepare).toBe('tsc -p tsconfig.build.json');
    expect(scripts['build:service']).toBeUndefined();
    expect(scripts.service).toBe('node scripts/mise-en-service.mjs');
  });

  it('le skill lead ne met en service qu’après le verdict : la mise en service (npm run service) est à l’étape 3, après raf done, pas à l’étape 2', () => {
    const skill = readFileSync(join(REPO, 'skills', 'lead', 'SKILL.md'), 'utf8');
    const check = skill.slice(skill.indexOf('## 3. Check'), skill.indexOf('## 4. Delivery'));
    const step2 = check.slice(check.indexOf('\n2. '), check.indexOf('\n3. '));
    const step3 = check.slice(check.indexOf('\n3. '));
    expect(step2).not.toContain('npm run service');
    expect(step3).toContain('npm run service');
    expect(step3.indexOf('npm run service')).toBeGreaterThan(step3.indexOf('raf done'));
  });

  it('le skill lead ne met pas HEAD en service quand un lot rendu est au-dessus : la mise en service prend un sha accepté, jamais HEAD quand un lot rendu est au-dessus', () => {
    const skill = readFileSync(join(REPO, 'skills', 'lead', 'SKILL.md'), 'utf8');
    const check = skill.slice(skill.indexOf('## 3. Check'), skill.indexOf('## 4. Delivery'));
    const step3 = check.slice(check.indexOf('\n3. '));
    const service = step3.slice(step3.indexOf('npm run service'));
    expect(service).toContain('livrable jusqu');
    expect(service).toMatch(/not HEAD/);
    expect(service).toMatch(/ancestor/);
  });
});
