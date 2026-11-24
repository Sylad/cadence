// L826 (issue #73 du compte pro) : un lot `config: true` se juge sur son diff NET depuis son départ, pas commit par commit. Un commit de correction qui
// ramène la doc et le code à leur état de départ suffit ; un lot dont le diff net touche encore autre chose que des configs reste refusé, fichiers nommés.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../scripts/analyse.mjs';
import { appliquer, BASELINE, lireRef, serialiser } from '../scripts/qualite.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
const ecrire = (r: string, f: string, c: string) => { mkdirSync(join(r, f, '..'), { recursive: true }); writeFileSync(join(r, f), c); };
const commit = (r: string, message: string, fichiers: Record<string, string>) => {
  for (const [f, c] of Object.entries(fichiers)) ecrire(r, f, c);
  git(r, 'add', '--', ...Object.keys(fichiers));
  git(r, 'commit', '-qm', message);
};

// Ce que le départ porte hors config : une doc hors docs/ et un module de code, que le commit 1 du lot change et que le commit 2 rétablit
const README = '# projet\n';
const AIDE = 'export const aide = 1;\n';
const PLAN = 'project: p\nlots:\n  - id: L5\n    title: seuils\n    config: true\n  - id: L6\n    title: code\n';

describe('L826 — cadence analyse --contre : un lot config: true jugé sur son diff net', () => {
  // le faux outil de test/analyse-l801.test.ts : une violation `no-todo` par ligne « TODO » des .js de src/
  const OUTIL = `import { readdirSync, readFileSync } from 'node:fs';
console.log(JSON.stringify(readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => ({ filePath: process.cwd() + '/src/' + f,
  messages: readFileSync('src/' + f, 'utf8').split('\\n').filter((l) => l.includes('TODO')).map(() => ({ ruleId: 'no-todo', message: 'todo' })) }))));
`;
  async function cadence(cwd: string, ...argv: string[]) {
    const l: string[] = [];
    const code = await main(argv, { cwd, out: (x) => l.push(x), err: (x) => l.push(x) });
    return { code, sortie: l.join('\n') };
  }
  /** main : l'outil `lint` (configs: [seuils.json]), sa base, le plan où L5 est config: true ; puis une branche sans nom de lot (porte d'un run). */
  async function depot() {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    ecrire(r, 'outil.mjs', OUTIL);
    ecrire(r, 'seuils.json', '{"max":1}\n');
    ecrire(r, 'cadence.yaml', 'analyse:\n  - name: lint\n    command: node outil.mjs\n    format: eslint-json\n    configs: [seuils.json]\n');
    ecrire(r, 'src/a.js', 'x // TODO\n');
    ecrire(r, 'README.md', README);
    ecrire(r, 'lib/aide.mjs', AIDE);
    ecrire(r, '.cadence/raf.yaml', PLAN);
    expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
    git(r, 'checkout', '-qb', 'cadence/run-1');
    // commit 1 du scénario de l'issue : la config, plus une doc, du code et un test
    commit(r, 'feat(L5): seuils', { 'seuils.json': '{"max":2}\n', 'README.md': `${README}seuils\n`, 'lib/aide.mjs': 'export const aide = 2;\n', 'test/seuils.test.ts': '// t\n' });
    return r;
  }

  it('le commit 1 seul (config + doc + code + test) est refusé, la doc et le code nommés', async () => {
    const r = await depot();
    const { code, sortie } = await cadence(r, '--contre', 'main');
    expect(code).toBe(1);
    expect(sortie).toContain('README.md, lib/aide.mjs : un lot déclaré « config: true » au plan ne touche que les fichiers de config');
  });

  it('un commit 2 qui rétablit la doc et le code (et retire le test) suffit : le diff net ne touche que la config', async () => {
    const r = await depot();
    git(r, 'rm', '-q', 'test/seuils.test.ts');
    commit(r, 'fix(L5): retire la doc et le code', { 'README.md': README, 'lib/aide.mjs': AIDE });
    const { code, sortie } = await cadence(r, '--contre', 'main');
    expect(sortie).not.toContain('ne touche que les fichiers de config');
    expect(code).toBe(0);
  });

  it('un commit 2 qui ne rétablit que la doc laisse le refus, qui ne nomme plus que le fichier du diff net', async () => {
    const r = await depot();
    commit(r, 'fix(L5): retire la doc', { 'README.md': README });
    const { code, sortie } = await cadence(r, '--contre', 'main');
    expect(code).toBe(1);
    expect(sortie).toContain('lib/aide.mjs : un lot déclaré « config: true » au plan ne touche que les fichiers de config');
    expect(sortie).not.toContain('README.md');
  });

  it('un commit 2 qui ramène le fichier à un AUTRE contenu que le départ ne suffit pas', async () => {
    const r = await depot();
    commit(r, 'fix(L5): retire la doc', { 'README.md': README, 'lib/aide.mjs': 'export const aide = 3;\n' });
    expect((await cadence(r, '--contre', 'main')).sortie).toContain('lib/aide.mjs : un lot déclaré « config: true »');
  });
});

describe('L826 — cliquet qualité (scripts/qualite.mjs, voie L824) : la même lecture nette', () => {
  const DEPART = { 'eslint|src/a.ts|regle': 1 };
  const SOMMET = { 'eslint|src/a.ts|regle': 3 };
  const A = 'export const a = 1;\n';
  const regle = 'export default [{ rules: { regle: "error" } }];\n';
  function depot() {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    ecrire(r, BASELINE, serialiser(DEPART));
    ecrire(r, 'src/a.ts', A);
    ecrire(r, 'README.md', README);
    ecrire(r, 'eslint.config.mjs', 'export default [];\n');
    ecrire(r, '.cadence/raf.yaml', PLAN.replace(/L5/g, 'L1').replace(/L6/g, 'L2'));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'depart');
    git(r, 'checkout', '-qb', 'cadence/run-1');
    return { r, verifier: () => appliquer(r, 'verifier', SOMMET, lireRef(r, 'main')) };
  }

  it('commit 1 config + doc + code + test, commit 2 qui les défait : la hausse à la mesure exacte est acceptée', () => {
    const { r, verifier } = depot();
    commit(r, 'feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET), 'README.md': `${README}règle\n`, 'src/a.ts': 'export const a = 2;\n', 'test/r.test.ts': '// t\n' });
    expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('README.md, src/a.ts : un lot déclaré « config: true »') });
    git(r, 'rm', '-q', 'test/r.test.ts');
    commit(r, 'fix(L1): retire la doc et le code', { 'README.md': README, 'src/a.ts': A });
    expect(verifier()).toMatchObject({ code: 0 });
    expect(readFileSync(join(r, BASELINE), 'utf8')).toBe(serialiser(SOMMET));
  });

  it('un commit de code d’un autre lot, défait par un retour arrière, ne ferme plus la voie', () => {
    const { r, verifier } = depot();
    commit(r, 'feat(L2): code', { 'src/b.ts': 'export const b = 1;\n' });
    git(r, 'revert', '--no-edit', 'HEAD');
    commit(r, 'feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
    expect(verifier()).toMatchObject({ code: 0 });
  });

  it('un commit de code d’un autre lot qui reste dans le diff net ferme toujours la voie', () => {
    const { r, verifier } = depot();
    commit(r, 'feat(L2): code', { 'src/b.ts': 'export const b = 1;\n' });
    commit(r, 'feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
    expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
  });
});
