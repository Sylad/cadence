// L811 (issue #72) : `cadence analyse --contre origin/main` sur la CI d'un push à main comparait chaque base à elle-même (origin/main = le commit poussé) ;
// une violation nouvelle commitée avec sa base relevée à la main passait. La recette CI de docs/analyse.md compare au commit d'avant le push, et la commande
// refuse un départ égal à HEAD quand HEAD relève une base.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main, SCRIPT } from '../scripts/analyse.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
async function cadence(cwd: string, ...argv: string[]): Promise<{ code: number; sortie: string }> {
  const l: string[] = [];
  const code = await main(argv, { cwd, out: (x) => l.push(x), err: (x) => l.push(x) });
  return { code, sortie: l.join('\n') };
}

// Le faux outil d'analyse-l801.test.ts : une violation `no-todo` par ligne « TODO » des fichiers src/*.js (format eslint-json).
const OUTIL = `import { readdirSync, readFileSync } from 'node:fs';
const fichiers = readdirSync('src').filter((f) => f.endsWith('.js'));
console.log(JSON.stringify(fichiers.map((f) => ({ filePath: process.cwd() + '/src/' + f,
  messages: readFileSync('src/' + f, 'utf8').split('\\n').filter((l) => l.includes('TODO')).map(() => ({ ruleId: 'no-todo', message: 'todo' })) }))));
`;
const BASE = '.cadence/analyse/lint.json';
const ZEROS = '0'.repeat(40);

/** main : src/a.js à deux violations, gelées dans la base ; origin/main suit main (comme après un push). */
async function depot(): Promise<string> {
  const r = tempDir();
  git(r, 'init', '-q', '-b', 'main');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'outil.mjs'), OUTIL);
  writeFileSync(join(r, 'cadence.yaml'), 'analyse:\n  - name: lint\n    command: node outil.mjs\n    format: eslint-json\n');
  writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz\n');
  expect((await cadence(r, '--init')).code).toBe(0);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return r;
}
const commit = (r: string, msg: string) => { git(r, 'add', '-A'); git(r, 'commit', '-qm', msg); };
/** Le cas de l'issue : une violation nouvelle et la base relevée à la main pour la couvrir, dans le même commit, poussé sur main. */
function violationEtBaseRelevee(r: string) {
  writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
  writeFileSync(join(r, BASE), JSON.stringify({ 'src/a.js|no-todo': 3, 'src/a.js|no-todo|total': 3 }));
  commit(r, 'violation et base relevée');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

/** Le bloc `run: |` de la recette CI de docs/analyse.md, tel qu'écrit, `npx cadence analyse` remplacé par ce script. */
function recette(): string {
  const doc = readFileSync('docs/analyse.md', 'utf8');
  const section = doc.slice(doc.indexOf('## The CI recipe'), doc.indexOf('## Recipe per technology'));
  const bloc = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(section);
  expect(bloc, 'bloc run: | de la recette CI').not.toBeNull();
  const script = bloc![1].split('\n').map((l) => l.slice(10)).join('\n');
  expect(script).toContain('npx cadence analyse');
  return script.replace('npx cadence analyse', `node ${JSON.stringify(SCRIPT)}`);
}
const jouer = (r: string, env: { AVANT: string; DEFAUT?: string }) => {
  const p = spawnSync('bash', ['-e', '-c', recette()], { cwd: r, encoding: 'utf8', env: { ...process.env, DEFAUT: 'main', ...env } });
  return { code: p.status, sortie: `${p.stdout}${p.stderr}` };
};

describe('L811 — --contre dont le départ est HEAD', () => {
  it('le cas de l\'issue : rouge contre origin/main = HEAD (refus nommé), contre HEAD, et contre le parent (la base remonte)', async () => {
    const r = await depot();
    violationEtBaseRelevee(r);
    expect((await cadence(r)).code).toBe(0); // la mesure seule est tenue par la base relevée : c'est le trou
    for (const ref of ['origin/main', 'HEAD']) {
      const refus = await cadence(r, '--contre', ref);
      expect(refus.code).toBe(1);
      expect(refus.sortie).toContain(`--contre ${ref} désigne le commit jugé lui-même`);
      expect(refus.sortie).toContain('src/a.js|no-todo : 2 → 3');
      expect(refus.sortie).toContain('github.event.before');
    }
    const parent = await cadence(r, '--contre', 'HEAD~1');
    expect(parent.code).toBe(1);
    expect(parent.sortie).toContain('remonte par rapport à HEAD~1');
  });

  it('pas de faux refus : un commit qui baisse la base ou ne la touche pas passe contre HEAD', async () => {
    const r = await depot();
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny\nz\n');
    expect((await cadence(r, '--ecrire')).code).toBe(0);
    commit(r, 'baisse');
    expect((await cadence(r, '--contre', 'HEAD')).code).toBe(0);
    writeFileSync(join(r, 'src/b.js'), 'propre\n');
    expect((await cadence(r, '--ecrire')).code).toBe(0);
    commit(r, 'fichier propre');
    expect((await cadence(r, '--contre', 'HEAD')).code).toBe(0);
    // départ égal à HEAD sans base relevée : une violation non commitée reste jugée contre la base
    writeFileSync(join(r, 'src/b.js'), 'propre // TODO\n');
    expect((await cadence(r, '--contre', 'HEAD')).code).toBe(1);
  });
});

describe('L811 — une base née dans HEAD', () => {
  it('jugée contre HEAD, elle est dite sans refus (un lot vide après l\'adoption reste vert) ; contre le parent, elle est tenue à sa mesure', async () => {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src'));
    writeFileSync(join(r, 'outil.mjs'), OUTIL);
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\n');
    commit(r, 'avant l\'outil');
    writeFileSync(join(r, 'cadence.yaml'), 'analyse:\n  - name: lint\n    command: node outil.mjs\n    format: eslint-json\n');
    mkdirSync(join(r, '.cadence/analyse'), { recursive: true });
    writeFileSync(join(r, BASE), JSON.stringify({ 'src/a.js|no-todo': 5, 'src/a.js|no-todo|total': 5 })); // écrite à la main, au-dessus de la mesure
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'adoption', '-m', 'Analyse-adoption: lint');
    const dit = await cadence(r, '--contre', 'HEAD');
    expect(dit.code).toBe(0);
    expect(dit.sortie).toContain('ligne(s) de base née(s) dans ce commit');
    expect(dit.sortie).toContain(BASE);
    const parent = await cadence(r, '--contre', 'HEAD~1');
    expect(parent.code).toBe(1);
    expect(parent.sortie).toContain('différente de la mesure');
  });
});

describe('L811 — la recette CI de docs/analyse.md, jouée telle qu\'écrite', () => {
  it('push : rouge contre github.event.before ; vert pour un commit propre', async () => {
    const r = await depot();
    const avant = git(r, 'rev-parse', 'HEAD');
    violationEtBaseRelevee(r);
    const rouge = jouer(r, { AVANT: avant });
    expect(rouge.code).toBe(1);
    expect(rouge.sortie).toContain('remonte par rapport à');
    const r2 = await depot();
    const avant2 = git(r2, 'rev-parse', 'HEAD');
    writeFileSync(join(r2, 'src/b.js'), 'propre\n');
    expect((await cadence(r2, '--ecrire')).code).toBe(0);
    commit(r2, 'propre');
    expect(jouer(r2, { AVANT: avant2 }).code).toBe(0);
  });

  it('replis : before à 0000… ou absent du dépôt, et lancement manuel (vide) sur main → le parent ; sur une autre branche → la branche par défaut', async () => {
    const r = await depot();
    violationEtBaseRelevee(r);
    for (const AVANT of [ZEROS, '', 'deadbeef'.repeat(5)]) {
      const p = jouer(r, { AVANT });
      expect(p.code, `AVANT=${AVANT}`).toBe(1);
      expect(p.sortie).toContain('remonte par rapport à');
    }
    const b = await depot();
    git(b, 'checkout', '-qb', 'nouvelle');
    violationEtBaseRelevee(b);
    git(b, 'update-ref', 'refs/remotes/origin/main', 'main');
    const p = jouer(b, { AVANT: ZEROS });
    expect(p.code).toBe(1);
    expect(p.sortie).toContain('remonte par rapport à origin/main');
  });

  it('la doc avertit que .cadence/analyse/** ne doit pas être dans paths-ignore', () => {
    const doc = readFileSync('docs/analyse.md', 'utf8');
    expect(doc).toMatch(/Never put\s+`\.cadence\/analyse\/\*\*`[\s\S]{0,80}in `paths-ignore`/);
    expect(doc).not.toContain('npx cadence analyse --contre origin/main');
  });
});
