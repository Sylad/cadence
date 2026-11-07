import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { preparer } from '../src/bench/preparer.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function depot(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), '1'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', 'v-avant');
  writeFileSync(join(dir, 'a.txt'), '2'); git(dir, 'commit', '-qam', 'solution du futur');
  git(dir, 'tag', 'v-futur'); git(dir, 'branch', 'autre');
  return { dir, base };
}
const banc = (source: string, base: string, tests = 'true', install = 'true'): Banc => ({
  id: '1-t', dir: '/nulle-part', secrets: '/nulle-part', projet: 't', source, base,
  install, tests, visible: false, taille: 'retouche', frais: false, reponses: false });

describe('preparer', () => {
  it('clone à la base, sans remote, sans tag ni branche du futur', () => {
    const { dir, base } = depot();
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    const r = preparer(banc(dir, base), cible);
    expect(git(cible, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(cible, 'remote')).toBe('');
    expect(git(cible, 'tag')).toBe('v-avant');
    expect(git(cible, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(cible, 'rev-list', '--all', '--not', 'HEAD')).toBe('');
    expect(r.testsBase).toBe(0);
    expect(existsSync(`${cible}.tests-base.log`)).toBe(true);
  });
  it('rapporte le code de la suite à la base', () => {
    const { dir, base } = depot();
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    expect(preparer(banc(dir, base, 'exit 3'), cible).testsBase).toBe(3);
  });
  it('install en échec : lève en nommant son journal (échec en phase préparation)', () => {
    const { dir, base } = depot();
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    expect(() => preparer(banc(dir, base, 'true', 'echo cassé; exit 4'), cible)).toThrow(`install : voir ${cible}.install.log`);
  });
  it('délai dépassé sur install ou sur tests : lève, et rien ne survit', () => {
    const { dir, base } = depot(); const marque = `40.${process.pid}`;
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    const t0 = Date.now();
    expect(() => preparer(banc(dir, base, 'true', `sleep ${marque} & sleep ${marque}`), cible, 500)).toThrow(/install : délai de .* dépassé, voir .*install\.log/);
    expect(() => preparer(banc(dir, base, `sleep ${marque}`), cible, 500)).toThrow(/tests : délai de .* dépassé, voir .*tests-base\.log/);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(spawnSync('pgrep', ['-f', `sleep ${marque.replace('.', '[.]')}`]).status).toBe(1);
  });
});
