// L801 (D-23) : l'étape « analyse » générique — une commande par techno déclarée sous `analyse:` de cadence.yaml, son rapport lu par format,
// jugé par un cliquet par outil (ligne de base versionnée : seules les nouvelles violations échouent, une baisse s'écrit, une hausse jamais).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { etapeAnalyse, LECTEURS, lireAnalyse, lireDirectives, main, SCRIPT } from '../scripts/analyse.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
async function cadence(cwd: string, ...argv: string[]): Promise<{ code: number; sortie: string }> {
  const l: string[] = [];
  const code = await main(argv, { cwd, out: (x) => l.push(x), err: (x) => l.push(x) });
  return { code, sortie: l.join('\n') };
}

// Un faux outil : il imprime le rapport ESLint des fichiers .js du dépôt, une violation `no-todo` par ligne « TODO » (format eslint-json).
const OUTIL = `import { readdirSync, readFileSync } from 'node:fs';
const fichiers = readdirSync('src').filter((f) => f.endsWith('.js'));
if (process.env.PLANTE) process.exit(3);
console.log(JSON.stringify(fichiers.map((f) => ({ filePath: process.cwd() + '/src/' + f,
  messages: readFileSync('src/' + f, 'utf8').split('\\n').filter((l) => l.includes('TODO')).map(() => ({ ruleId: 'no-todo', message: 'todo' })) }))));
`;

/** Un dépôt dont cadence.yaml déclare un outil `lint` (le faux outil) ; `src/a.js` a deux violations, commitées sur main avec leur ligne de base. */
async function depot(o: { configs?: boolean; base?: boolean; plan?: string } = {}): Promise<string> {
  const r = tempDir();
  git(r, 'init', '-q', '-b', 'main');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'outil.mjs'), OUTIL);
  writeFileSync(join(r, 'seuils.json'), '{"max":1}\n');
  writeFileSync(join(r, 'cadence.yaml'), `analyse:\n  - name: lint\n    command: node outil.mjs\n    format: eslint-json\n${o.configs ? '    configs: [seuils.json]\n' : ''}`);
  writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz\n');
  if (o.plan) { mkdirSync(join(r, '.cadence'), { recursive: true }); writeFileSync(join(r, '.cadence/raf.yaml'), o.plan); }
  if (o.base !== false) expect((await cadence(r, '--init')).code).toBe(0);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base');
  git(r, 'checkout', '-qb', 'lot');
  return r;
}
const base = (r: string) => JSON.parse(readFileSync(join(r, '.cadence/analyse/lint.json'), 'utf8')) as Record<string, number>;

describe('L801 — la clé analyse: de cadence.yaml', () => {
  it('rend chaque outil avec ses défauts : dossier racine, ligne de base .cadence/analyse/<nom>.json, aucune config', () => {
    expect(lireAnalyse([{ name: 'ruff', command: ' ruff check --output-format json ', format: 'ruff-json' }], 'cadence.yaml')).toEqual([
      { name: 'ruff', command: 'ruff check --output-format json', format: 'ruff-json', dir: '.', baseline: '.cadence/analyse/ruff.json', configs: [] },
    ]);
    expect(lireAnalyse([{ name: 'checkstyle', command: 'mvn -q checkstyle:checkstyle', format: 'checkstyle-xml', dir: './back/', report: 'target/checkstyle-result.xml', configs: ['back/checkstyle.xml'] }], 'f')[0])
      .toMatchObject({ dir: 'back', report: 'target/checkstyle-result.xml', configs: ['back/checkstyle.xml'] });
    expect(lireAnalyse(undefined, 'f')).toEqual([]);
  });

  it.each([
    [{}, 'liste non vide'],
    [[], 'liste non vide'],
    [[{ name: 'a', command: 'x', format: 'eslint-json', seuil: 1 }], 'analyse[0].seuil inconnu'],
    [[{ name: 'A b', command: 'x', format: 'eslint-json' }], 'analyse[0].name'],
    [[{ name: 'a', command: 'x', format: 'eslint-json' }, { name: 'a', command: 'y', format: 'tsc' }], 'analyse[1].name : « a » déjà pris'],
    [[{ name: 'a', command: ' ', format: 'tsc' }], 'analyse[0].command'],
    [[{ name: 'a', command: 'x', format: 'sonar' }], 'analyse[0].format : « sonar » inconnu'],
    [[{ name: 'a', command: 'x', format: 'tsc', dir: '../autre' }], 'analyse[0].dir : « ../autre » sort du dépôt'],
    [[{ name: 'a', command: 'x', format: 'tsc', baseline: '/tmp/b.json' }], 'analyse[0].baseline'],
    [[{ name: 'a', command: 'x', format: 'tsc', configs: [] }], 'analyse[0].configs'],
  ])('une forme mal formée est refusée en nommant la clé fautive (%j)', (valeur, attendu) => {
    expect(() => lireAnalyse(valeur, 'cadence.yaml')).toThrow(`cadence.yaml : `);
    expect(() => lireAnalyse(valeur, 'cadence.yaml')).toThrow(attendu);
  });
});

describe('L801 — les lecteurs de rapport, une forme par techno', () => {
  const R = '/r';
  it('eslint-json : le lecteur de scripts/qualite.mjs, avec la somme des chiffres (|total)', () => {
    const m = LECTEURS['eslint-json'](JSON.stringify([{ filePath: '/r/src/a.ts', messages: [{ ruleId: 'complexity', message: 'has a complexity of 20.' }, { ruleId: null, message: 'Parsing error' }] }]), R, '.', 1);
    expect(m).toEqual({ 'src/a.ts|complexity': 1, 'src/a.ts|complexity|total': 20, 'src/a.ts|analyse': 1, 'src/a.ts|analyse|total': 1 });
  });

  it('tsc : chaque erreur par fichier et code, relatif au dossier de l\'outil ; une erreur sans fichier sous (global)', () => {
    const t = "src/a.ts(3,5): error TS2322: Type 'x'.\nsrc/a.ts(9,1): error TS2322: Type 'y'.\nlib/b.ts:2:1 - error TS7006: any\nerror TS5023: Unknown compiler option\n  suite du message\n";
    expect(LECTEURS.tsc(t, R, 'front', 2)).toEqual({ 'front/src/a.ts|TS2322': 2, 'front/lib/b.ts|TS7006': 1, '(global)|TS5023': 1 });
    expect(LECTEURS.tsc('', R, '.', 0)).toEqual({});
    expect(() => LECTEURS.tsc('Error: Cannot find module typescript', R, '.', 1)).toThrow('tsc a échoué (code 1) sans erreur lisible');
  });

  it('ruff-json : par fichier et code ; une erreur de syntaxe (code nul) compte', () => {
    expect(LECTEURS['ruff-json'](JSON.stringify([{ filename: '/r/app/m.py', code: 'C901' }, { filename: '/r/app/m.py', code: 'C901' }, { filename: '/r/app/n.py', code: null }]), R, '.', 1))
      .toEqual({ 'app/m.py|C901': 2, 'app/n.py|syntax-error': 1 });
  });

  it('checkstyle-xml : la règle est le dernier segment de source, sans « Check » ; un fichier sans violation ne compte pas', () => {
    const t = `<?xml version="1.0"?>\n<checkstyle version="10.12">\n<file name="/r/back/src/main/java/A.java">\n<error line="1" severity="error" message="a &amp; b" source="com.puppycrawl.tools.checkstyle.checks.sizes.MethodLengthCheck"/>\n<error line="9" source="com.puppycrawl.tools.checkstyle.checks.sizes.MethodLengthCheck"/>\n<error line="4" source="com.puppycrawl.tools.checkstyle.checks.metrics.CyclomaticComplexityCheck"/>\n</file>\n<file name="src/main/java/B.java">\n</file>\n<file name="src/main/java/C.java"/>\n</checkstyle>\n`;
    expect(LECTEURS['checkstyle-xml'](t, R, 'back', 1)).toEqual({ 'back/src/main/java/A.java|MethodLength': 2, 'back/src/main/java/A.java|CyclomaticComplexity': 1 });
  });

  it('pmd-xml, cpd-xml, spotbugs-xml : violations, duplications (|lignes) et bogues probables', () => {
    const pmd = '<pmd version="7.0.0">\n<file name="/r/src/main/java/A.java">\n<violation beginline="3" rule="CognitiveComplexity" ruleset="Design">x</violation>\n<violation rule="UnusedPrivateField">y</violation>\n</file>\n</pmd>';
    expect(LECTEURS['pmd-xml'](pmd, R, '.', 0)).toEqual({ 'src/main/java/A.java|CognitiveComplexity': 1, 'src/main/java/A.java|UnusedPrivateField': 1 });
    const cpd = '<pmd-cpd>\n<duplication lines="12" tokens="110">\n<file line="1" path="/r/src/A.java"/>\n<file line="40" path="/r/src/B.java"/>\n<codefragment>…</codefragment>\n</duplication>\n</pmd-cpd>';
    expect(LECTEURS['cpd-xml'](cpd, R, '.', 0)).toEqual({ 'src/A.java|duplication': 1, 'src/A.java|duplication|lignes': 12, 'src/B.java|duplication': 1, 'src/B.java|duplication|lignes': 12 });
    const sb = '<BugCollection version="4.8">\n<BugInstance type="NP_NULL_ON_SOME_PATH" priority="1">\n<Class classname="com.x.A"><SourceLine classname="com.x.A" sourcepath="com/x/A.java"/></Class>\n<SourceLine sourcepath="com/x/A.java" start="3"/>\n</BugInstance>\n</BugCollection>';
    expect(LECTEURS['spotbugs-xml'](sb, R, '.', 0)).toEqual({ 'com/x/A.java|NP_NULL_ON_SOME_PATH': 1 });
  });

  it('sarif : analyseurs .NET (uri file: ou relative), un résultat supprimé compte toujours (une suppression ne fait pas baisser)', () => {
    const t = JSON.stringify({ version: '2.1.0', runs: [{ results: [
      { ruleId: 'CA1822', locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///r/Api/Program.cs' } } }] },
      { ruleId: 'CA1822', suppressions: [{ kind: 'inSource' }], locations: [{ physicalLocation: { artifactLocation: { uri: 'Api/Mon%20Fichier.cs' } } }] },
      { ruleId: 'CS8618' },
    ] }] });
    expect(LECTEURS.sarif(t, R, '.', 0)).toEqual({ 'Api/Program.cs|CA1822': 1, 'Api/Mon Fichier.cs|CA1822': 1, '(global)|CS8618': 1 });
  });

  it.each([
    ['eslint-json', 'Oops: config introuvable'],
    ['eslint-json', '{"a":1}'],
    ['ruff-json', ''],
    ['sarif', '{"version":"2.1.0"}'],
    ['checkstyle-xml', '<checkstyle version="10">\n<file name="A.java">\n<error source="x.YCheck"/>'],
    ['pmd-xml', '<checkstyle></checkstyle>'],
  ])('un rapport %s tronqué, vide ou d\'un autre outil lève : jamais « zéro violation » (%j)', (format, t) => {
    expect(() => LECTEURS[format](t, '/r', '.', 1)).toThrow(/illisible/);
  });
});

describe('L801 — les directives qui éteignent une règle sont comptées comme des violations', () => {
  it('par format, dans les fichiers suivis par git sous le dossier de l\'outil', () => {
    const r = tempDir();
    git(r, 'init', '-q');
    mkdirSync(join(r, 'app')); mkdirSync(join(r, 'web'));
    writeFileSync(join(r, 'app/m.py'), 'import os  # noqa: F401\nx = 1  # ruff: noqa\ns = "# noqa dans une chaîne compte aussi : le motif est simple"\n');
    writeFileSync(join(r, 'web/a.ts'), '// eslint-disable-next-line no-x\n/* eslint-disable */\n// @ts-ignore\n');
    writeFileSync(join(r, 'web/hors-git.ts'), '// eslint-disable\n');
    writeFileSync(join(r, 'A.java'), '@SuppressWarnings("PMD.GodClass") class A { int x; // NOPMD\n}\n@SuppressFBWarnings("X")\n');
    git(r, 'add', 'app', 'web/a.ts', 'A.java');
    expect(lireDirectives(r, 'app', 'ruff-json')).toEqual({ 'app/m.py|directive:noqa': 3 });
    expect(lireDirectives(r, '.', 'eslint-json')).toEqual({ 'web/a.ts|directive:eslint-disable': 2 });
    expect(lireDirectives(r, '.', 'tsc')).toEqual({ 'web/a.ts|directive:ts-ignore': 1 });
    expect(lireDirectives(r, '.', 'pmd-xml')).toEqual({ 'A.java|directive:nopmd': 2 });
    expect(lireDirectives(r, '.', 'spotbugs-xml')).toEqual({ 'A.java|directive:suppress-fb': 1 });
    expect(lireDirectives(r, 'app', 'eslint-json')).toEqual({});
  });

  it('M3 — les extinctions sans « // eslint-disable » : config ESLint en ligne, JSDoc, @SuppressWarnings("all") pour PMD et Checkstyle', () => {
    const r = tempDir();
    git(r, 'init', '-q');
    writeFileSync(join(r, 'a.ts'), [
      '/* eslint no-console: "off" */', '/* eslint @typescript-eslint/no-explicit-any: off, max-lines: [2, 9999] */', '/** eslint-disable */',
      '/** @ts-ignore */', '/* eslint-env node */', '// eslint est un linter : ce commentaire n\'éteint rien', '',
    ].join('\n'));
    writeFileSync(join(r, 'A.java'), '@SuppressWarnings("all") class A {}\n@SuppressWarnings({"unchecked", "all"}) class B {}\n@SuppressWarnings("checkstyle:MagicNumber") class C {}\n@SuppressWarnings("unchecked") class D {}\n');
    git(r, 'add', '.');
    expect(lireDirectives(r, '.', 'eslint-json')).toEqual({ 'a.ts|directive:eslint-config': 2, 'a.ts|directive:eslint-disable': 1 });
    expect(lireDirectives(r, '.', 'tsc')).toEqual({ 'a.ts|directive:ts-ignore': 1 });
    expect(lireDirectives(r, '.', 'pmd-xml')).toEqual({ 'A.java|directive:nopmd': 2 });
    expect(lireDirectives(r, '.', 'checkstyle-xml')).toEqual({ 'A.java|directive:checkstyle-off': 3 });
  });
});

describe('L801 — le cliquet de cadence analyse', () => {
  it('--init gèle l\'existant ; la mesure égale passe ; une nouvelle violation échoue (code 1) en nommant la clé ; un nouveau fichier aussi', async () => {
    const r = await depot();
    expect(base(r)).toEqual({ 'src/a.js|no-todo': 2, 'src/a.js|no-todo|total': 2 });
    expect(await cadence(r)).toEqual({ code: 0, sortie: 'analyse : lint (.cadence/analyse/lint.json) : rien n\'empire (2 violation(s), 2 gelée(s)).' });
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    const pire = await cadence(r);
    expect(pire.code).toBe(1);
    expect(pire.sortie).toContain('  src/a.js|no-todo : 2 → 3');
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\n'); writeFileSync(join(r, 'src/b.js'), '// TODO\n');
    expect((await cadence(r)).sortie).toContain('  src/b.js|no-todo : 0 → 1');
  });

  it('une baisse passe avec un rappel ; --ecrire la fige ; --ecrire refuse et n\'écrit rien si quoi que ce soit empire ; --init ne recrée pas la base', async () => {
    const r = await depot();
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\n');
    expect((await cadence(r)).sortie).toContain('mesure(s) ont baissé : « cadence analyse --ecrire » fige le gain');
    expect(await cadence(r, '--ecrire')).toEqual({ code: 0, sortie: 'analyse : lint (.cadence/analyse/lint.json) baissée : 2 → 1 violation(s) gelée(s).' });
    expect(base(r)['src/a.js|no-todo']).toBe(1);
    writeFileSync(join(r, 'src/a.js'), 'x\n'); writeFileSync(join(r, 'src/c.js'), '// TODO\n');
    expect((await cadence(r, '--ecrire')).code).toBe(1);
    expect(base(r)['src/a.js|no-todo']).toBe(1);
    expect((await cadence(r, '--init')).code).toBe(2);
  });

  it('un outil qui plante, ou un rapport annoncé non écrit, sort en code 2 : jamais « zéro violation » ; un vieux rapport ne compte pas', async () => {
    const r = await depot();
    writeFileSync(join(r, 'src/a.js'), 'propre\n');
    const plante = spawnSync(process.execPath, [SCRIPT], { cwd: r, encoding: 'utf8', env: { ...process.env, PLANTE: '1' } });
    expect(plante.status).toBe(2);
    expect(plante.stderr).toContain('rapport JSON illisible');
    writeFileSync(join(r, 'rapport.json'), '[]');
    writeFileSync(join(r, 'cadence.yaml'), 'analyse:\n  - { name: lint, command: "true", format: eslint-json, report: rapport.json }\n');
    const absent = await cadence(r);
    expect(absent.code).toBe(2);
    expect(absent.sortie).toContain('n\'a pas écrit son rapport rapport.json');
    expect(existsSync(join(r, 'rapport.json'))).toBe(false);
  });

  it('options : usage en code 2, --outil inconnu en code 2, cadence.yaml sans clé en code 2', async () => {
    const r = await depot();
    expect((await cadence(r, '--ecrire', '--init')).code).toBe(2);
    expect((await cadence(r, '--outil', 'pmd')).sortie).toContain('outil « pmd » absent');
    writeFileSync(join(r, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
    expect((await cadence(r)).sortie).toContain('ne déclare aucun outil');
  });
});

describe('L801 — --contre : la base du lot contre celle de son départ', () => {
  it('une base relevée à la main au-dessus du départ est refusée, même quand la mesure la tient', async () => {
    const r = await depot();
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
    writeFileSync(join(r, '.cadence/analyse/lint.json'), JSON.stringify({ 'src/a.js|no-todo': 3, 'src/a.js|no-todo|total': 3 }));
    expect((await cadence(r)).code).toBe(0); // sans --contre, rien ne voit la base relevée
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('remonte par rapport à main');
    expect(refus.sortie).toContain('src/a.js|no-todo : 2 → 3');
  });

  it('une config déclarée (seuil, exclusion) changée par le lot est refusée ; un commit d\'un lot config: true du plan la change', async () => {
    const plan = 'project: p\nlots:\n  - id: L5\n    title: seuils\n    config: true\n';
    const r = await depot({ configs: true, plan });
    writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('seuils.json (modifié) diffère(nt) de main');
    git(r, 'commit', '-qam', 'feat(L4): seuils relevés');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
    git(r, 'reset', '-q', '--hard', 'main'); writeFileSync(join(r, 'seuils.json'), '{"max":9}\n');
    git(r, 'commit', '-qam', 'chore(L5): seuils relevés');
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
  });

  it('un fichier déplacé : refusé comme neuf, --migrer --contre le crédite par sa source, puis la porte passe ; une copie qui laisse sa source ne passe pas', async () => {
    const r = await depot();
    renameSync(join(r, 'src/a.js'), join(r, 'src/b.js'));
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
    expect((await cadence(r, '--migrer')).code).toBe(2);
    expect(await cadence(r, '--migrer', '--contre', 'main')).toMatchObject({ code: 0 });
    expect(base(r)).toEqual({ 'src/b.js|no-todo': 2, 'src/b.js|no-todo|total': 2 });
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'déplace');
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    git(r, 'reset', '-q', '--hard', 'main');
    writeFileSync(join(r, 'src/copie.js'), readFileSync(join(r, 'src/a.js')));
    const copie = await cadence(r, '--migrer', '--contre', 'main');
    expect(copie.code).toBe(1);
    expect(copie.sortie).toContain('fichier neuf : au-delà de ce que sa source a perdu');
  });

  it('une clé sans fichier du dépôt ((global), chemin de SpotBugs) gardée telle quelle passe la porte', async () => {
    const r = await depot({ base: false });
    writeFileSync(join(r, 'rapport.txt'), 'error TS5023: Unknown compiler option\n');
    writeFileSync(join(r, 'cadence.yaml'), 'analyse:\n  - { name: lint, command: "cat rapport.txt; exit 2", format: tsc }\n');
    git(r, 'checkout', '-q', 'main'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'outil tsc');
    expect((await cadence(r, '--init')).code).toBe(0);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'base'); git(r, 'checkout', '-qb', 'lot2');
    expect(await cadence(r, '--contre', 'main')).toMatchObject({ code: 0 });
  });

  it('une base ne naît que dans un lot config: true : refusée ailleurs ; sur la branche du lot de config, --init --contre la crée et la re-mesure', async () => {
    const plan = 'project: p\nlots:\n  - id: L5\n    title: adopter lint\n    config: true\n';
    const r = await depot({ base: false, plan });
    const refus = await cadence(r, '--init', '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('.cadence/analyse/lint.json (nouveau) diffère(nt) de main');
    expect(existsSync(join(r, '.cadence/analyse/lint.json'))).toBe(false);
    git(r, 'checkout', '-q', 'main'); git(r, 'checkout', '-qb', 'cadence/run--L5');
    expect((await cadence(r, '--init', '--contre', 'main')).code).toBe(0);
    expect((await cadence(r, '--init', '--contre', 'main')).code).toBe(0);
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    writeFileSync(join(r, 'src/a.js'), 'x\n'); // un lot de config ne touche que les configs
    expect((await cadence(r, '--contre', 'main')).sortie).toContain('src/a.js : un lot déclaré « config: true » au plan ne touche que les fichiers de config');
  });

  it.each([
    ['le nom', 'name', 'lint2'],
    ['la commande', 'command', 'node outil.mjs || true'],
    ['le chemin de la base', 'baseline', 'autre/lint.json'],
    ['le dossier', 'dir', 'src'],
  ])('M1 — changer %s de l\'outil dans cadence.yaml ne donne pas une base neuve, donc libre : refusé hors lot config: true', async (_, cle, valeur) => {
    const r = await depot();
    writeFileSync(join(r, 'src/a.js'), 'x // TODO\ny // TODO\nz // TODO\n');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
    const y = readFileSync(join(r, 'cadence.yaml'), 'utf8');
    writeFileSync(join(r, 'cadence.yaml'), cle === 'name' ? y.replace('name: lint', 'name: lint2') : cle === 'command' ? y.replace('command: node outil.mjs', `command: ${valeur}`) : `${y}    ${cle}: ${valeur}\n`);
    const init = await cadence(r, '--init', '--contre', 'main');
    expect(init.code).toBe(1);
    expect(init.sortie).toMatch(/cadence\.yaml#analyse\.lint2? \((nouveau|modifié|supprimé)\)/);
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat(L4): outil changé');
    expect((await cadence(r, '--init', '--contre', 'main')).code).toBe(1);
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
  });

  it('M1 — renommer l\'outil dans un lot config: true (commits qui ne citent que lui) passe ; un commit d\'un autre lot sur cadence.yaml non', async () => {
    const plan = 'project: p\nlots:\n  - id: L5\n    title: renommer\n    config: true\n';
    const r = await depot({ plan });
    writeFileSync(join(r, 'cadence.yaml'), readFileSync(join(r, 'cadence.yaml'), 'utf8').replace('name: lint', 'name: lint2'));
    git(r, 'commit', '-qam', 'chore(L5): renomme l\'outil');
    expect((await cadence(r, '--init', '--contre', 'main')).sortie).toContain('.cadence/analyse/lint2.json (nouveau)'); // base pas encore commitée
    expect((await cadence(r, '--init')).code).toBe(0); // hors branche du lot de config : créée sans --contre, puis commitée par le lot de config
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'chore(L5): base de lint2');
    expect((await cadence(r, '--contre', 'main')).code).toBe(0);
    writeFileSync(join(r, 'cadence.yaml'), readFileSync(join(r, 'cadence.yaml'), 'utf8').replace('node outil.mjs', 'node outil.mjs; true'));
    git(r, 'commit', '-qam', 'feat(L4): commande');
    expect((await cadence(r, '--contre', 'main')).code).toBe(1);
  });

  it('M2 — un fichier déplacé dont la base est relevée à la main au-dessus de sa mesure n\'ouvre pas de marge (L707, neufsAuDessus de qualite.mjs)', async () => {
    const r = await depot();
    renameSync(join(r, 'src/a.js'), join(r, 'src/b.js'));
    writeFileSync(join(r, 'src/b.js'), 'x // TODO\nz\n');
    expect((await cadence(r, '--migrer', '--contre', 'main')).code).toBe(0);
    expect(base(r)).toEqual({ 'src/b.js|no-todo': 1, 'src/b.js|no-todo|total': 1 });
    writeFileSync(join(r, '.cadence/analyse/lint.json'), JSON.stringify({ 'src/b.js|no-todo': 2, 'src/b.js|no-todo|total': 2 }));
    git(r, 'add', '-A'); git(r, 'commit', '-qm', 'feat(L4): déplace');
    const refus = await cadence(r, '--contre', 'main');
    expect(refus.code).toBe(1);
    expect(refus.sortie).toContain('clé(s) de fichier neuf au-dessus de la mesure');
    expect(refus.sortie).toContain('src/b.js|no-todo : 2 → 1');
    expect((await cadence(r)).code).toBe(0); // sans --contre, rien ne connaît le départ
  });
});

describe('L801 — l\'étape de la porte de cadence run', () => {
  it('une commande, ce script contre la cible ; rien sans la clé ; une clé mal formée est un refus', () => {
    expect(etapeAnalyse(undefined, 'main')).toEqual({ commandes: [] });
    const { commandes } = etapeAnalyse([{ name: 'ruff', command: 'ruff check', format: 'ruff-json' }], 'main');
    expect(commandes).toHaveLength(1);
    expect(commandes[0]).toContain(SCRIPT);
    expect(commandes[0]).toMatch(/ --contre main$/);
    expect(etapeAnalyse([{ name: 'x', format: 'ruff-json' }], 'main').refus).toBe('cadence.yaml : analyse[0].command : commande non vide attendue');
  });
});
