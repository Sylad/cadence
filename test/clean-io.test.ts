import { describe, expect, it, vi } from 'vitest';
import { lutimesSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanStale } from '../src/clean.js';
import { tempDir } from './helpers.js';

/*
 * Erreurs de lecture qu'un vrai système de fichiers ne produit pas à la demande : un élément qui
 * disparaît entre readdir et lstat, une erreur autre que « absent » sur la recherche d'un `.git`.
 * lstatSync est doublé pour les noms que les tests désignent ; tout le reste passe au vrai.
 */
const failing = new Map<string, string>();
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    const code = failing.get(String(path));
    if (code) throw Object.assign(new Error(`${code}: ${String(path)}`), { code });
    return (fs.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.lstatSync;
  return { ...fs, lstatSync };
});

const TODAY = '2026-09-28';
const OLD = new Date('2026-09-10T10:00:00');
const old = (path: string) => lutimesSync(path, OLD, OLD);

describe('scanStale — lectures qui échouent en cours de parcours', () => {
  it('un enfant qui disparaît (ENOENT entre readdir et lstat) : pas de levée, le dossier n’est pas proposé', () => {
    const tmp = tempDir();
    mkdirSync(join(tmp, 'travail'));
    writeFileSync(join(tmp, 'travail/disparu'), 'x');
    writeFileSync(join(tmp, 'libre.png'), 'x');
    for (const p of ['travail/disparu', 'travail', 'libre.png']) old(join(tmp, p));
    failing.set(join(tmp, 'travail/disparu'), 'ENOENT');
    try {
      const r = scanStale(tmp, [`${tmp}/*`], 7, TODAY);
      expect(r.stale.map((s) => s.path)).toEqual([join(tmp, 'libre.png')]);
      expect(r.unreadable).toEqual([join(tmp, 'travail/disparu')]);
    } finally {
      failing.clear();
    }
  });

  it('un .git ancêtre qu’on ne peut pas examiner (EACCES) : le suivi git est inconnu, rien n’est proposé', () => {
    const tmp = tempDir();
    writeFileSync(join(tmp, 'vieux.png'), 'x');
    old(join(tmp, 'vieux.png'));
    failing.set(join(tmp, '.git'), 'EACCES');
    try {
      const r = scanStale(tmp, [`${tmp}/*.png`], 7, TODAY);
      expect(r.stale).toEqual([]);
      expect(r.unreadable).toEqual([join(tmp, 'vieux.png')]);
    } finally {
      failing.clear();
    }
  });
});
