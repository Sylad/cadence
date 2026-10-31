import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, comparer, comparerMigration, lireDirectives, lireEslint, lireJscpd, lireKnip, lireRef } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

const msg = (ruleId: string | null, message: string) => ({ ruleId, message });

describe('L462 — lecture des trois outils', () => {
  it('R1 — ESLint : un dépassement est compté par fichier et par règle, avec la somme des chiffres mesurés (|total, pas le seuil)', () => {
    const m = lireEslint([
      { filePath: '/r/src/a.ts', messages: [msg('max-lines', 'File has too many lines (450). Maximum allowed is 400.'), msg('complexity', "Function 'f' has a complexity of 20. Maximum allowed is 15."), msg('complexity', "Function 'g' has a complexity of 31. Maximum allowed is 15.")] },
      { filePath: '/r/src/b.ts', messages: [msg('max-depth', 'Blocks are nested too deeply (6). Maximum allowed is 4.'), msg('max-params', "Function 'h' has too many parameters (7). Maximum allowed is 5."), msg('sonarjs/cognitive-complexity', 'Refactor this function to reduce its Cognitive Complexity from 22 to the 15 allowed.'), msg('max-lines-per-function', "Function 'dispatch' has too many lines (540). Maximum allowed is 80.")] },
    ], '/r');
    expect(m['eslint|src/a.ts|max-lines|total']).toBe(450);
    expect(m['eslint|src/a.ts|complexity']).toBe(2);
    expect(m['eslint|src/a.ts|complexity|total']).toBe(51);
    expect(m['eslint|src/b.ts|max-depth|total']).toBe(6);
    expect(m['eslint|src/b.ts|max-params|total']).toBe(7);
    expect(m['eslint|src/b.ts|sonarjs/cognitive-complexity|total']).toBe(22);
    expect(m['eslint|src/b.ts|max-lines-per-function|total']).toBe(540);
  });

  it('R1 — ESLint : une fonction qui grossit sans dépasser la pire du fichier, ou une neuve qui remplace une petite, fait monter le total', () => {
    const cog = (n: number) => msg('sonarjs/cognitive-complexity', `Refactor this function to reduce its Cognitive Complexity from ${n} to the 15 allowed.`);
    const mesure = (...n: number[]) => lireEslint([{ filePath: '/r/src/cli.ts', messages: n.map(cog) }], '/r');
    const avant = mesure(463, 20, 18);
    expect(comparer(avant, mesure(463, 20, 400)).pires.map((p) => p.cle)).toEqual(['eslint|src/cli.ts|sonarjs/cognitive-complexity|total']);
    expect(comparer(avant, mesure(463, 18, 300)).pires).toHaveLength(1);
    expect(comparer(avant, mesure(463, 20, 18)).pires).toEqual([]);
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

  it('R3 — jscpd : un bloc dupliqué qui passe de 10 à 200 lignes fait monter le total de lignes, même si le nombre de blocs ne change pas', () => {
    const rapport = (lines: number) => ({ duplicates: [{ lines, firstFile: { name: 'src/a.ts' }, secondFile: { name: 'src/b.ts' } }] });
    expect(lireJscpd(rapport(200))['jscpd|src/a.ts|lignes']).toBe(200);
    expect(comparer(lireJscpd(rapport(10)), lireJscpd(rapport(200))).pires.map((p) => p.cle)).toEqual(['jscpd|src/a.ts|lignes', 'jscpd|src/b.ts|lignes']);
  });

  it('R3 — jscpd : chaque bloc dupliqué compte pour les deux fichiers, y compris un bloc copié dans le même fichier', () => {
    const m = lireJscpd({ duplicates: [{ firstFile: { name: 'src/a.ts' }, secondFile: { name: 'src/b.ts' } }, { firstFile: { name: 'src/a.ts' }, secondFile: { name: 'src/a.ts' } }] });
    expect(m).toEqual({ 'jscpd|src/a.ts': 3, 'jscpd|src/a.ts|lignes': 0, 'jscpd|src/b.ts': 1, 'jscpd|src/b.ts|lignes': 0 });
    expect(lireJscpd({})).toEqual({});
  });
});

describe('L462 — le cliquet (comparer)', () => {
  const base = { 'eslint|src/a.ts|max-lines': 1, 'eslint|src/a.ts|max-lines|total': 500 };

  it('R4 — l\'existant passe : une mesure égale à la base n\'empire rien', () => {
    expect(comparer(base, { ...base })).toEqual({ pires: [], mieux: [] });
  });

  it('R5 — un fichier touché ne peut que baisser : la somme des chiffres (|total) qui monte, avec le même nombre de dépassements, empire', () => {
    const { pires } = comparer(base, { ...base, 'eslint|src/a.ts|max-lines|total': 501 });
    expect(pires).toEqual([{ cle: 'eslint|src/a.ts|max-lines|total', avant: 500, apres: 501 }]);
  });

  it('R5 — une règle jamais violée qui l\'est (fichier neuf, règle neuve) empire à partir de zéro', () => {
    const { pires } = comparer(base, { ...base, 'knip|src/neuf.ts|files': 1 });
    expect(pires).toEqual([{ cle: 'knip|src/neuf.ts|files', avant: 0, apres: 1 }]);
  });

  it('R6 — ce qui baisse ou disparaît est rendu en « mieux », sans compter comme pire', () => {
    const { pires, mieux } = comparer(base, { 'eslint|src/a.ts|max-lines|total': 450 });
    expect(pires).toEqual([]);
    expect(mieux).toEqual([{ cle: 'eslint|src/a.ts|max-lines', avant: 1, apres: 0 }, { cle: 'eslint|src/a.ts|max-lines|total', avant: 500, apres: 450 }]);
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

  it('R5 — la vérification échoue (code 1) en nommant la mesure qui empire ; sans base au point de départ, elle propose la voie d\'amorçage (--init --contre)', () => {
    const dir = tempDir();
    appliquer(dir, 'init', { a: 1 });
    const r = appliquer(dir, 'verifier', { a: 2 });
    expect(r.code).toBe(1);
    expect(r.texte).toContain('a : 1 → 2');
    expect(r.texte).not.toContain('--init');
    const sansBase = appliquer(dir, 'verifier', { a: 2 }, { nom: 'main (abc1234)', base: null });
    expect(sansBase.code).toBe(1);
    expect(sansBase.texte).toContain('--init --contre main');
    // avec une base au départ, la voie n'est pas proposée : la base ne peut que baisser
    expect(appliquer(dir, 'verifier', { a: 2 }, { nom: 'main (abc1234)', base: { a: 1 } }).texte).not.toContain('--init');
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

describe('L462 — la base ne peut pas remonter par rapport au point de départ du lot', () => {
  const ref = { nom: 'main (abc1234)', base: { a: 3, b: 1 } };
  const lire = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));

  it('R9 — une base du lot plus haute que celle du départ (valeur montée à la main, clé neuve) est refusée même si la mesure la respecte', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify({ a: 5, b: 1 }));
    const r = appliquer(dir, 'verifier', { a: 5, b: 1 }, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('a : 3 → 5');
    expect(r.texte).toContain('main (abc1234)');
    writeFileSync(join(dir, BASELINE), JSON.stringify({ a: 3, b: 1, c: 1 }));
    expect(appliquer(dir, 'ecrire', { a: 3, b: 1, c: 1 }, ref).code).toBe(1);
    expect(lire(dir)).toEqual({ a: 3, b: 1, c: 1 });
  });

  it('R9 — une base égale ou plus basse que celle du départ passe ; --init ne recrée pas une base qui existait au départ', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify({ a: 2 }));
    expect(appliquer(dir, 'verifier', { a: 2 }, ref).code).toBe(0);
    const sans = tempDir();
    const r = appliquer(sans, 'init', { a: 99 }, ref);
    expect(r.code).toBe(2);
    expect(existsSync(join(sans, BASELINE))).toBe(false);
    expect(appliquer(sans, 'init', { a: 99 }, { nom: 'main', base: null }).code).toBe(0);
  });

  it('R9 — lireRef lit la base au merge-base, la dit absente quand elle n\'y existait pas, et échoue sur une référence inconnue', () => {
    const dir = tempDir();
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x'), '1');
    git('add', 'x');
    git('commit', '-q', '-m', 'un');
    expect(lireRef(dir, 'main').base).toBeNull();
    writeFileSync(join(dir, BASELINE), '{"a":3}');
    git('add', BASELINE);
    git('commit', '-q', '-m', 'base');
    git('switch', '-q', '-c', 'lot');
    writeFileSync(join(dir, BASELINE), '{"a":9}');
    git('commit', '-q', '-am', 'monte');
    expect(lireRef(dir, 'main').base).toEqual({ a: 3 });
    expect(() => lireRef(dir, 'inconnue')).toThrow(/introuvable/);
  });

  it('R9 — le CLI avec --contre échoue (code 1) quand la base du lot dépasse celle du départ', () => {
    const dir = tempDir();
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    // jscpd n'écrit son rapport que s'il a lu assez de code
    const corps = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join('\n');
    writeFileSync(join(dir, 'src/cli.ts'), `${corps}\n`);
    writeFileSync(join(dir, BASELINE), '{}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'départ');
    git('switch', '-q', '-c', 'lot');
    // src/cli.ts est une entrée de knip : c'est un fichier que personne n'importe qui est du code mort
    writeFileSync(join(dir, 'src/mort.ts'), `${corps}\nexport const mort = 1;\n`);
    const qualite = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    const d = qualite('--contre', 'main');
    expect(d.stderr).toContain('knip|src/mort.ts|files');
    expect(d.status).toBe(1);
    // la « réparation » : réécrire la base à la mesure du lot
    rmSync(join(dir, BASELINE));
    expect(qualite('--init').status).toBe(0);
    const triche = qualite('--contre', 'main');
    expect(triche.status).toBe(1);
    expect(triche.stderr).toContain('remonte');
  });
});

describe('L462 — déplacer ou découper un fichier de la base', () => {
  const gros = { 'eslint|src/gros.ts|max-lines': 1, 'eslint|src/gros.ts|max-lines|total': 3047, 'eslint|src/cli.ts|max-lines': 1, 'eslint|src/cli.ts|max-lines|total': 450 };
  const existait = (c: string) => c === 'src/gros.ts' || c === 'src/cli.ts';
  const trois = { 'eslint|src/cli.ts|max-lines': 1, 'eslint|src/cli.ts|max-lines|total': 450, ...Object.fromEntries(['a', 'b', 'c'].flatMap((n) => [[`eslint|src/${n}.ts|max-lines`, 1], [`eslint|src/${n}.ts|max-lines|total`, 1000]])) };
  const lire = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));

  it('R10 — découper un fichier de 3047 lignes en trois de 1000 : les chemins neufs partent libres tant que le total par mesure ne monte pas', () => {
    expect(comparer(gros, trois).pires.length).toBeGreaterThan(0);
    expect(comparerMigration(gros, trois, existait)).toEqual([]);
  });

  it('R10 — une migration ne cache pas une hausse : le total qui monte, ou une clé d\'un fichier qui existait qui monte, est refusé', () => {
    const plus = { ...trois, 'eslint|src/d.ts|max-lines': 1, 'eslint|src/d.ts|max-lines|total': 1000 };
    expect(comparerMigration(gros, plus, existait).map((p) => p.cle)).toEqual(['eslint|max-lines|total (total, tous fichiers)']);
    const deplace = { ...gros, 'eslint|src/gros.ts|max-lines|total': 2500, 'eslint|src/cli.ts|max-lines|total': 900 };
    expect(comparerMigration(gros, deplace, existait).map((p) => p.cle)).toEqual(['eslint|src/cli.ts|max-lines|total']);
    expect(comparerMigration(gros, { ...gros, 'knip|src/x.ts|files': 1 }, existait).map((p) => p.cle)).toEqual(['knip|files (total, tous fichiers)']);
  });

  it('R10 — --migrer réécrit la base pour la mesure d\'un découpage, refuse une hausse (base intacte) et refuse sans --contre', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), JSON.stringify(gros));
    const ref = { nom: 'main (abc1234)', base: gros, existe: existait };
    expect(appliquer(dir, 'migrer', trois, null).code).toBe(2);
    expect(appliquer(dir, 'migrer', { ...trois, 'eslint|src/d.ts|max-lines|total': 5000 }, ref).code).toBe(1);
    expect(lire(dir)).toEqual(gros);
    expect(appliquer(dir, 'migrer', trois, ref).code).toBe(0);
    expect(lire(dir)).toEqual(trois);
  });

  it('R10 — la base migrée passe la comparaison au point de départ ; la même base avec un total en hausse non', () => {
    const dir = tempDir();
    const ref = { nom: 'main (abc1234)', base: gros, existe: existait };
    writeFileSync(join(dir, BASELINE), JSON.stringify(trois));
    expect(appliquer(dir, 'verifier', trois, ref).code).toBe(0);
    const truque = { ...trois, 'eslint|src/a.ts|max-lines|total': 1200 };
    writeFileSync(join(dir, BASELINE), JSON.stringify(truque));
    expect(appliquer(dir, 'verifier', truque, ref).code).toBe(1);
  });

  it('R10 — le CLI : un fichier découpé en dépôt réel passe par --migrer --contre, puis la porte est verte', () => {
    const dir = tempDir();
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    const qualite = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    const corps = (n: number, depart = 0) => Array.from({ length: n }, (_, i) => `  x += ${depart + i};`).join('\n');
    const fichier = (nom: string, n: number, depart = 0) => `export function ${nom}(): number {\n  let x = 0;\n${corps(n, depart)}\n  return x;\n}\n`;
    // jscpd n'écrit pas de rapport sans doublon : b.ts en porte un, copié dans cli.ts
    const copie = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join('\n');
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    writeFileSync(join(dir, 'src/cli.ts'), `import { a } from './gros.js';\nimport { b } from './b.js';\nconsole.log(a(), b());\n${copie}\n`);
    writeFileSync(join(dir, 'src/gros.ts'), fichier('a', 1000));
    writeFileSync(join(dir, 'src/b.ts'), `export const b = (): number => 1;\n${copie}\n`);
    const init = qualite('--init');
    expect(init.stderr).toBe('');
    git('add', 'src', '.jscpd.json', 'eslint.config.mjs', 'knip.json', 'package.json', BASELINE);
    git('commit', '-q', '-m', 'départ');
    git('switch', '-q', '-c', 'lot');
    // découpage : gros.ts (1000 lignes) devient gros.ts (450) et a2.ts (450, neuf, lui aussi au-dessus du seuil)
    writeFileSync(join(dir, 'src/gros.ts'), fichier('a', 450));
    writeFileSync(join(dir, 'src/a2.ts'), fichier('a2', 450, 5000));
    writeFileSync(join(dir, 'src/cli.ts'), "import { a } from './gros.js';\nimport { a2 } from './a2.js';\nimport { b } from './b.js';\nconsole.log(a(), a2(), b());\n");
    const avant = qualite('--contre', 'main');
    expect(avant.status).toBe(1);
    expect(avant.stderr).toContain('eslint|src/a2.ts|max-lines');
    expect(qualite('--migrer', '--contre', 'main').status).toBe(0);
    expect(qualite('--contre', 'main').status).toBe(0);
    // le total remonte (le fichier neuf grossit) : la mesure dépasse la base migrée, et une nouvelle migration refuse
    writeFileSync(join(dir, 'src/a2.ts'), fichier('a2', 1200, 5000));
    expect(qualite('--contre', 'main').status).toBe(1);
    const refus = qualite('--migrer', '--contre', 'main');
    expect(refus.status).toBe(1);
    expect(refus.stderr).toContain('max-lines');
    expect(qualite('--migrer').status).toBe(2);
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
    expect(base['eslint|src/gros.ts|max-lines|total']).toBeGreaterThan(400);
    expect(qualite(dir).status).toBe(0);

    writeFileSync(join(dir, 'src/gros.ts'), gros(500));
    const pire = qualite(dir);
    expect(pire.status).toBe(1);
    expect(pire.stderr).toContain('src/gros.ts|max-lines|total');

    writeFileSync(join(dir, 'src/gros.ts'), gros(410));
    expect(qualite(dir).status).toBe(0);
    expect(qualite(dir, '--ecrire').status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'))['eslint|src/gros.ts|max-lines|total']).toBeLessThan(base['eslint|src/gros.ts|max-lines|total']);
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

describe('L462 — le cliquet ne se contourne ni par une directive ni par un seuil relevé', () => {
  const lire = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));

  it('R11 — une config (eslint.config.mjs, knip.json, .jscpd.json) changée par rapport au départ est refusée sous --contre, intacte elle passe', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), '{}');
    writeFileSync(join(dir, 'eslint.config.mjs'), 'max: 4000');
    const ref = { nom: 'main (abc1234)', base: {}, config: (f: string) => (f === 'eslint.config.mjs' ? 'max: 400' : null) };
    const r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('eslint.config.mjs');
    expect(r.texte).toContain('main (abc1234)');
    writeFileSync(join(dir, 'eslint.config.mjs'), 'max: 400');
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
    // le lot qui adopte les outils (pas de base au départ) introduit ses configs librement : rien n'est encore jugé par elles
    expect(appliquer(dir, 'verifier', {}, { nom: 'main', base: null, config: () => null }).code).toBe(0);
  });

  it('R11 — tout fichier de config que les outils lisent est comparé au départ : eslint.config.js (lu AVANT .mjs), .knip.json, knip.config.ts, package.json#jscpd / #knip, .gitignore', () => {
    const dir = tempDir();
    writeFileSync(join(dir, BASELINE), '{}');
    writeFileSync(join(dir, 'eslint.config.mjs'), 'max: 400');
    const depart: Record<string, string> = { 'eslint.config.mjs': 'max: 400', 'package.json': '{"name":"p","knip":{"ignore":["a"]}}', '.gitignore': 'dist\n' };
    const ref = { nom: 'main (abc1234)', base: {}, config: (f: string) => depart[f] ?? null };
    writeFileSync(join(dir, 'package.json'), depart['package.json']);
    writeFileSync(join(dir, '.gitignore'), depart['.gitignore']);
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
    // une config qui apparaît alors qu'elle n'était pas au départ change ce que l'outil lit : refusée, nommée comme neuve
    for (const f of ['eslint.config.js', 'eslint.config.ts', '.knip.json', 'knip.jsonc', 'knip.config.ts', 'knip.ts']) {
      writeFileSync(join(dir, f), 'x');
      const r = appliquer(dir, 'verifier', {}, ref);
      expect(r.code, f).toBe(1);
      expect(r.texte).toContain(`${f} (nouveau)`);
      rmSync(join(dir, f));
    }
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
    // package.json : seules les clés `jscpd` et `knip` comptent, le reste du fichier bouge librement
    writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"2","knip":{"ignore":["a"]}}');
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
    writeFileSync(join(dir, 'package.json'), '{"name":"p","knip":{"ignore":["a"]},"jscpd":{"ignore":["src/**"]}}');
    let r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('package.json#jscpd');
    writeFileSync(join(dir, 'package.json'), '{"name":"p","knip":{"ignore":["a","b"]}}');
    r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('package.json#knip');
    writeFileSync(join(dir, 'package.json'), depart['package.json']);
    // .gitignore : jscpd et knip le respectent, y cacher un dossier ferait baisser la mesure
    writeFileSync(join(dir, '.gitignore'), 'dist\nsrc/gros.ts\n');
    r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('.gitignore (modifié)');
    // une config supprimée est refusée aussi
    writeFileSync(join(dir, '.gitignore'), depart['.gitignore']);
    rmSync(join(dir, 'eslint.config.mjs'));
    r = appliquer(dir, 'verifier', {}, ref);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('eslint.config.mjs (supprimé)');
  });

  it('R11 — parcours réel : un eslint.config.js aux seuils relevés, ajouté à côté du .mjs, ne fait pas sortir la porte à 0 sur un code qui grossit', () => {
    const dir = tempDir();
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    const qualite = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    const gros = (n: number) => `export function f(): number {\n  let x = 0;\n${Array.from({ length: n }, (_, i) => `  x += ${i};`).join('\n')}\n  return x;\n}\n`;
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    writeFileSync(join(dir, 'src/cli.ts'), "import { f } from './gros.js';\nconsole.log(f());\n");
    writeFileSync(join(dir, 'src/gros.ts'), gros(450));
    expect(qualite('--init').status).toBe(0);
    git('add', 'src', '.jscpd.json', 'eslint.config.mjs', 'knip.json', 'package.json', BASELINE);
    git('commit', '-q', '-m', 'départ');
    git('switch', '-q', '-c', 'lot');
    writeFileSync(join(dir, 'src/gros.ts'), gros(900));
    expect(qualite('--contre', 'main').status).toBe(1);
    // la triche : ESLint 9 charge eslint.config.js avant eslint.config.mjs ; sans le refus, la mesure retombe à zéro
    writeFileSync(join(dir, 'eslint.config.js'), "export default [{ files: ['src/**/*.ts'], rules: {} }];\n");
    const r = qualite('--contre', 'main');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('eslint.config.js (nouveau)');
  });

  it('R11 — les directives qui désactivent un contrôle (eslint-disable, jscpd:ignore, tag knip) sont comptées par fichier, dans les seuls fichiers que l\'outil concerné analyse : en ajouter fait empirer', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/a.ts'), '/* eslint-disable */\n// eslint-disable-next-line max-depth\n// jscpd:ignore-start\n/** @public */\nexport const a = 1;\n// jscpd:ignore-end\n');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
    // un fichier hors du périmètre d'ESLint et de jscpd (test/) : ses directives n'éteignent rien chez eux, knip seul le lit
    writeFileSync(join(dir, 'test/a.test.ts'), '/* eslint-disable */\n// jscpd:ignore-start\n/** @internal */\nexport const t = 1;\n');
    // le texte « eslint-disable » hors d'un commentaire (une chaîne, une regex, une phrase de commentaire) n'est pas une directive
    writeFileSync(join(dir, 'src/c.ts'), "const re = /eslint-disable/; // ESLint ignore un eslint-disable\nexport const c = String(re);\n");
    const perimetres = { 'eslint-disable': ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'jscpd-ignore': ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'knip-tag': ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts'] };
    const m = lireDirectives(dir, perimetres);
    expect(m).toEqual({ 'directive|src/a.ts|eslint-disable': 2, 'directive|src/a.ts|jscpd-ignore': 2, 'directive|src/a.ts|knip-tag': 1, 'directive|test/a.test.ts|knip-tag': 1 });
    writeFileSync(join(dir, 'src/b.ts'), '// eslint-disable-line\nexport const b = 1;\n');
    expect(comparer(m, lireDirectives(dir, perimetres)).pires.map((p) => p.cle)).toEqual(['directive|src/b.ts|eslint-disable']);
  });

  it('R11 — en dépôt réel, les périmètres sont ceux des outils : une directive dans test/ ou dans un fichier que .jscpd.json ignore n\'est pas comptée pour ESLint ni jscpd', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    // jscpd n'écrit son rapport que s'il a lu assez de code
    const corps = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join('\n');
    writeFileSync(join(dir, 'src/cli.ts'), `import { f } from './gros.js';\n// jscpd:ignore-start\nconsole.log(f());\n// jscpd:ignore-end\n${corps}\n`);
    writeFileSync(join(dir, 'src/gros.ts'), '/** @public */\nexport const f = (): number => 1;\n');
    writeFileSync(join(dir, 'test/x.test.ts'), '/* eslint-disable */\n// jscpd:ignore-start\n/** @internal */\nexport const t = 1;\n');
    const qualite = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    expect(qualite('--init').status).toBe(0);
    const base = JSON.parse(readFileSync(join(dir, BASELINE), 'utf8'));
    const directives = Object.keys(base).filter((k) => k.startsWith('directive|'));
    expect(directives).toEqual(['directive|src/cli.ts|jscpd-ignore', 'directive|src/gros.ts|knip-tag', 'directive|test/x.test.ts|knip-tag']);
  });

  it('R11 — --init amorce la base même si elle existe, quand le point de départ n\'en a pas (main sans base : le lot rebasé la re-mesure) ; jamais quand il en a une', () => {
    const dir = tempDir();
    appliquer(dir, 'init', { a: 1 });
    expect(appliquer(dir, 'init', { a: 9 }, { nom: 'main', base: { a: 1 } }).code).toBe(2);
    expect(lire(dir)).toEqual({ a: 1 });
    const r = appliquer(dir, 'init', { a: 9 }, { nom: 'main (abc1234)', base: null });
    expect(r.code).toBe(0);
    expect(lire(dir)).toEqual({ a: 9 });
  });

  it('R11 — parcours réel : un /* eslint-disable */ ajouté en tête d\'un fichier trop gros ne fait plus baisser la mesure', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    for (const f of ['eslint.config.mjs', 'knip.json']) cpSync(join(REPO, f), join(dir, f));
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(join(REPO, '.jscpd.json'), 'utf8').replace(/"path": \[[^\]]*\]/, '"path": ["src"]'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","type":"module"}\n');
    const corps = Array.from({ length: 450 }, (_, i) => `  x += ${i};`).join('\n');
    const gros = (tete: string) => `${tete}export function f(): number {\n  let x = 0;\n${corps}\n  return x;\n}\n`;
    writeFileSync(join(dir, 'src/cli.ts'), "import { f } from './gros.js';\nconsole.log(f());\n");
    writeFileSync(join(dir, 'src/gros.ts'), gros(''));
    const qualite = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts/qualite.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    expect(qualite('--init').status).toBe(0);
    writeFileSync(join(dir, 'src/gros.ts'), gros('/* eslint-disable */\n'));
    const r = qualite();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/directive\|src\/gros\.ts\|eslint-disable|eslint\|src\/gros\.ts\|analyse/);
  });
});
