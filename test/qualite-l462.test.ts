import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, comparer, lireEslint, lireJscpd, lireKnip } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

const msg = (ruleId: string | null, message: string) => ({ ruleId, message });

describe('L462 — lecture des trois outils', () => {
  it('R1 — ESLint : un dépassement est compté par fichier et par règle, avec le pire chiffre mesuré (pas le seuil)', () => {
    const m = lireEslint([
      { filePath: '/r/src/a.ts', messages: [msg('max-lines', 'File has too many lines (450). Maximum allowed is 400.'), msg('complexity', "Function 'f' has a complexity of 20. Maximum allowed is 15."), msg('complexity', "Function 'g' has a complexity of 31. Maximum allowed is 15.")] },
      { filePath: '/r/src/b.ts', messages: [msg('max-depth', 'Blocks are nested too deeply (6). Maximum allowed is 4.'), msg('max-params', "Function 'h' has too many parameters (7). Maximum allowed is 5."), msg('sonarjs/cognitive-complexity', 'Refactor this function to reduce its Cognitive Complexity from 22 to the 15 allowed.'), msg('max-lines-per-function', "Function 'dispatch' has too many lines (540). Maximum allowed is 80.")] },
    ], '/r');
    expect(m['eslint|src/a.ts|max-lines|pire']).toBe(450);
    expect(m['eslint|src/a.ts|complexity']).toBe(2);
    expect(m['eslint|src/a.ts|complexity|pire']).toBe(31);
    expect(m['eslint|src/b.ts|max-depth|pire']).toBe(6);
    expect(m['eslint|src/b.ts|max-params|pire']).toBe(7);
    expect(m['eslint|src/b.ts|sonarjs/cognitive-complexity|pire']).toBe(22);
    expect(m['eslint|src/b.ts|max-lines-per-function|pire']).toBe(540);
  });

  it('R1 — ESLint : une erreur d\'analyse (ruleId nul) est comptée, jamais ignorée ; aucune sortie = aucune mesure', () => {
    expect(lireEslint([{ filePath: '/r/src/c.ts', messages: [msg(null, 'Parsing error')] }], '/r')['eslint|src/c.ts|analyse']).toBe(1);
    expect(lireEslint([{ filePath: '/r/src/ok.ts', messages: [] }], '/r')).toEqual({});
  });

  it('R2 — knip : fichiers inutilisés, exports, types, dépendances et membres d\'enum comptés par fichier (enumMembers est un objet)', () => {
    const m = lireKnip({
      files: ['/r/src/mort.ts'],
      issues: [{ file: 'src/a.ts', exports: [{ name: 'x' }, { name: 'y' }], types: [{ name: 'T' }], devDependencies: [], enumMembers: { E: [{ name: 'A' }, { name: 'B' }] } }],
    }, '/r');
    expect(m).toEqual({ 'knip|src/mort.ts|files': 1, 'knip|src/a.ts|exports': 2, 'knip|src/a.ts|types': 1, 'knip|src/a.ts|enumMembers': 2 });
    expect(lireKnip({}, '/r')).toEqual({});
  });

  it('R3 — jscpd : chaque bloc dupliqué compte pour les deux fichiers, y compris un bloc copié dans le même fichier', () => {
    const m = lireJscpd({ duplicates: [{ firstFile: { name: 'src/a.ts' }, secondFile: { name: 'src/b.ts' } }, { firstFile: { name: 'src/a.ts' }, secondFile: { name: 'src/a.ts' } }] });
    expect(m).toEqual({ 'jscpd|src/a.ts': 3, 'jscpd|src/b.ts': 1 });
    expect(lireJscpd({})).toEqual({});
  });
});

describe('L462 — le cliquet (comparer)', () => {
  const base = { 'eslint|src/a.ts|max-lines': 1, 'eslint|src/a.ts|max-lines|pire': 500 };

  it('R4 — l\'existant passe : une mesure égale à la base n\'empire rien', () => {
    expect(comparer(base, { ...base })).toEqual({ pires: [], mieux: [] });
  });

  it('R5 — un fichier touché ne peut que baisser : le pire chiffre qui monte, avec le même nombre de dépassements, empire', () => {
    const { pires } = comparer(base, { ...base, 'eslint|src/a.ts|max-lines|pire': 501 });
    expect(pires).toEqual([{ cle: 'eslint|src/a.ts|max-lines|pire', avant: 500, apres: 501 }]);
  });

  it('R5 — une règle jamais violée qui l\'est (fichier neuf, règle neuve) empire à partir de zéro', () => {
    const { pires } = comparer(base, { ...base, 'knip|src/neuf.ts|files': 1 });
    expect(pires).toEqual([{ cle: 'knip|src/neuf.ts|files', avant: 0, apres: 1 }]);
  });

  it('R6 — ce qui baisse ou disparaît est rendu en « mieux », sans compter comme pire', () => {
    const { pires, mieux } = comparer(base, { 'eslint|src/a.ts|max-lines|pire': 450 });
    expect(pires).toEqual([]);
    expect(mieux).toEqual([{ cle: 'eslint|src/a.ts|max-lines', avant: 1, apres: 0 }, { cle: 'eslint|src/a.ts|max-lines|pire', avant: 500, apres: 450 }]);
  });
});

describe('L462 — la ligne de base (appliquer)', () => {
  const lire = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));

  it('R7 — sans ligne de base, la vérification échoue en disant comment la créer (code 2, pas un faux vert)', () => {
    const r = appliquer(tempDir(), 'verifier', {});
    expect(r.code).toBe(2);
    expect(r.texte).toContain('--init');
  });

  it('R7 — --init crée la base triée ; une seconde fois il refuse de la recréer (elle ne peut pas remonter)', () => {
    const dir = tempDir();
    expect(appliquer(dir, 'init', { b: 2, a: 1 }).code).toBe(0);
    expect(Object.keys(lire(dir))).toEqual(['a', 'b']);
    const r = appliquer(dir, 'init', { a: 9 });
    expect(r.code).toBe(2);
    expect(lire(dir)).toEqual({ a: 1, b: 2 });
  });

  it('R5 — la vérification échoue (code 1) en nommant la mesure qui empire', () => {
    const dir = tempDir();
    appliquer(dir, 'init', { a: 1 });
    const r = appliquer(dir, 'verifier', { a: 2 });
    expect(r.code).toBe(1);
    expect(r.texte).toContain('a : 1 → 2');
  });

  it('R6 — la vérification passe quand ça baisse, et dit comment figer le gain sans toucher la base', () => {
    const dir = tempDir();
    appliquer(dir, 'init', { a: 3 });
    const r = appliquer(dir, 'verifier', { a: 1 });
    expect(r.code).toBe(0);
    expect(r.texte).toContain('qualite:cliquet');
    expect(lire(dir)).toEqual({ a: 3 });
  });

  it('R6 — --ecrire fige le gain (clés disparues retirées) mais refuse d\'écrire si quoi que ce soit empire, base intacte', () => {
    const dir = tempDir();
    appliquer(dir, 'init', { a: 3, b: 1 });
    expect(appliquer(dir, 'ecrire', { a: 4 }).code).toBe(1);
    expect(lire(dir)).toEqual({ a: 3, b: 1 });
    expect(appliquer(dir, 'ecrire', { a: 2 }).code).toBe(0);
    expect(lire(dir)).toEqual({ a: 2 });
  });
});

describe('L462 — parcours réel dans un dépôt jetable (vrais ESLint, knip, jscpd)', () => {
  const gros = (n: number) => `export function f(): number {\n  let x = 0;\n${Array.from({ length: n }, (_, i) => `  x += ${i};`).join('\n')}\n  return x;\n}\n`;

  function projet() {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    // jscpd plante sur un dossier de path absent : le projet jetable n'a que src/
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    writeFileSync(join(dir, 'src/cli.ts'), "import { f } from './gros.js';\nconsole.log(f());\n");
    writeFileSync(join(dir, 'src/gros.ts'), gros(450));
    return dir;
  }
  const qualite = (dir: string, ...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });

  it('R8 — un fichier de 452 lignes est figé par --init, passe ensuite, échoue s\'il grossit, et passe s\'il maigrit', () => {
    const dir = projet();
    expect(qualite(dir).status).toBe(2);
    const init = qualite(dir, '--init');
    expect(init.status).toBe(0);
    const base = JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));
    expect(base['eslint|src/gros.ts|max-lines']).toBe(1);
    expect(base['eslint|src/gros.ts|max-lines|pire']).toBeGreaterThan(400);
    expect(qualite(dir).status).toBe(0);

    writeFileSync(join(dir, 'src/gros.ts'), gros(500));
    const pire = qualite(dir);
    expect(pire.status).toBe(1);
    expect(pire.stderr).toContain('src/gros.ts|max-lines|pire');

    writeFileSync(join(dir, 'src/gros.ts'), gros(410));
    expect(qualite(dir).status).toBe(0);
    expect(qualite(dir, '--ecrire').status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'))['eslint|src/gros.ts|max-lines|pire']).toBeLessThan(base['eslint|src/gros.ts|max-lines|pire']);
  });

  it('R8 — un export jamais importé (code mort pour knip) est détecté puis refusé, et un outil qui plante ne passe pas pour « zéro défaut »', () => {
    const dir = projet();
    writeFileSync(join(dir, 'src/gros.ts'), gros(3));
    expect(qualite(dir, '--init').status).toBe(0);
    writeFileSync(join(dir, 'src/gros.ts'), `${gros(3)}export const mort = 1;\n`);
    const r = qualite(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('knip|src/gros.ts|exports');

    writeFileSync(join(dir, 'eslint.config.mjs'), 'export default [{ rules: { "pas-une-regle": "error" } }, ];\nthrow new Error("config cassée");\n');
    const casse = qualite(dir);
    expect(casse.status).toBe(2);
    expect(casse.stderr).toContain('eslint');
    expect(existsSync(join(dir, 'src'))).toBe(true);
  });
});
