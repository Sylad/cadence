import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, lireRef } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

/** Dépôt réel avec un commit de départ contenant `fichiers`, puis lireRef sur HEAD (la vraie forme de ref, pas une fixture). */
function depotReel(fichiers: Record<string, string>) {
  const dir = gitRepo();
  const run = (...a: string[]) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { cwd: dir, stdio: 'ignore' });
  fichiers[BASELINE] = '{}';
  for (const [f, c] of Object.entries(fichiers)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
    run('add', f);
  }
  run('commit', '-q', '-m', 'départ');
  return { dir, ref: lireRef(dir, 'HEAD') };
}

describe('L479 bords — .gitignore imbriqués', () => {
  it('un .gitignore imbriqué dans un dossier caché (.claude/.gitignore) modifié est refusé', () => {
    const { dir, ref } = depotReel({ '.claude/.gitignore': 'a\n' });
    writeFileSync(join(dir, '.claude/.gitignore'), 'a\nb\n');
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('.claude/.gitignore (modifié)');
  });

  it('un .gitignore imbriqué neuf dans un dossier caché est refusé', () => {
    const { dir, ref } = depotReel({});
    mkdirSync(join(dir, '.cache'));
    writeFileSync(join(dir, '.cache/.gitignore'), '*\n');
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('.cache/.gitignore (nouveau)');
  });

  it('un .gitignore imbriqué dont le chemin a des espaces et un accent, supprimé, est refusé (ls-tree ne doit pas le citer)', () => {
    const { dir, ref } = depotReel({ 'dossier é/sous dossier/.gitignore': 'a\n' });
    execFileSync('rm', [join(dir, 'dossier é/sous dossier/.gitignore')]);
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('dossier é/sous dossier/.gitignore (supprimé)');
  });

  it('un .gitignore profond (a/b/c/d/.gitignore) neuf est refusé', () => {
    const { dir, ref } = depotReel({});
    mkdirSync(join(dir, 'a/b/c/d'), { recursive: true });
    writeFileSync(join(dir, 'a/b/c/d/.gitignore'), 'x\n');
    expect(appliquer(dir, 'verifier', {}, ref).texte).toContain('a/b/c/d/.gitignore (nouveau)');
  });

  it('un .gitignore dans un node_modules imbriqué (packages/x/node_modules) n\'est pas compté', () => {
    const { dir, ref } = depotReel({});
    mkdirSync(join(dir, 'packages/x/node_modules/p'), { recursive: true });
    writeFileSync(join(dir, 'packages/x/node_modules/p/.gitignore'), 'x\n');
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
  });

  it('inchangés, les .gitignore imbriqués d\'un vrai dépôt passent', () => {
    const { dir, ref } = depotReel({ 'src/.gitignore': 'a\n', '.gitignore': 'node_modules\n' });
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
  });

  it('un ref sans fichiers() (ancienne forme) ne plante pas', () => {
    const { dir, ref } = depotReel({});
    const { fichiers: _f, ...ancien } = ref;
    expect(appliquer(dir, 'verifier', {}, ancien).code).toBe(0);
  });
});

describe('L479 bords — package.json et configs', () => {
  it('réordonner les sous-clés de scripts sans changer leur sens est signalé ou non, mais ne plante pas', () => {
    const { dir, ref } = depotReel({ 'package.json': '{"scripts":{"a":"1","b":"2"}}' });
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"b":"2","a":"1"}}');
    expect(() => appliquer(dir, 'verifier', {}, ref)).not.toThrow();
  });

  it('une clé « exports » ajoutée alors qu\'elle n\'y était pas est refusée (nouveau)', () => {
    const { dir, ref } = depotReel({ 'package.json': '{"name":"p"}' });
    writeFileSync(join(dir, 'package.json'), '{"name":"p","exports":"./a.js"}');
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('package.json#exports (nouveau)');
  });

  it('un vitest.config.ts neuf dans un vrai dépôt, et tsconfig.json supprimé, sont refusés ensemble', () => {
    const { dir, ref } = depotReel({ 'tsconfig.json': '{}' });
    execFileSync('rm', [join(dir, 'tsconfig.json')]);
    writeFileSync(join(dir, 'vitest.config.ts'), 'x');
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('tsconfig.json (supprimé)');
    expect(r.texte).toContain('vitest.config.ts (nouveau)');
  });

  it('un tsconfig.build.json modifié n\'est pas refusé (knip ne le lit pas) — ou alors le dit', () => {
    const { dir, ref } = depotReel({ 'tsconfig.build.json': '{}' });
    writeFileSync(join(dir, 'tsconfig.build.json'), '{"a":1}');
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
  });
});

describe('L479 bords — .git/info/exclude', () => {
  const ecrireExclude = (dir: string, contenu: string) => {
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/exclude'), contenu);
  };

  it('des fins de ligne CRLF ne laissent pas de \\r dans le motif affiché', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    ecrireExclude(dir, '# c\r\nsrc/gros.ts\r\n');
    const { texte } = appliquer(dir, 'verifier', {});
    expect(texte).toContain('(src/gros.ts)');
    expect(texte).not.toContain('\r');
  });

  it('un fichier fait uniquement d\'espaces ne dit rien', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    ecrireExclude(dir, '   \n\t\n');
    expect(appliquer(dir, 'verifier', {}).texte).not.toContain('exclude');
  });

  it('exactement trois motifs : pas de « autre(s) »', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    ecrireExclude(dir, 'a\nb\nc\n');
    const { texte } = appliquer(dir, 'verifier', {});
    expect(texte).toContain('(a, b, c)');
    expect(texte).not.toContain('autre(s)');
  });

  it('un motif « \\#fichier » (échappé, pas un commentaire) est signalé', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    ecrireExclude(dir, '\\#fichier\n');
    expect(appliquer(dir, 'verifier', {}).texte).toContain('#fichier');
  });

  it('le mode --ecrire garde son code 0 et son message avec l\'avertissement ajouté', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{"a":3}');
    ecrireExclude(dir, 'x\n');
    const r = appliquer(dir, 'ecrire', { a: 1 });
    expect(r.code).toBe(0);
    expect(r.texte).toContain('baissée');
    expect(r.texte).toContain('info/exclude');
  });

  it('une erreur (code 2, base absente) porte aussi l\'avertissement sans changer de code', () => {
    const dir = gitRepo();
    ecrireExclude(dir, 'x\n');
    const r = appliquer(dir, 'verifier', {});
    expect(r.code).toBe(2);
  });
});
