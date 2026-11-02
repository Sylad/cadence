import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, mesurer } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

/** Un dossier avec une base vide, et un point de départ dont `depart` donne le contenu des fichiers (et `fichiers` la liste suivie). */
function lot(depart: Record<string, string>, fichiers?: string[]) {
  const dir = tempDir();
  writeFileSync(join(dir, BASELINE), '{}');
  for (const [f, contenu] of Object.entries(depart)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), contenu);
  }
  const ref = { nom: 'main (abc1234)', base: {}, config: (f: string) => depart[f] ?? null, fichiers: () => fichiers ?? Object.keys(depart) };
  return { dir, ref, verifier: () => appliquer(dir, 'verifier', {}, ref) };
}

describe('L479 — le cliquet surveille tout ce que lisent ESLint, knip et jscpd', () => {
  it('R1 — un .gitignore imbriqué (src/.gitignore) neuf, modifié ou supprimé est refusé, intact il passe', () => {
    const { dir, verifier } = lot({ 'src/.gitignore': 'a\n' });
    expect(verifier().code).toBe(0);
    writeFileSync(join(dir, 'src/.gitignore'), 'a\ngros.ts\n');
    let r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/.gitignore (modifié)');
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/.gitignore'), 'a\n');
    writeFileSync(join(dir, 'test/.gitignore'), 'x\n');
    r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('test/.gitignore (nouveau)');
  });

  it('R1 — un .gitignore imbriqué supprimé (connu du seul point de départ) est refusé, et node_modules n\'est pas parcouru', () => {
    const { dir, ref } = lot({}, ['src/.gitignore']);
    const avec = { ...ref, config: (f: string) => (f === 'src/.gitignore' ? 'a\n' : null) };
    const r = appliquer(dir, 'verifier', {}, avec);
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/.gitignore (supprimé)');
    mkdirSync(join(dir, 'node_modules/p'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/p/.gitignore'), 'x\n');
    expect(appliquer(dir, 'verifier', {}, ref).code).toBe(0);
  });

  it('R2 — vitest.config.*, vite.config.* et tsconfig.json (knip les lit) : neuf, modifié ou supprimé est refusé', () => {
    const { dir, verifier } = lot({ 'tsconfig.json': '{"include":["src"]}', 'vitest.config.ts': 'a' });
    expect(verifier().code).toBe(0);
    writeFileSync(join(dir, 'tsconfig.json'), '{"include":["src"],"exclude":["src/gros.ts"]}');
    expect(verifier().texte).toContain('tsconfig.json (modifié)');
    writeFileSync(join(dir, 'tsconfig.json'), '{"include":["src"]}');
    writeFileSync(join(dir, 'vitest.config.ts'), 'b');
    expect(verifier().texte).toContain('vitest.config.ts (modifié)');
    writeFileSync(join(dir, 'vitest.config.ts'), 'a');
    for (const f of ['vitest.config.mts', 'vitest.config.js', 'vitest.workspace.ts', 'vite.config.ts', 'vite.config.mjs']) {
      writeFileSync(join(dir, f), 'x');
      const r = verifier();
      expect(r.code, f).toBe(1);
      expect(r.texte).toContain(`${f} (nouveau)`);
      spawnSync('rm', [join(dir, f)]);
    }
    expect(verifier().code).toBe(0);
  });

  it('R3 — package.json : les clés scripts, main, bin et exports comptent aussi (knip y trouve ses points d\'entrée) ; le reste bouge librement', () => {
    const depart = '{"name":"p","version":"1","scripts":{"t":"vitest"},"main":"a.js","bin":{"p":"b.js"},"exports":{".":"a.js"}}';
    const { dir, verifier } = lot({ 'package.json': depart });
    expect(verifier().code).toBe(0);
    writeFileSync(join(dir, 'package.json'), depart.replace('"1"', '"2"'));
    expect(verifier().code).toBe(0);
    for (const [cle, change] of [
      ['scripts', depart.replace('vitest', 'vitest --passWithNoTests')],
      ['main', depart.replace('a.js"', 'c.js"')],
      ['bin', depart.replace('b.js', 'd.js')],
      ['exports', depart.replace('"."', '"./x"')],
    ]) {
      writeFileSync(join(dir, 'package.json'), change);
      const r = verifier();
      expect(r.code, cle).toBe(1);
      expect(r.texte).toContain(`package.json#${cle} (modifié)`);
    }
    // une clé retirée ou ajoutée alors qu'elle n'y était pas
    writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"1"}');
    expect(verifier().texte).toContain('package.json#bin (supprimé)');
    writeFileSync(join(dir, 'package.json'), '{not json');
    expect(verifier().code).toBe(1);
  });
});

const tempDirAvecBase = () => lot({}).dir;

describe('L479 — .git/info/exclude et outil absent', () => {
  it('R4 — un .git/info/exclude non vide est signalé (avertissement, sans refus) ; vide ou réduit à des commentaires, il ne dit rien', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    const exclude = join(dir, '.git/info/exclude');
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(exclude, '# For a list of patterns\n\n');
    expect(appliquer(dir, 'verifier', {}).texte).not.toContain('info/exclude');
    writeFileSync(exclude, '# commentaire\nsrc/gros.ts\n');
    const r = appliquer(dir, 'verifier', {});
    expect(r.code).toBe(0);
    expect(r.texte).toContain('.git/info/exclude');
    expect(r.texte).toContain('src/gros.ts');
    // un refus le porte aussi
    writeFileSync(join(dir, BASELINE), '{"a":1}');
    const refus = appliquer(dir, 'verifier', { a: 2 });
    expect(refus.code).toBe(1);
    expect(refus.texte).toContain('info/exclude');
  });

  it('R4 — dans un worktree, git rend un chemin absolu de .git/info/exclude : il est lu aussi', () => {
    const dir = gitRepo();
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'a');
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/exclude'), 'src/gros.ts\n');
    const arbre = join(tempDir(), 'wt');
    run('worktree', 'add', '-q', '--detach', arbre);
    writeFileSync(join(arbre, BASELINE), '{}');
    expect(appliquer(arbre, 'verifier', {}).texte).toContain('src/gros.ts');
  });

  it('R4 — la liste est tronquée à trois motifs avec le nombre des autres', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, BASELINE), '{}');
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/exclude'), 'a\nb\nc\nd\ne\n');
    const { texte } = appliquer(dir, 'verifier', {});
    expect(texte).toContain('(a, b, c, … 2 autre(s))');
  });

  it('R4 — hors dépôt git, ou sans fichier exclude, rien n\'est signalé et rien ne plante', () => {
    const dir = tempDirAvecBase();
    expect(appliquer(dir, 'verifier', {}).texte).not.toContain('exclude');
  });

  it('R5 — un outil absent de node_modules dit « npm install », pas « Unexpected end of JSON input » (code 2 au CLI)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{"name":"p"}');
    expect(() => mesurer(dir)).toThrow(/npm install/);
    expect(() => mesurer(dir)).toThrow(/eslint/);
    writeFileSync(join(dir, BASELINE), '{}');
    const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/qualite.mjs')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npm install');
    expect(r.stderr).not.toContain('Unexpected end');
  });
});
