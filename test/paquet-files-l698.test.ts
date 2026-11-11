import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';

// L698 (D-14, erreur 2 du relevé du 10-11) : 2.0.0 et 2.0.1 publiées sans un fichier que le code lit ; npm se tait sur un chemin de
// `files` qui n'existe pas et sur un `bin` que `files` ne couvre pas. Test statique du champ `files` de package.json : chaque chemin
// déclaré existe après le build (dist/, v2/dist/ compris), et chaque `bin` déclaré est sous un chemin de `files`.
const root = join(import.meta.dirname, '..');
type Pkg = { name?: string; files?: string[]; bin?: string | Record<string, string> };

const net = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
const estMotif = (p: string) => /[*?[\]{}]/.test(p);
const bins = (pkg: Pkg): [string, string][] =>
  typeof pkg.bin === 'string' ? [[String(pkg.name ?? 'bin').replace(/^@[^/]+\//, ''), pkg.bin]] : Object.entries(pkg.bin ?? {});

/** Les écarts du champ `files` : un chemin déclaré absent (ou un motif sans correspondance), un bin absent ou hors de `files`. */
export function ecartsFiles(dir: string, pkg: Pkg): string[] {
  const files = (pkg.files ?? []).map(net);
  const out: string[] = [];
  for (const f of files) {
    if (estMotif(f)) {
      if (globSync(f, { cwd: dir }).length === 0) out.push(`files : « ${f} » ne correspond à aucun fichier`);
    } else if (!existsSync(join(dir, f))) out.push(`files : « ${f} » déclaré mais absent (après le build)`);
  }
  const couvre = (f: string, chemin: string) => (estMotif(f) ? globSync(f, { cwd: dir }).map(net).includes(chemin) : chemin === f || chemin.startsWith(`${f}/`));
  for (const [nom, fichier] of bins(pkg)) {
    const chemin = net(fichier);
    if (!existsSync(join(dir, chemin))) out.push(`bin ${nom} : « ${chemin} » n'existe pas`);
    if (files.length > 0 && !files.some((f) => couvre(f, chemin))) out.push(`bin ${nom} : « ${chemin} » n'est couvert par aucun chemin de files`);
  }
  return out;
}

describe('ecartsFiles — ce qu’il voit sur un paquet jouet', () => {
  it('un chemin absent, un motif sans correspondance, un bin absent et un bin hors de files sont des écarts ; un paquet complet n’en a aucun', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'bin/acme.js'), '');
    writeFileSync(join(dir, 'dist/index.js'), '');
    writeFileSync(join(dir, 'outil.js'), '');
    const complet: Pkg = { name: '@x/acme', files: ['bin', 'dist', 'docs/*.md', 'README.md'], bin: { acme: 'bin/acme.js' } };
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/a.md'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(ecartsFiles(dir, complet)).toEqual([]);
    expect(ecartsFiles(dir, { files: ['bin', 'dist', 'v2/dist', 'docs/*.svg'], bin: { acme: 'bin/acme.js', outil: './outil.js', fantome: 'bin/fantome.js' } })).toEqual([
      'files : « v2/dist » déclaré mais absent (après le build)',
      'files : « docs/*.svg » ne correspond à aucun fichier',
      'bin outil : « outil.js » n\'est couvert par aucun chemin de files',
      'bin fantome : « bin/fantome.js » n\'existe pas',
    ]);
    // un `bin` chaîne prend le nom du paquet ; sans `files`, npm publie tout : seul l'existence du bin compte
    expect(ecartsFiles(dir, { name: '@x/acme', bin: 'bin/acme.js' })).toEqual([]);
    expect(ecartsFiles(dir, { name: '@x/acme', bin: 'bin/absent.js' })).toEqual(['bin acme : « bin/absent.js » n\'existe pas']);
  });
});

describe('package.json de cadence : le champ files est juste après le build', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pkg;

  beforeAll(() => {
    // Les sorties du build (dist/, v2/dist/) manquent dans un arbre jamais installé : le build de `prepare` les produit, une fois.
    const batis = (pkg.files ?? []).map(net).filter((f) => /(^|\/)dist$/.test(f));
    if (batis.some((f) => !existsSync(join(root, f)))) execFileSync('npm', ['run', 'prepare'], { cwd: root, stdio: 'ignore', timeout: 180_000 });
  }, 200_000);

  it('chaque chemin déclaré existe, chaque bin existe et est couvert', () => {
    expect(pkg.files?.length ?? 0).toBeGreaterThan(10);
    expect(bins(pkg).map(([n]) => n).sort()).toEqual(['cadence', 'raf']);
    expect(ecartsFiles(root, pkg)).toEqual([]);
  });

  it('les sorties du build sont déclarées (dist/ et v2/dist/, ce que bin/ charge)', () => {
    const files = (pkg.files ?? []).map(net);
    expect(files).toContain('dist');
    expect(files).toContain('v2/dist');
    for (const [, f] of bins(pkg)) expect(readFileSync(join(root, f), 'utf8')).toMatch(/dist\//);
  });
});
