// (revue r4, en fin de fichier : une base orpheline ou déposée, reprise, est neuve ; revue r3, avant elle et dans la recette : M1, une base neuve est sa mesure ; M3, Analyse-config sans plan natif ; mineur, /* exported */.)
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
    execFileSync('rm', [join(r, 'src/b.ts')]); git(r, 'add', '-A');

    // r3 M3 — ce projet n'a pas de plan natif et la recette déclare `configs: [tsconfig.json]` : le lot qui touche tsconfig.json est refusé sans déclaration,
    // et le refus nomme la ligne ; avec « Analyse-config: tsc » il passe, la porte le dit, et le vrai tsc juge toujours le code (dossier ajouté compris)
    mkdirSync(join(r, 'scripts'));
    writeFileSync(join(r, 'scripts/x.ts'), 'export const x = 1;\n');
    writeFileSync(join(r, 'tsconfig.json'), readFileSync(join(r, 'tsconfig.json'), 'utf8').replace('"include": ["src"]', '"include": ["src", "scripts"]'));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: scripts typés');
    const fige = sh('npx cadence analyse --contre main');
    expect(fige.status).toBe(1);
    expect(fige.stderr).toContain('tsconfig.json (modifié) diffère(nt) de main');
    expect(fige.stderr).toContain('ce dépôt n\'a pas de plan natif : la config d\'un outil s\'y change par la ligne « Analyse-config: tsc »');
    git(r, 'commit', '-q', '--amend', '-m', 'feat: scripts typés', '-m', 'Analyse-config: tsc');
    const declare = sh('npx cadence analyse --contre main');
    expect(declare.status, `${declare.stdout}\n${declare.stderr}`).toBe(0);
    expect(declare.stdout).toMatch(/^analyse : config changée : tsc — tsconfig\.json \(modifié\) — changement déclaré par le commit [0-9a-f]{7,} \(Analyse-config: tsc\)$/m);
    writeFileSync(join(r, 'scripts/y.ts'), 'export const y: string = 2;\n');
    git(r, 'add', '-A');
    const juge = sh('npx cadence analyse --contre main --outil tsc');
    expect(juge.status).toBe(1);
    expect(juge.stderr).toContain('scripts/y.ts|TS2322 : 0 → 1');

    // r3 M1 — la même adoption, base de tsc gonflée à la main (un compte relevé, une clé pour un fichier qui n'existe pas) : refusée, clés nommées ;
    // « --init --contre » la re-mesure et la porte repasse
    git(r, 'reset', '-q', '--hard', adopte); git(r, 'checkout', '-q', 'main'); git(r, 'reset', '-q', '--hard', 'HEAD~1'); git(r, 'checkout', '-q', 'cadence/run-20261121-adoption');
    writeFileSync(join(r, '.cadence/analyse/tsc.json'), JSON.stringify({ 'src/a.ts|TS2322': 40, 'src/futur.ts|TS2322': 30 }));
    git(r, 'commit', '-qam', 'chore: de la place');
    const gonflee = sh('npx cadence analyse --contre main');
    expect(gonflee.status).toBe(1);
    expect(gonflee.stderr).toContain('tsc (.cadence/analyse/tsc.json) : ligne de base neuve (absente de main');
    expect(gonflee.stderr).toContain('src/a.ts|TS2322 : 40 → 1');
    expect(gonflee.stderr).toContain('src/futur.ts|TS2322 : 30 → 0');
    expect(gonflee.stdout).toContain('eslint (.cadence/analyse/eslint.json) : rien n\'empire');
    expect(sh('npx cadence analyse --init --outil tsc --contre main').status).toBe(0);
    expect(JSON.parse(readFileSync(join(r, '.cadence/analyse/tsc.json'), 'utf8'))).toEqual({ 'src/a.ts|TS2322': 1 });
    git(r, 'commit', '-qam', 'chore: la mesure');
    expect(sh('npx cadence analyse --contre main').status).toBe(0);
  });
});

// ── revue r3 — M1 : une base neuve est sa mesure ; M3 : une config d'outil change sans plan natif, par un changement déclaré ──────────────────

describe('L801 r3 M1 — une ligne de base absente au départ du lot est égale à la mesure du commit jugé, sinon la porte refuse', () => {
  const base = (r: string) => join(r, '.cadence/analyse/lint.json');
  /** Le lot ordinaire qui adopte `lint` (src/a.js : 2 violations) avec la base `ecrite` à la main, adoption déclarée. */
  async function adopter(ecrite: Record<string, number>): Promise<string> {
    const r = await depot();
    ajouter(r, `analyse:\n${ENTREE('lint')}`);
    mkdirSync(dirname(base(r)), { recursive: true });
    writeFileSync(base(r), JSON.stringify(ecrite));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'chore: adopte lint\n\nAnalyse-adoption: lint');
    return r;
  }
  const MESURE = { 'src/a.js|no-todo': 2, 'src/a.js|no-todo|total': 2 };

  it('le scénario de la revue : base gonflée (compte relevé, clé d\'un fichier à naître) refusée à l\'adoption ; re-mesurée, la hausse du lot suivant est refusée', async () => {
    const r = await adopter({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40, 'src/futur.js|no-todo': 30, 'src/futur.js|no-todo|total': 30 });
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('lint (.cadence/analyse/lint.json) : ligne de base neuve (absente de main');
    expect(refus.sortie).toContain('4 clé(s) au-dessus de la mesure ou absente(s) d\'elle');
    expect(refus.sortie).toContain('src/a.js|no-todo : 40 → 2');
    expect(refus.sortie).toContain('src/futur.js|no-todo : 30 → 0');
    expect(refus.sortie).toContain('« cadence analyse --init --outil lint --contre main »');
    expect(refus.sortie).not.toContain('rien n\'empire');
    // la voie dite par le refus : la base redevient la mesure, la porte passe
    expect((await cadence(r, '--init', '--outil', 'lint', '--contre', 'main')).code).toBe(0);
    expect(JSON.parse(readFileSync(base(r), 'utf8'))).toEqual(MESURE);
    git(r, 'commit', '-qam', 'chore: la mesure');
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    // intégrée, puis le lot suivant : a.js passe à 3 violations et futur.js naît avec 3 — plus aucune place inventée d'avance
    git(r, 'checkout', '-q', 'main'); git(r, 'merge', '-q', '--ff-only', 'cadence/run-20261121-1'); git(r, 'checkout', '-qb', 'cadence/run-20261122-2');
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    writeFileSync(join(r, 'src/futur.js'), '// TODO\n// TODO\n// TODO\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: suite');
    const suite = await cadence(r, '--contre', 'main');
    expect(suite.code).toBe(1);
    expect(suite.sortie).toContain('src/a.js|no-todo : 2 → 3');
    expect(suite.sortie).toContain('src/futur.js|no-todo : 0 → 3');
  });

  it.each([
    ['un seul compte au-dessus', { ...MESURE, 'src/a.js|no-todo': 3 }, 'src/a.js|no-todo : 3 → 2'],
    ['une clé à la mesure d\'un fichier absent', { ...MESURE, 'src/futur.js|no-todo': 1 }, 'src/futur.js|no-todo : 1 → 0'],
    ['une clé à zéro que la mesure n\'a pas', { ...MESURE, 'src/a.js|autre-regle': 0 }, 'src/a.js|autre-regle : 0 → 0'],
  ])('%s : refusé', async (_, ecrite, attendu) => {
    const refus = await cadence(await adopter(ecrite), '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain(attendu);
  });

  it('une base écrite à la main mais égale à la mesure passe ; une base sous la mesure reste refusée par le cliquet', async () => {
    expect((await cadence(await adopter(MESURE), '--contre', 'main')).code).toBe(0);
    const sous = await cadence(await adopter({ 'src/a.js|no-todo': 1, 'src/a.js|no-todo|total': 1 }), '--contre', 'main');
    expect(sous.code).toBe(1);
    expect(sous.sortie).toContain('2 mesure(s) empirent');
  });

  it('non adoptée aussi : la base neuve d\'un lot « config: true » du plan natif, gonflée, est refusée', async () => {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src')); mkdirSync(join(r, '.cadence/analyse'), { recursive: true });
    writeFileSync(join(r, 'outil.mjs'), OUTIL);
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\n');
    writeFileSync(join(r, '.cadence/raf.yaml'), 'project: p\nlots:\n  - id: L5\n    title: adopter lint\n    config: true\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base'); git(r, 'checkout', '-qb', 'cadence/run--L5');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint')}`);
    writeFileSync(base(r), JSON.stringify({ 'src/a.js|no-todo': 9, 'src/a.js|no-todo|total': 9 }));
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('analyse : ligne de base neuve : lint (.cadence/analyse/lint.json) — lot « config: true » du plan');
    expect(refus.sortie).toContain('src/a.js|no-todo : 9 → 1');
  });
});

describe('L801 r3 M3 — sans plan natif, la config d\'un outil adopté change par un changement déclaré (Analyse-config), que la porte affiche', () => {
  const SEUILS = '    configs: [seuils.json]\n';
  /** main : `lint` adopté avec seuils.json dans ses configs (et `plus`, d'autres outils) ; le lot change seuils.json. */
  async function fige(plus = ''): Promise<string> {
    const r = await depot(`${ENTREE('lint', SEUILS)}${plus}`);
    writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    return r;
  }
  const yaml = (r: string, changer: (y: string) => string) => writeFileSync(join(r, 'cadence.yaml'), changer(readFileSync(join(r, 'cadence.yaml'), 'utf8')));

  it('sans la ligne : refusé, et le refus nomme la ligne à écrire ; avec : la porte passe et dit quoi a changé, par quel commit', async () => {
    const r = await fige();
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: seuil');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('seuils.json (nouveau) diffère(nt) de main');
    expect(refus.sortie).toContain('« Analyse-config: lint » dans le message d\'un commit du lot');
    git(r, 'commit', '-q', '--amend', '-m', 'feat: seuil', '-m', 'Analyse-config: lint');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.sortie.split('\n')).toEqual([
      `analyse : config changée : lint — seuils.json (nouveau) — changement déclaré par le commit ${git(r, 'rev-parse', '--short', 'HEAD')} (Analyse-config: lint)`,
      'analyse : lint (.cadence/analyse/lint.json) : rien n\'empire (2 violation(s), 2 gelée(s)).',
    ]);
    expect(porte.code).toBe(0);
    // le cliquet juge toujours le code du lot, et la base ne remonte pas
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    expect((await cadence(r, '--contre', 'main')).sortie).toContain('src/a.js|no-todo : 2 → 3');
  });

  it('l\'entrée de l\'outil change aussi (commande, liste de configs) sous le même nom et la même base ; une déclaration sans changement ne dit rien', async () => {
    const r = await depot(ENTREE('lint', SEUILS));
    git(r, 'commit', '-q', '--allow-empty', '-m', 'chore: rien\n\nAnalyse-config: lint');
    expect((await cadence(r, '--contre', 'main')).sortie).not.toContain('config changée');
    writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    yaml(r, (y) => y.replace('node outil.mjs', 'node ./outil.mjs').replace('[seuils.json]', '[seuils.json, autres.json]'));
    writeFileSync(join(r, 'autres.json'), '{}\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: commande');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.code).toBe(0);
    expect(porte.sortie).toContain('analyse : config changée : lint — cadence.yaml#analyse.lint (modifié : command « node outil.mjs » → « node ./outil.mjs » ; configs « seuils.json » → « seuils.json, autres.json »), seuils.json (nouveau), autres.json (nouveau) — changement déclaré par le commit');
  });

  it.each([
    ['renommer lint → lint2', (y: string) => y.replace('name: lint', 'name: lint2'), 'cadence.yaml#analyse.lint (supprimé)'],
    ['déplacer sa base', (y: string) => `${y}    baseline: autre/lint.json\n`, 'cadence.yaml#analyse.lint (modifié)'],
    ['retirer l\'outil', (y: string) => y.replace(/analyse:[\s\S]*$/, `analyse:\n${ENTREE('autre')}`), 'cadence.yaml#analyse.lint (supprimé)'],
  ])('pas de retour à r1 M1 — %s reste refusé, déclaré ou non : jamais une base neuve par cette voie', async (_, changer, attendu) => {
    const r = await depot(ENTREE('lint'));
    yaml(r, changer);
    await cadence(r, '--init');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: outil changé\n\nAnalyse-config: lint, lint2, autre');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain(attendu);
    expect(refus.sortie).not.toContain('config changée');
  });

  it('un fichier qu\'un autre outil du départ lit aussi reste figé tant que cet outil n\'est pas déclaré ; les deux déclarés, il change', async () => {
    const r = await fige(ENTREE('lint-b', SEUILS));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: seuil\n\nAnalyse-config: lint');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('seuils.json (nouveau) diffère(nt) de main');
    expect(refus.sortie).toContain('« Analyse-config: lint-b »');
    git(r, 'commit', '-q', '--allow-empty', '-m', 'chore: et lint-b\n\nanalyse-config: lint-b');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.code).toBe(0);
    expect(porte.sortie.match(/analyse : config changée : /g)).toHaveLength(2);
  });

  it('avec un plan natif la ligne ne vaut rien : seul un lot « config: true » du plan change une config', async () => {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src')); mkdirSync(join(r, '.cadence'));
    writeFileSync(join(r, 'outil.mjs'), OUTIL);
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\n');
    writeFileSync(join(r, 'seuils.json'), '{"max":1}\n');
    writeFileSync(join(r, '.cadence/raf.yaml'), 'project: p\nlots:\n  - id: L5\n    title: du code\n');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint', SEUILS)}`);
    expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base'); git(r, 'checkout', '-qb', 'cadence/run--L5');
    writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    git(r, 'commit', '-qam', 'feat(L5): seuil\n\nAnalyse-config: lint');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('seuils.json (modifié) diffère(nt) de main');
    expect(refus.sortie).not.toContain('Analyse-config');
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

  it('ESLint : /* exported f */ n\'éteint no-unused-vars qu\'en sourceType « script » (ESLint 9 lit un .js en module) ; il est compté partout, trop plutôt que pas assez', () => {
    const r = formes('js', ['/* exported f */\nfunction f() {}\n', 'function f() {}\n'], { 'forme2.cjs': '/* exported f */\nfunction f() {}\n', 'forme3.cjs': 'function f() {}\n',
      'eslint.config.mjs': 'export default [{ rules: { "no-unused-vars": "error" } }, { files: ["**/*.cjs"], languageOptions: { sourceType: "script" } }];\n' });
    const rapport = JSON.parse(spawnSync(process.execPath, [join(VRAI('eslint'), 'bin/eslint.js'), '-f', 'json', '.'], { cwd: r, encoding: 'utf8' }).stdout) as { filePath: string; messages: { ruleId: string | null }[] }[];
    const tait = (f: string) => !rapport.find((x) => x.filePath.endsWith(`/${f}`))!.messages.some((m) => m.ruleId === 'no-unused-vars');
    expect(['forme0.js', 'forme1.js', 'forme2.cjs', 'forme3.cjs'].map(tait)).toEqual([false, false, true, false]);
    expect(lireDirectives(r, '.', 'eslint-json')).toEqual({ 'forme0.js|directive:eslint-global': 1, 'forme2.cjs|directive:eslint-global': 1 });
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

// ── revue r4 — M1 : une base est neuve quand elle n'était pas celle du MÊME outil au départ (fichier orphelin ou déposé), pas seulement absente ──────────

describe('L801 r4 M1 — une ligne de base orpheline ou déposée, reprise par un lot, est neuve : tenue à sa mesure et dite par la porte', () => {
  const base = (r: string) => join(r, '.cadence/analyse/lint.json');
  const PLAN = 'project: p\nlots:\n  - id: L1\n    title: du code\n  - id: L5\n    title: config\n    config: true\n  - id: L6\n    title: nettoyer\n  - id: L7\n    title: remettre lint\n    config: true\n  - id: L8\n    title: suite\n';
  const REPRISE = /^analyse : ligne de base neuve : lint \(\.cadence\/analyse\/lint\.json\) — lot « config: true » du plan — fichier repris de main \([0-9a-f]{7}\), où il n'était pas la base de cet outil : tenu à sa mesure$/m;
  /** Un dépôt à plan natif (L5 et L7 `config: true`) ; main porte src/a.js (4 TODO) et, avec `outil`, `lint` et sa base à 4. */
  async function natif(outil: boolean): Promise<string> {
    const r = tempDir();
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src')); mkdirSync(join(r, '.cadence'));
    writeFileSync(join(r, 'outil.mjs'), OUTIL);
    writeFileSync(join(r, 'src/a.js'), '// TODO\n// TODO\n// TODO\n// TODO\n');
    writeFileSync(join(r, '.cadence/raf.yaml'), PLAN);
    writeFileSync(join(r, 'cadence.yaml'), outil ? `analyse:\n${ENTREE('lint')}` : 'project: p\n');
    if (outil) expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
    return r;
  }
  /** Ouvre la branche du lot depuis main ; `integrer` la fond dans main (fast-forward, comme un run). */
  const lot = (r: string, id: string) => { git(r, 'checkout', '-q', 'main'); git(r, 'checkout', '-qb', `cadence/run--${id}`); };
  const integrer = (r: string, id: string) => { git(r, 'checkout', '-q', 'main'); git(r, 'merge', '-q', '--ff-only', `cadence/run--${id}`); };

  it('le scénario de la revue : L5 (config) retire lint et laisse sa base à 4, L6 nettoie, L7 (config) remet lint — la base doit valoir la mesure, et la porte le dit', async () => {
    const r = await natif(true);
    lot(r, 'L5');
    writeFileSync(join(r, 'cadence.yaml'), 'project: p\n');
    git(r, 'commit', '-qam', 'chore(L5): retire lint'); integrer(r, 'L5');
    expect(JSON.parse(readFileSync(base(r), 'utf8'))).toMatchObject({ 'src/a.js|no-todo': 4 }); // la base orpheline reste dans main
    lot(r, 'L6');
    writeFileSync(join(r, 'src/a.js'), 'propre\n');
    git(r, 'commit', '-qam', 'feat(L6): nettoie'); integrer(r, 'L6');
    lot(r, 'L7');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint')}`);
    git(r, 'commit', '-qam', 'chore(L7): remet lint');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toMatch(REPRISE);
    expect(refus.sortie).toMatch(/lint \(\.cadence\/analyse\/lint\.json\) : ligne de base neuve \(dans main \([0-9a-f]{7}\), ce fichier n'était pas la base de l'outil « lint »\) différente de la mesure/);
    expect(refus.sortie).toContain('src/a.js|no-todo : 4 → 0');
    expect(refus.sortie).not.toContain('rien n\'empire');
    // la voie dite par le refus : la base orpheline est re-mesurée (elle existe dans main, mais n'y était la base d'aucun outil)
    expect(refus.sortie).toContain('« cadence analyse --init --outil lint --contre main »');
    expect((await cadence(r, '--init', '--outil', 'lint', '--contre', 'main')).code).toBe(0);
    expect(JSON.parse(readFileSync(base(r), 'utf8'))).toEqual({});
    git(r, 'commit', '-qam', 'chore(L7): la mesure');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.code).toBe(0);
    expect(porte.sortie).toMatch(REPRISE);
    expect(porte.sortie).toContain('rien n\'empire (0 violation(s), 0 gelée(s))');
    // intégrée : le lot suivant ne retrouve pas les 4 places de l'ancienne base, et la base n'est plus neuve
    integrer(r, 'L7'); lot(r, 'L8');
    writeFileSync(join(r, 'src/a.js'), 'propre // TODO\n');
    git(r, 'commit', '-qam', 'feat(L8): suite');
    const suite = await cadence(r, '--contre', 'main');
    expect(suite.code).toBe(1);
    expect(suite.sortie).toContain('src/a.js|no-todo : 0 → 1');
    expect(suite.sortie).not.toContain('ligne de base neuve');
  });

  it('un lot ordinaire dépose une base à 40, puis un lot « config: true » ajoute lint : refusé (40 → 4), jusqu\'à ce que la base soit la mesure', async () => {
    const r = await natif(false);
    lot(r, 'L1');
    mkdirSync(dirname(base(r)), { recursive: true });
    writeFileSync(base(r), JSON.stringify({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40 }));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat(L1): du code, et un fichier'); integrer(r, 'L1');
    lot(r, 'L5');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint')}`);
    git(r, 'commit', '-qam', 'chore(L5): ajoute lint');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toMatch(REPRISE);
    expect(refus.sortie).toContain('src/a.js|no-todo : 40 → 4');
    expect((await cadence(r, '--init', '--outil', 'lint', '--contre', 'main')).code).toBe(0);
    git(r, 'commit', '-qam', 'chore(L5): la mesure');
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    integrer(r, 'L5'); lot(r, 'L6');
    writeFileSync(join(r, 'src/a.js'), '// TODO\n'.repeat(14));
    git(r, 'commit', '-qam', 'feat(L6): dix de plus');
    expect((await cadence(r, '--contre', 'main')).sortie).toContain('src/a.js|no-todo : 4 → 14');
  });

  it('un outil gardé sous son nom dont un lot « config: true » déplace la base vers un fichier déposé : neuve aussi, tenue à la mesure', async () => {
    const r = await natif(true);
    lot(r, 'L1');
    writeFileSync(join(r, 'large.json'), JSON.stringify({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40 }));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat(L1): un fichier'); integrer(r, 'L1');
    lot(r, 'L5');
    writeFileSync(join(r, 'cadence.yaml'), `analyse:\n${ENTREE('lint', '    baseline: large.json\n')}`);
    git(r, 'commit', '-qam', 'chore(L5): base déplacée');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('analyse : ligne de base neuve : lint (large.json) — lot « config: true » du plan — fichier repris de main');
    expect(refus.sortie).toContain('src/a.js|no-todo : 40 → 4');
  });

  it('sans plan natif : une base déposée par un lot ordinaire se reprend par une adoption déclarée — gonflée refusée, égale à la mesure acceptée et dite', async () => {
    const r = await depot();
    mkdirSync(dirname(base(r)), { recursive: true });
    writeFileSync(base(r), JSON.stringify({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40 }));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: un fichier');
    git(r, 'checkout', '-q', 'main'); git(r, 'merge', '-q', '--ff-only', 'cadence/run-20261121-1'); git(r, 'checkout', '-qb', 'cadence/run-20261122-2');
    ajouter(r, `analyse:\n${ENTREE('lint')}`);
    git(r, 'commit', '-qam', 'chore: adopte lint');
    const sans = await cadence(r, '--contre', 'main');
    expect(sans.code).toBe(1);
    expect(sans.sortie).toContain('cadence.yaml#analyse.lint (nouveau) diffère(nt) de main');
    expect(sans.sortie).toContain('« Analyse-adoption: lint »');
    git(r, 'commit', '-q', '--amend', '-m', 'chore: adopte lint', '-m', 'Analyse-adoption: lint');
    const gonflee = await cadence(r, '--contre', 'main');
    expect(gonflee.code).toBe(1);
    expect(gonflee.sortie).toContain('ce fichier n\'était pas la base de l\'outil « lint »');
    expect(gonflee.sortie).toContain('src/a.js|no-todo : 40 → 2');
    expect((await cadence(r, '--init', '--outil', 'lint', '--contre', 'main')).code).toBe(0);
    git(r, 'commit', '-qam', 'chore: la mesure');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.code).toBe(0);
    expect(porte.sortie).toMatch(/^analyse : ligne de base neuve : lint \(\.cadence\/analyse\/lint\.json\) — adoption déclarée par le commit [0-9a-f]{7,} \(Analyse-adoption: lint\) — fichier repris de main \([0-9a-f]{7}\), où il n'était pas la base de cet outil : tenu à sa mesure$/m);
  });

  it('vrais ESLint 9 et tsc : deux bases déposées à 40 puis adoptées sont refusées, clés nommées ; re-mesurées, elles valent la mesure des outils', { timeout: 300_000 }, () => {
    const r = tempDir();
    const sh = (texte: string) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', texte], { cwd: r, encoding: 'utf8' });
    const analyse = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: r, encoding: 'utf8' });
    expect(JSON.parse(readFileSync(join(VRAI('eslint'), 'package.json'), 'utf8')).version).toMatch(/^9\./);
    git(r, 'init', '-q', '-b', 'main');
    mkdirSync(join(r, 'src')); mkdirSync(join(r, '.cadence/analyse'), { recursive: true });
    symlinkSync(join(CADENCE, 'node_modules'), join(r, 'node_modules'));
    writeFileSync(join(r, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r, 'package.json'), '{ "name": "projet", "private": true, "type": "module" }\n');
    writeFileSync(join(r, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "target": "es2022", "skipLibCheck": true, "types": [] }, "include": ["src/*.ts"] }\n');
    writeFileSync(join(r, 'eslint.config.mjs'), 'export default [{ rules: { "no-console": "error" } }];\n');
    writeFileSync(join(r, 'src/a.ts'), 'export const a: number = \'un\';\n');
    writeFileSync(join(r, 'src/b.js'), 'console.log(1);\n');
    writeFileSync(join(r, 'cadence.yaml'), 'plan: { file: jira.csv, format: csv }\n');
    // déposées d'avance par un lot ordinaire : aucun outil ne les lit, la porte n'en dit rien
    writeFileSync(join(r, '.cadence/analyse/eslint.json'), JSON.stringify({ 'src/b.js|no-console': 40, 'src/b.js|no-console|total': 40, 'src/futur.js|no-console': 30, 'src/futur.js|no-console|total': 30 }));
    writeFileSync(join(r, '.cadence/analyse/tsc.json'), JSON.stringify({ 'src/a.ts|TS2322': 40 }));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'projet');
    git(r, 'checkout', '-qb', 'cadence/run-20261121-adoption');
    writeFileSync(join(r, 'cadence.yaml'), `plan: { file: jira.csv, format: csv }\nanalyse:\n  - name: eslint\n    command: node node_modules/eslint/bin/eslint.js -f json .\n    format: eslint-json\n    configs: [eslint.config.mjs]\n  - name: tsc\n    command: node node_modules/typescript/bin/tsc --noEmit --pretty false\n    format: tsc\n    configs: [tsconfig.json]\n`);
    expect(sh('git -c user.email=t@t -c user.name=t commit -qam "chore: adopt eslint and tsc" -m "Analyse-adoption: eslint, tsc"').status).toBe(0);
    const refus = analyse('--contre', 'main');
    expect(refus.status).toBe(1);
    expect(refus.stdout.match(/^analyse : ligne de base neuve : (eslint|tsc) .* — fichier repris de main/gm)).toHaveLength(2);
    expect(refus.stderr).toContain('src/b.js|no-console : 40 → 1');
    expect(refus.stderr).toContain('src/futur.js|no-console : 30 → 0');
    expect(refus.stderr).toContain('src/a.ts|TS2322 : 40 → 1');
    expect(refus.stdout).not.toContain('rien n\'empire');
    expect(analyse('--init', '--contre', 'main').status).toBe(0);
    expect(JSON.parse(readFileSync(join(r, '.cadence/analyse/tsc.json'), 'utf8'))).toEqual({ 'src/a.ts|TS2322': 1 });
    expect(JSON.parse(readFileSync(join(r, '.cadence/analyse/eslint.json'), 'utf8'))).toEqual({ 'src/b.js|no-console': 1, 'src/b.js|no-console|total': 1 });
    expect(sh('git -c user.email=t@t -c user.name=t commit -qam "chore: la mesure"').status).toBe(0);
    const porte = analyse('--contre', 'main');
    expect(porte.status, `${porte.stdout}\n${porte.stderr}`).toBe(0);
    expect(porte.stdout.match(/ligne de base neuve/g)).toHaveLength(2);
    // un console.log et une erreur de type de plus : refusés, sans la place des bases déposées
    writeFileSync(join(r, 'src/b.js'), 'console.log(1);\nconsole.log(2);\n');
    writeFileSync(join(r, 'src/c.ts'), 'export const c: string = 3;\n');
    git(r, 'add', '-A');
    const pire = analyse('--contre', 'main');
    expect(pire.status).toBe(1);
    expect(pire.stderr).toContain('src/b.js|no-console : 1 → 2');
    expect(pire.stderr).toContain('src/c.ts|TS2322 : 0 → 1');
  });
});

describe('L801 r4, notes — un refus ne propose que ce qui ouvre, et un changement déclaré dit l\'ancienne et la nouvelle valeur', () => {
  it('renommer lint → lint2 : le refus ne propose plus « Analyse-adoption: lint2 », qui resterait refusé ; il dit que le retrait ne s\'ouvre pas', async () => {
    const r = await depot(ENTREE('lint'));
    writeFileSync(join(r, 'cadence.yaml'), readFileSync(join(r, 'cadence.yaml'), 'utf8').replace('name: lint', 'name: lint2'));
    await cadence(r, '--init');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: renomme');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('cadence.yaml#analyse.lint (supprimé)');
    expect(refus.sortie).not.toContain('Analyse-adoption');
    expect(refus.sortie).toContain('« lint » : retirer ou renommer un outil du départ n\'est pas une adoption, aucune déclaration ne l\'ouvre');
  });

  it('Analyse-config dans un lot de code qui change la commande : la porte dit l\'ancienne et la nouvelle commande', async () => {
    const r = await depot(ENTREE('lint'));
    writeFileSync(join(r, 'cadence.yaml'), readFileSync(join(r, 'cadence.yaml'), 'utf8').replace('command: node outil.mjs', 'command: echo []'));
    writeFileSync(join(r, 'src/b.js'), '// TODO\n');
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat: du code\n\nAnalyse-config: lint');
    const porte = await cadence(r, '--contre', 'main');
    expect(porte.sortie).toContain(`analyse : config changée : lint — cadence.yaml#analyse.lint (modifié : command « node outil.mjs » → « echo [] ») — changement déclaré par le commit ${git(r, 'rev-parse', '--short', 'HEAD')} (Analyse-config: lint)`);
  });
});
