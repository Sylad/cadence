// L801, revue r2 — M1' : adopter un outil dans un lot ordinaire (manifeste de dépendances compris, sans plan natif), par une adoption déclarée dans un commit
// que la porte vérifie et affiche ; la recette de docs/analyse.md est jouée telle qu'écrite, avec le vrai ESLint 9 et le vrai tsc. M3' : toute directive que
// l'outil honore est comptée, quelle que soit la mise en forme du commentaire — vérifié contre les vrais outils, pas contre nos motifs.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lireDirectives, main, SCRIPT } from '../scripts/analyse.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const CADENCE = resolve(dirname(SCRIPT), '..');
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
async function cadence(cwd: string, ...argv: string[]): Promise<{ code: number; sortie: string }> {
  const l: string[] = [];
  const code = await main(argv, { cwd, out: (x) => l.push(x), err: (x) => l.push(x) });
  return { code, sortie: l.join('\n') };
}

// ── M1' : l'adoption déclarée ─────────────────────────────────────────────────────────────────────────────────────────────────

// Le faux outil de test/analyse-l801.test.ts : une violation `no-todo` par ligne « TODO » des .js de src/.
const OUTIL = `import { readdirSync, readFileSync } from 'node:fs';
console.log(JSON.stringify(readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => ({ filePath: process.cwd() + '/src/' + f,
  messages: readFileSync('src/' + f, 'utf8').split('\\n').filter((l) => l.includes('TODO')).map(() => ({ ruleId: 'no-todo', message: 'todo' })) }))));
`;
const ENTREE = (nom: string, plus = '') => `  - name: ${nom}\n    command: node outil.mjs\n    format: eslint-json\n${plus}`;

/** Un dépôt sans plan (ou au plan tenu par un autre outil) ; main porte `depart` comme clé analyse: (avec la base de chaque outil), puis une branche de lot ordinaire. */
async function depot(depart = ''): Promise<string> {
  const r = tempDir();
  git(r, 'init', '-q', '-b', 'main');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'outil.mjs'), OUTIL);
  writeFileSync(join(r, 'package.json'), '{ "name": "p", "devDependencies": {} }\n');
  writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz\n');
  writeFileSync(join(r, 'cadence.yaml'), `plan: { file: jira.csv, format: csv }\n${depart ? `analyse:\n${depart}` : ''}`);
  if (depart) expect((await cadence(r, '--init')).code).toBe(0);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  git(r, 'checkout', '-qb', 'cadence/run-20261121-1');
  return r;
}
const ajouter = (r: string, texte: string) => writeFileSync(join(r, 'cadence.yaml'), `${readFileSync(join(r, 'cadence.yaml'), 'utf8')}${texte}`);

describe('L801 r2 M1\' — une ligne de base naît dans un lot ordinaire par une adoption déclarée, vérifiée et affichée', () => {
  it('le lot touche le manifeste de dépendances et du code ; sans la ligne Analyse-adoption la porte refuse et la nomme ; avec, elle passe et le dit', async () => {
    const r = await depot();
    ajouter(r, `analyse:\n${ENTREE('lint')}`);
    writeFileSync(join(r, 'package.json'), '{ "name": "p", "devDependencies": { "lint": "1.0.0" } }\n');
    writeFileSync(join(r, 'src/b.js'), 'neuf\n');
    const avant = await cadence(r, '--init', '--contre', 'main');
    expect(avant.code).toBe(1);
    expect(avant.sortie).toContain('.cadence/analyse/lint.json (nouveau) diffère(nt) de main');
    expect(avant.sortie).toContain('« Analyse-adoption: lint » dans le message d\'un commit du lot');
    expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'chore: adopte lint');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1); // commitée sans déclaration : toujours refusée
    git(r, 'commit', '-q', '--amend', '-m', 'chore: adopte lint', '-m', 'Analyse-adoption: lint');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.sortie.split('\n')).toEqual([
      `analyse : ligne de base neuve : lint (.cadence/analyse/lint.json) — adoption déclarée par le commit ${git(r, 'rev-parse', '--short', 'HEAD')} (Analyse-adoption: lint)`,
      'analyse : lint (.cadence/analyse/lint.json) : rien n\'empire (2 violation(s), 2 gelée(s)).',
    ]);
    expect(porte.code).toBe(0);
    // la base née est un cliquet dès ce lot : une violation de plus est refusée
    writeFileSync(join(r, 'src/b.js'), '// TODO\n');
    expect((await cadence(r, '--contre', 'main')).sortie).toContain('src/b.js|no-todo : 0 → 1');
  });

  it('plusieurs outils sur une ligne, casse et espaces libres ; un outil non nommé reste refusé ; les configs de l\'outil adopté sont libres dans ce lot', async () => {
    const r = await depot();
    writeFileSync(join(r, 'seuils.json'), '{"max":1}\n');
    ajouter(r, `analyse:\n${ENTREE('lint', '    configs: [seuils.json]\n')}${ENTREE('lint-b')}${ENTREE('lint-c')}`);
    expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'chore: adopte\n\nUn corps.\nanalyse-adoption:  lint,lint-b\n');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('cadence.yaml#analyse.lint-c (nouveau), .cadence/analyse/lint-c.json (nouveau) diffère(nt) de main');
    expect(refus.sortie).not.toContain('lint-b.json');
    expect(refus.sortie).not.toContain('seuils.json');
    expect(refus.sortie).toContain('« Analyse-adoption: lint-c »');
    git(r, 'commit', '-q', '--allow-empty', '-m', 'chore: et lint-c\n\nAnalyse-adoption: lint-c');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.code).toBe(0);
    expect(porte.sortie.match(/ligne de base neuve/g)).toHaveLength(3);
  });

  it.each([
    ['renommer lint → lint2', (y: string) => y.replace('name: lint', 'name: lint2'), 'cadence.yaml#analyse.lint (supprimé)'],
    ['changer la commande de lint, base déplacée', (y: string) => y.replace('node outil.mjs', 'node outil.mjs || true') + '    baseline: autre/lint.json\n', 'cadence.yaml#analyse.lint (modifié)'],
    ['retirer lint et déclarer un autre outil', (y: string) => y.replace('name: lint', 'name: autre').replace('node outil.mjs', 'echo "[]"'), 'cadence.yaml#analyse.lint (supprimé)'],
  ])('pas de retour à M1 — %s reste refusé, même avec une adoption déclarée du nouveau nom', async (_, changer, attendu) => {
    const r = await depot(ENTREE('lint'));
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
    writeFileSync(join(r, 'cadence.yaml'), changer(readFileSync(join(r, 'cadence.yaml'), 'utf8')));
    await cadence(r, '--init');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: outil changé\n\nAnalyse-adoption: lint, lint2, autre');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain(attendu);
    expect((await cadence(r, '--init', '--contre', 'main')).code).toBe(1);
  });

  it('une adoption ne prend ni la base d\'un outil du départ ni une config qu\'il déclare ; ajoutée à côté, elle laisse l\'outil du départ juger', async () => {
    const r = await depot(ENTREE('lint', '    configs: [seuils.json]\n'));
    writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    ajouter(r, ENTREE('lint2', '    configs: [seuils.json]\n'));
    expect((await cadence(r, '--init', '--outil', 'lint2')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: lint2\n\nAnalyse-adoption: lint2');
    const config = await cadence(r, '--contre', 'main');
    expect(config.code).toBe(1);
    expect(config.sortie).toContain('seuils.json (nouveau) diffère(nt) de main');
    git(r, 'rm', '-q', 'seuils.json'); git(r, 'commit', '-qm', 'feat: sans seuils');
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    const pire = await cadence(r, '--contre', 'main');
    expect(pire.code).toBe(1);
    expect(pire.sortie).toContain('lint (.cadence/analyse/lint.json) : 2 mesure(s) empirent');
  });

  it('un lot « config: true » du plan natif crée toujours une base, et la porte le dit aussi', async () => {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src')); mkdirSync(join(r, '.cadence'));
    writeFileSync(join(r, 'outil.mjs'), OUTIL);
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\n');
    writeFileSync(join(r, '.cadence/raf.yaml'), 'project: p\nlots:\n  - id: L5\n    title: adopter lint\n    config: true\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base'); git(r, 'checkout', '-qb', 'cadence/run--L5');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint')}`);
    expect((await cadence(r, '--init', '--contre', 'main')).sortie).toContain('analyse : ligne de base neuve : lint (.cadence/analyse/lint.json) — lot « config: true » du plan');
  });
});

// ── M1' : la recette de docs/analyse.md, jouée telle qu'écrite ─────────────────────────────────────────────────────────────────

/** Les blocs de code de la recette « TypeScript / JavaScript » de docs/analyse.md, dans l'ordre : [langage, texte]. */
function recette(): [string, string][] {
  const doc = readFileSync(join(CADENCE, 'docs/analyse.md'), 'utf8');
  const section = /\*\*TypeScript \/ JavaScript\.\*\*([\s\S]*?)\n\*\*Python\.\*\*/.exec(doc)?.[1] ?? '';
  return [...section.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map(([, langage, texte]) => [langage, texte]);
}

/**
 * Le seul écart avec la doc : pas de réseau. `npm i -D <paquets>` écrit ce que npm écrit (devDependencies de package.json, package-lock.json) et relie
 * node_modules à celui de cadence, qui a ces trois paquets ; `npx cadence analyse` joue scripts/analyse.mjs (ce que fait bin/cadence.js, qui exige dist/).
 * Tout autre `npx` (eslint, tsc : les commandes des outils) est le vrai.
 */
function fauxNpm(): string {
  const bin = tempDir();
  const vraiNpx = join(dirname(process.execPath), 'npx');
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const { readFileSync, writeFileSync, symlinkSync, existsSync } = require('node:fs');
const [verbe, option, ...paquets] = process.argv.slice(2);
if (verbe !== 'i' || option !== '-D' || !paquets.length) { console.error('faux npm : « npm i -D <paquets> » attendu, reçu ' + process.argv.slice(2).join(' ')); process.exit(64); }
const p = JSON.parse(readFileSync('package.json', 'utf8'));
p.devDependencies = { ...p.devDependencies };
for (const n of paquets) p.devDependencies[n] = '^' + JSON.parse(readFileSync(${JSON.stringify(join(CADENCE, 'node_modules'))} + '/' + n + '/package.json', 'utf8')).version;
writeFileSync('package.json', JSON.stringify(p, null, 2) + '\\n');
writeFileSync('package-lock.json', JSON.stringify({ name: p.name, lockfileVersion: 3, packages: { '': { devDependencies: p.devDependencies } } }, null, 2) + '\\n');
if (!existsSync('node_modules')) symlinkSync(${JSON.stringify(join(CADENCE, 'node_modules'))}, 'node_modules');
`);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash
if [ "$1" = cadence ] && [ "$2" = analyse ]; then shift 2; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} "$@"; fi
exec ${JSON.stringify(vraiNpx)} "$@"
`);
  chmodSync(join(bin, 'npm'), 0o755); chmodSync(join(bin, 'npx'), 0o755);
  return bin;
}

describe('L801 r2 M1\' — la recette TypeScript de docs/analyse.md passe sa porte, dans un lot ordinaire d\'un projet sans plan natif', () => {
  it('npm i -D, config, clé analyse:, --init, commit avec la ligne d\'adoption, puis la commande de la porte : code 0, bases neuves dites', { timeout: 300_000 }, () => {
    const blocs = recette();
    expect(blocs.map(([l]) => l)).toEqual(['sh', 'js', 'yaml', 'sh']);
    const r = tempDir();
    const env = { ...process.env, PATH: `${fauxNpm()}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const sh = (texte: string) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', texte], { cwd: r, encoding: 'utf8', env });
    // le projet avant l'adoption : du TypeScript avec une erreur de type et une violation ESLint, un plan tenu par un autre outil
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src'));
    writeFileSync(join(r, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r, 'package.json'), '{\n  "name": "projet",\n  "private": true,\n  "type": "module"\n}\n');
    writeFileSync(join(r, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "target": "es2022", "skipLibCheck": true, "types": [] }, "include": ["src"] }\n');
    writeFileSync(join(r, 'src/a.ts'), 'export const a: number = \'un\';\nexport function f(x: any) { return x; }\n');
    writeFileSync(join(r, 'cadence.yaml'), 'plan: { file: jira.csv, format: csv }\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'projet');
    git(r, 'checkout', '-qb', 'cadence/run-20261121-adoption');
    // la recette, bloc par bloc, telle qu'écrite
    const [[, installer], [, config], [, cle], [, figer]] = blocs;
    const i = sh(installer);
    expect(i.status, i.stderr).toBe(0);
    writeFileSync(join(r, /^\/\/ (\S+)\n/.exec(config)![1]), config);
    writeFileSync(join(r, 'cadence.yaml'), `${readFileSync(join(r, 'cadence.yaml'), 'utf8')}${cle}`);
    const f = sh(figer);
    expect(f.status, `${f.stdout}\n${f.stderr}`).toBe(0);
    // le lot a touché le manifeste et son verrou, et la porte (dernière commande du bloc) le laisse passer en disant les deux bases neuves
    expect(git(r, 'diff', '--name-only', 'main', 'HEAD').split('\n').sort()).toEqual(['.cadence/analyse/eslint.json', '.cadence/analyse/tsc.json', 'cadence.yaml', 'eslint.config.mjs', 'package-lock.json', 'package.json']);
    expect(f.stdout).toMatch(/analyse : ligne de base neuve : eslint \(\.cadence\/analyse\/eslint\.json\) — adoption déclarée par le commit [0-9a-f]{7,} \(Analyse-adoption: eslint\)/);
    expect(f.stdout).toMatch(/analyse : ligne de base neuve : tsc \(\.cadence\/analyse\/tsc\.json\) — adoption déclarée par le commit/);
    expect(JSON.parse(readFileSync(join(r, '.cadence/analyse/tsc.json'), 'utf8'))).toEqual({ 'src/a.ts|TS2322': 1 });
    expect(JSON.parse(readFileSync(join(r, '.cadence/analyse/eslint.json'), 'utf8'))).toMatchObject({ 'src/a.ts|@typescript-eslint/no-explicit-any': 1 });
    // la même recette sans la ligne d'adoption : refusée, et le refus dit la ligne à écrire
    const adopte = git(r, 'rev-parse', 'HEAD');
    git(r, 'commit', '-q', '--amend', '-m', 'chore: adopt eslint and tsc');
    const sans = sh('npx cadence analyse --contre main');
    expect(sans.status).toBe(1);
    expect(sans.stderr).toContain('« Analyse-adoption: eslint, tsc » dans le message d\'un commit du lot');
    // le lot suivant ajoute une dépendance : package.json n'est pas une config figée, il passe ; une erreur de type de plus, non
    git(r, 'reset', '-q', '--hard', adopte); git(r, 'checkout', '-q', 'main'); git(r, 'merge', '-q', '--ff-only', adopte); git(r, 'checkout', '-qb', 'cadence/run-20261122-suite');
    writeFileSync(join(r, 'package.json'), readFileSync(join(r, 'package.json'), 'utf8').replace('"devDependencies": {', '"dependencies": { "yaml": "^2.0.0" },\n  "devDependencies": {'));
    git(r, 'commit', '-qam', 'feat: une dépendance');
    const suite = sh('npx cadence analyse --contre main');
    expect(suite.status, `${suite.stdout}\n${suite.stderr}`).toBe(0);
    expect(suite.stdout).not.toContain('ligne de base neuve');
    writeFileSync(join(r, 'src/b.ts'), 'export const b: string = 1;\n');
    git(r, 'add', '-A');
    const pire = sh('npx cadence analyse --contre main --outil tsc');
    expect(pire.status).toBe(1);
    expect(pire.stderr).toContain('src/b.ts|TS2322 : 0 → 1');
  });
});

// ── M3' : toute directive que l'outil honore est comptée ───────────────────────────────────────────────────────────────────────

const VRAI = (outil: string) => join(CADENCE, 'node_modules', outil);
/** Un dépôt jetable où chaque forme est un fichier suivi par git : forme<i>.<ext>. */
function formes(ext: string, corps: string[], autres: Record<string, string> = {}): string {
  const r = tempDir();
  git(r, 'init', '-q');
  corps.forEach((t, i) => writeFileSync(join(r, `forme${i}.${ext}`), t));
  for (const [f, t] of Object.entries(autres)) writeFileSync(join(r, f), t);
  symlinkSync(join(CADENCE, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, '.gitignore'), 'node_modules\n');
  git(r, 'add', '-A');
  return r;
}
const comptees = (m: Record<string, number>, f: string) => Object.entries(m).filter(([k]) => k.startsWith(`${f}|`)).reduce((a, [, n]) => a + n, 0);

describe('L801 r2 M3\' — les extinctions sont comptées quelle que soit la mise en forme du commentaire (vrai ESLint 9, vrai tsc)', () => {
  // chaque forme précède la même violation ; [forme, honorée par l'outil (le test le VÉRIFIE avec l'outil), comptée]
  const ESLINT: [string, boolean, number][] = [
    ['', false, 0],
    ['// un commentaire sur eslint-disable, qui n\'éteint rien\n', false, 0],
    ['/* eslint-disable */\n', true, 1],
    ['/*\n  eslint-disable\n*/\n', true, 1], // la forme de la revue r2
    ['/*\n\n\t eslint-disable no-console -- pourquoi\n */\n', true, 1],
    ['/*eslint-disable*/\n', true, 1],
    ['/*\n * eslint-disable\n */\n', false, 1], // ESLint ne l'honore pas : compté quand même (trop plutôt que pas assez)
    ['// eslint-disable-next-line no-console\n', true, 1],
    ['//eslint-disable-next-line\n', true, 1],
    ['/* eslint-disable-next-line\n   no-console\n*/\n', true, 1],
    ['/*\n eslint-disable-next-line no-console */\n', true, 1],
    ['/* eslint no-console: "off" */\n', true, 1],
    ['/*\n  eslint no-console: 0\n*/\n', true, 1],
    ['/* eslint "no-console": "off" */\n', true, 1],
    ['/*\n eslint\n   "no-console": ["off"]\n*/\n', true, 1],
  ];

  it('ESLint : toute forme qui fait taire no-console est comptée ; la forme sur plusieurs lignes de la revue est bien honorée par ESLint 9', () => {
    const r = formes('js', ESLINT.map(([d]) => `${d}console.log(1);\n`), { 'eslint.config.mjs': 'export default [{ rules: { "no-console": "error" } }];\n', 'trail.js': 'console.log(1); // eslint-disable-line\nconsole.log(2); /* eslint-disable-line no-console */\n' });
    const e = spawnSync(process.execPath, [join(VRAI('eslint'), 'bin/eslint.js'), '-f', 'json', '.'], { cwd: r, encoding: 'utf8' });
    const rapport = JSON.parse(e.stdout) as { filePath: string; messages: { ruleId: string | null }[] }[];
    expect(JSON.parse(readFileSync(join(VRAI('eslint'), 'package.json'), 'utf8')).version).toMatch(/^9\./);
    const tait = (f: string) => !rapport.find((x) => x.filePath.endsWith(`/${f}`))!.messages.some((m) => m.ruleId === 'no-console');
    const m = lireDirectives(r, '.', 'eslint-json');
    ESLINT.forEach(([forme, honoree, n], i) => {
      expect([forme, tait(`forme${i}.js`)]).toEqual([forme, honoree]);
      expect([forme, comptees(m, `forme${i}.js`)]).toEqual([forme, n]);
      if (tait(`forme${i}.js`)) expect(comptees(m, `forme${i}.js`), forme).toBeGreaterThan(0); // l'invariant : honorée ⇒ comptée
    });
    expect(tait('trail.js')).toBe(true);
    expect(m['trail.js|directive:eslint-disable']).toBe(2);
    expect(m['forme11.js|directive:eslint-config']).toBe(1);
  });

  it('ESLint : /* global */ et /* exported */, qui éteignent no-undef et no-unused-vars pour un nom, comptent sous eslint-global', () => {
    const r = formes('js', ['/* global inconnu */\ninconnu();\n', '/*\n globals inconnu\n*/\ninconnu();\n', 'inconnu();\n', '/* une variable globale, dans une phrase */\ninconnu();\n'],
      { 'eslint.config.mjs': 'export default [{ rules: { "no-undef": "error" } }];\n' });
    const rapport = JSON.parse(spawnSync(process.execPath, [join(VRAI('eslint'), 'bin/eslint.js'), '-f', 'json', '.'], { cwd: r, encoding: 'utf8' }).stdout) as { filePath: string; messages: { ruleId: string | null }[] }[];
    const tait = (f: string) => !rapport.find((x) => x.filePath.endsWith(`/${f}`))!.messages.some((m) => m.ruleId === 'no-undef');
    expect([0, 1, 2, 3].map((i) => tait(`forme${i}.js`))).toEqual([true, true, false, false]);
    expect(lireDirectives(r, '.', 'eslint-json')).toEqual({ 'forme0.js|directive:eslint-global': 1, 'forme1.js|directive:eslint-global': 1 });
  });

  const TSC: [string, boolean, number][] = [
    ['', false, 0],
    ['// une phrase sur @ts-ignore, qui n\'éteint rien\n', false, 0],
    ['// @ts-ignore\n', true, 1],
    ['//@ts-expect-error\n', true, 1],
    ['/// @ts-ignore\n', true, 1],
    ['/* @ts-ignore */\n', true, 1],
    ['/*\n @ts-ignore */\n', true, 1], // la forme de la revue r2
    ['/* pourquoi :\n   ça ne se type pas\n   @ts-expect-error */\n', true, 1], // la dernière ligne du bloc, quel que soit le texte d'avant
    ['/**\n * @ts-ignore */\n', true, 1],
    ['/*\n\t**  @ts-ignore suite */\n', true, 1],
    ['/**\n * @ts-ignore\n */\n', false, 1], // tsc ne l'honore pas (la dernière ligne est « */ ») : compté quand même
    ['// @ts-nocheck\n', true, 1],
  ];

  it('tsc : toute forme qui fait taire l\'erreur de la ligne suivante est comptée ; la forme sur deux lignes de la revue est bien honorée par tsc', () => {
    const r = formes('ts', TSC.map(([d], i) => `${d}export const v${i}: number = 's';\n`), { 'trail.ts': 'export const x = 1; // @ts-ignore\nexport const y: number = \'s\'; /* @ts-ignore */\nexport const z: number = \'s\';\n' , 'tsconfig.json': '{ "compilerOptions": { "strict": true, "noEmit": true, "types": [], "skipLibCheck": true }, "include": ["*.ts"] }\n' });
    const t = spawnSync(process.execPath, [join(VRAI('typescript'), 'bin/tsc'), '-p', '.', '--pretty', 'false'], { cwd: r, encoding: 'utf8' });
    const erreurs = new Set(t.stdout.split('\n').map((l) => /^(\S+?)\(\d+,\d+\): error TS/.exec(l)?.[1]).filter(Boolean));
    expect(erreurs.has('forme0.ts')).toBe(true);
    const m = lireDirectives(r, '.', 'tsc');
    TSC.forEach(([forme, honoree, n], i) => {
      expect([forme, !erreurs.has(`forme${i}.ts`)]).toEqual([forme, honoree]);
      expect([forme, comptees(m, `forme${i}.ts`)]).toEqual([forme, n]);
    });
    expect(erreurs.has('trail.ts')).toBe(false); // un commentaire en fin de ligne éteint la ligne suivante
    expect(m['trail.ts|directive:ts-ignore']).toBe(2);
  });

  it('Python et Java : # flake8: noqa, # ruff: disable[…], NOPMD dans un commentaire bloc, @SuppressWarnings sur plusieurs lignes, "ALL"', () => {
    const r = tempDir();
    git(r, 'init', '-q');
    writeFileSync(join(r, 'm.py'), '# flake8: noqa\n# ruff: disable[E501]\nx = 1  # pourquoi # noqa: E501\ny = 2  # NoQA\nz = "noqa"  # rien\n');
    writeFileSync(join(r, 'A.java'), '@SuppressWarnings(\n  "PMD.GodClass"\n)\nclass A { int x; /* NOPMD pourquoi */ }\n@SuppressWarnings(\n  { "unchecked",\n    "ALL" })\nclass B {}\n');
    git(r, 'add', '.');
    expect(lireDirectives(r, '.', 'ruff-json')).toEqual({ 'm.py|directive:noqa': 4 });
    expect(lireDirectives(r, '.', 'pmd-xml')).toEqual({ 'A.java|directive:nopmd': 3 });
    expect(lireDirectives(r, '.', 'checkstyle-xml')).toEqual({ 'A.java|directive:checkstyle-off': 1 });
  });
});
