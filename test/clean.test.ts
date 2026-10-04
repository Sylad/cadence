import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { staleFiles } from '../src/clean.js';
import { gitRepo, tempDir } from './helpers.js';

const TODAY = '2026-09-28';
const OLD = new Date('2026-09-10T10:00:00');

const touch = (file: string, when: Date = OLD) => {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, 'x');
  utimesSync(file, when, when);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const names = (r: { path: string }[]) => r.map((s) => s.path);

describe('staleFiles — dépôts git', () => {
  it('ne propose jamais un dossier qui est un dépôt git', () => {
    const tmp = tempDir();
    const clone = join(tmp, 'clone');
    mkdirSync(clone);
    git(clone, 'init', '-q');
    touch(clone);
    touch(join(tmp, 'libre.png'));
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
  });

  it('ne propose jamais un dossier qui contient un dépôt git, même profond', () => {
    const tmp = tempDir();
    const outer = join(tmp, 'outer');
    mkdirSync(join(outer, 'a/b/clone'), { recursive: true });
    git(join(outer, 'a/b/clone'), 'init', '-q');
    touch(outer);
    expect(staleFiles(tmp, [`${tmp}/*`], 7, TODAY)).toEqual([]);
  });

  it('ne propose pas un dossier dont un fichier est suivi par un dépôt situé hors de la racine', () => {
    const root = tempDir();
    const autre = gitRepo();
    touch(join(autre, 'dossier/suivi.png'));
    git(autre, 'add', 'dossier/suivi.png');
    git(autre, 'commit', '-qm', 'chore: suivi');
    touch(join(autre, 'dossier'));
    touch(join(autre, 'libre.png'));
    expect(names(staleFiles(root, [`${autre}/*`], 7, TODAY))).toEqual([join(autre, 'libre.png')]);
  });

  it('un fichier suivi qu’on atteint par un lien symbolique reste protégé', () => {
    const root = tempDir();
    const autre = gitRepo();
    touch(join(autre, 'suivi.png'));
    git(autre, 'add', 'suivi.png');
    git(autre, 'commit', '-qm', 'chore: suivi');
    const lien = tempDir();
    symlinkSync(autre, join(lien, 'vers'));
    expect(staleFiles(root, [`${lien}/vers/*.png`], 7, TODAY)).toEqual([]);
  });

  it('un fichier suivi dont le nom commence par .. n’est pas pris pour « hors du dépôt »', () => {
    const dir = gitRepo();
    touch(join(dir, '..weird'));
    git(dir, 'add', '..weird');
    git(dir, 'commit', '-qm', 'chore: suivi');
    expect(staleFiles(dir, ['..*'], 7, TODAY)).toEqual([]);
  });
});

describe('staleFiles — motifs', () => {
  it('« * » n’attrape pas les noms en « . », comme le shell', () => {
    const dir = tempDir();
    touch(join(dir, '.env'));
    touch(join(dir, 'a.png'));
    expect(names(staleFiles(dir, [`${dir}/*`], 7, TODAY))).toEqual([join(dir, 'a.png')]);
  });

  it('un motif commençant par « . » attrape les noms cachés', () => {
    const dir = tempDir();
    touch(join(dir, '.cache-vieux'));
    touch(join(dir, '.autre'));
    expect(names(staleFiles(dir, [`${dir}/.cache-*`], 7, TODAY))).toEqual([join(dir, '.cache-vieux')]);
  });

  it('« * » ne traverse pas non plus un dossier caché au milieu du chemin', () => {
    const dir = tempDir();
    touch(join(dir, '.caché/vieux.png'));
    expect(staleFiles(dir, [`${dir}/*/vieux.png`], 7, TODAY)).toEqual([]);
  });

  it('.git n’est jamais proposé, même par un motif en « . »', () => {
    const dir = gitRepo();
    touch(join(dir, '.git'));
    touch(join(dir, '.gitx'));
    expect(names(staleFiles(dir, [`${dir}/.git*`], 7, TODAY))).toEqual([join(dir, '.gitx')]);
  });
});

describe('staleFiles — contenu des dossiers et .git', () => {
  it('ne propose rien sous un dossier .git, même atteint par un motif caché', () => {
    const tmp = tempDir();
    const clone = join(tmp, 'repo');
    mkdirSync(clone);
    git(clone, 'init', '-q');
    touch(join(clone, '.git/hooks/x'));
    touch(join(clone, '.git/hooks'));
    touch(join(clone, '.git/objects'));
    expect(staleFiles(tmp, [`${tmp}/repo/.*/*`], 7, TODAY)).toEqual([]);
  });
});

describe('staleFiles — seuil et ~', () => {
  it('un âge égal au seuil n’est pas proposé, un jour de plus l’est', () => {
    const dir = tempDir();
    touch(join(dir, 'egal.png'), new Date('2026-09-21T10:00:00'));
    touch(join(dir, 'plus.png'), new Date('2026-09-20T10:00:00'));
    const r = staleFiles(dir, [`${dir}/*`], 7, TODAY);
    expect(r.map((s) => [s.path, s.age])).toEqual([[join(dir, 'plus.png'), 8]]);
  });

  it('~ se résout sous le dossier personnel courant', () => {
    const home = tempDir();
    touch(join(home, 'partage/vieux.png'));
    const avant = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(names(staleFiles(tempDir(), ['~/partage/*', '~'], 7, TODAY))).toEqual([join(home, 'partage/vieux.png')]);
    } finally {
      if (avant === undefined) delete process.env.HOME;
      else process.env.HOME = avant;
    }
  });
});
