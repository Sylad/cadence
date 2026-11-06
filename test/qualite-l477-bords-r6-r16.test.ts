import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASELINE, comparerMigration, creerLien, lireRef, type Mesure } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const lignes = (n: number, depart = 0, prefixe = 'x') => Array.from({ length: n }, (_, i) => `${prefixe} += ${depart + i};`).join('\n');
const cle = (f: string) => `eslint|${f}|max-lines|total`;
const carte = (m: Record<string, number>): Mesure => Object.fromEntries(Object.entries(m).map(([f, n]) => [cle(f), n]));

describe('L477 R3/R6 — bords du groupement par source', () => {
  it('R6 — un fichier sans lien n\'hérite pas du crédit d\'une source qui s\'appelle « null »', () => {
    const base = carte({ null: 100 });
    const depart: Record<string, string> = { null: lignes(100) };
    const courant: Record<string, string> = { 'src/lie.ts': lignes(100), 'src/libre.ts': lignes(80, 9000, 'y') };
    const lien = creerLien(base, { depart: (c) => depart[c] ?? null, courant: (c) => courant[c] ?? null, neuf: (c) => courant[c] ?? null });
    // lie.ts est lié à « null » (perte 100, mesure 20) ; libre.ts n'a aucune source : il doit être refusé
    const p = comparerMigration(base, carte({ 'src/lie.ts': 20, 'src/libre.ts': 80 }), (c) => c === 'null', lien);
    expect(p.map((x) => x.cle)).toEqual([cle('src/libre.ts')]);
  });
});

describe('L477 R16 — git ne rend pas un contenu du départ', () => {
  const git = (dir: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });

  it('R16 — un blob du départ absent de la base d\'objets : sortie 2 et base intacte, pas un « pas de lien »', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    const source = lignes(200);
    writeFileSync(join(dir, 'src/s.ts'), `${source}\n`);
    const depart = carte({ 'src/s.ts': 200 });
    writeFileSync(join(dir, BASELINE), JSON.stringify(depart));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'départ');
    git(dir, 'switch', '-q', '-c', 'lot');
    // le blob de la source disparaît (clone partiel, objet perdu)
    const blob = git(dir, 'rev-parse', 'main:src/s.ts').stdout.trim();
    rmSync(join(dir, '.git/objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    expect(git(dir, 'cat-file', '-e', blob).status).not.toBe(0);
    expect(() => lireRef(dir, 'main').contenu!('src/s.ts')).toThrow(/le contenu de src\/s\.ts au point de départ main est illisible/);
  });

  it('R16 — l\'arbre du départ illisible : existe lève au lieu de rendre faux (un fichier du départ ne passe pas pour neuf)', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/s.ts'), `${lignes(5)}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'départ');
    const ref = lireRef(dir, 'main');
    expect(ref.existe!('src/s.ts')).toBe(true);
    // l'arbre racine du départ perdu : ls-tree échoue
    const arbre = git(dir, 'rev-parse', 'main^{tree}').stdout.trim();
    rmSync(join(dir, '.git/objects', arbre.slice(0, 2), arbre.slice(2)), { force: true });
    expect(() => ref.existe!('src/s.ts')).toThrow(/src\/s\.ts au point de départ main est illisible/);
  });
});
