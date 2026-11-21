// L801 (D-23) : l'étape « analyse » de la porte de cadence run — la clé analyse: de cadence.yaml, jouée entre le build et les tests, contre la cible du
// run ; une nouvelle violation rend la porte rouge (correction par la même session), une base relevée par la session aussi, l'existant gelé passe.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { SCRIPT } from '../../scripts/analyse.mjs';
import { depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
// Faux outil au format ESLint : une violation `no-todo` par ligne « TODO » des fichiers .js de src/.
const OUTIL = `import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
appendFileSync(process.env.ORDRE ?? 'ordre.log', 'analyse\\n');
console.log(JSON.stringify(readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => ({ filePath: process.cwd() + '/src/' + f,
  messages: readFileSync('src/' + f, 'utf8').split('\\n').filter((l) => l.includes('TODO')).map(() => ({ ruleId: 'no-todo', message: 'todo' })) }))));
`;

/** Un projet dont la porte a un build, l'analyse (src/a.js : une violation gelée) et des tests ; chaque étape note son passage dans ../ordre.log. */
function projet(configs = ''): string {
  const repo = depot('true'), ordre = join(repo, '..', 'ordre.log');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: echo build >> ${ordre}\n  test: echo tests >> ${ordre}\nanalyse:\n  - { name: lint, command: ORDRE=${ordre} node outil.mjs, format: eslint-json${configs} }\n`);
  execFileSync('mkdir', ['-p', join(repo, 'src')]);
  writeFileSync(join(repo, 'outil.mjs'), OUTIL);
  writeFileSync(join(repo, 'src/a.js'), 'x // TODO\n');
  execFileSync(process.execPath, [SCRIPT, '--init'], { cwd: repo });
  writeFileSync(ordre, ''); // --init a joué l'outil : seule la porte du run compte
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'analyse');
  return repo;
}
const ecrit = (f: string, texte: string) => (cwd: string) => { writeFileSync(join(cwd, f), texte); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', `feat(L9): ${f}`); };

describe('cadence run : l\'étape analyse de la porte (L801)', () => {
  it('jouée entre le build et les tests ; le code qui garde l\'existant gelé est intégré', () => {
    const repo = projet(), { out } = io();
    const e = executerRun({ repo, demande: 'Ajoute b', lot: 'L9', exec: fauxClaude([ecrit('src/b.js', 'propre\n')]), out });
    expect(e.etat).toBe('integre');
    expect(readFileSync(join(repo, '..', 'ordre.log'), 'utf8')).toBe('build\nanalyse\ntests\n');
  });

  it('une nouvelle violation rend la porte rouge, nommée ; la même session la corrige et le run est intégré', () => {
    const repo = projet(), { l, out } = io(), prompts: string[] = [];
    const exec = fauxClaude([ecrit('src/b.js', 'y // TODO\n'), (cwd, args) => { prompts.push(args[1]); ecrit('src/b.js', 'y\n')(cwd); }]);
    const e = executerRun({ repo, demande: 'Ajoute b', lot: 'L9', exec, out });
    expect(e.etat).toBe('integre');
    expect(prompts[0]).toContain(`${SCRIPT} --contre main`);
    expect(prompts[0]).toContain('src/b.js|no-todo : 0 → 1');
    expect(l.join('\n')).toContain('porte rouge : reprise de la session pour corriger');
  });

  it('une base relevée par la session pour faire passer sa violation est refusée (rouge deux fois : rendue au lead)', () => {
    const repo = projet(), { out } = io();
    const tricher = (cwd: string) => {
      writeFileSync(join(cwd, 'src/a.js'), 'x // TODO\nz // TODO\n');
      writeFileSync(join(cwd, '.cadence/analyse/lint.json'), JSON.stringify({ 'src/a.js|no-todo': 2, 'src/a.js|no-todo|total': 2 }));
      git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'feat(L9): base');
    };
    const e = executerRun({ repo, demande: 'Ajoute z', lot: 'L9', exec: fauxClaude([tricher, () => {}]), out });
    expect(e.etat).toBe('porte-rouge');
    expect(e.detail).toContain('remonte par rapport à main');
  });

  it('une clé analyse: mal formée : rien n\'est joué, le run le dit (sans-porte)', () => {
    const repo = projet(), { out } = io();
    const casser = (cwd: string) => { writeFileSync(join(cwd, 'cadence.yaml'), 'orchestrate:\n  test: "true"\nanalyse:\n  - { name: lint, format: tsc }\n'); git(cwd, ...ID, 'commit', '-qam', 'feat(L9): yaml'); };
    const e = executerRun({ repo, demande: 'Casse', lot: 'L9', exec: fauxClaude([casser]), out });
    expect(e.etat).toBe('sans-porte');
    expect(e.detail).toContain('analyse[0].command : commande non vide attendue');
  });
});

// Revue L801 r3 — M2 : la porte du run ne gardait que la sortie d'une porte rouge ; ce que l'analyse d'une porte VERTE dit à relire va au journal et au
// détail de l'état integre (ce que lisent le lead et cadence run --liste). M1 et M3, par cadence run.
describe('cadence run : une porte verte dit la ligne de base neuve et la config changée (L801 r3)', () => {
  /** La session adopte un second outil, `lint2` : entrée, base (mesurée par --init, ou `base` écrite à la main), commit avec la ligne d'adoption. */
  const adopter = (base?: Record<string, number>) => (cwd: string) => {
    writeFileSync(join(cwd, 'cadence.yaml'), `${readFileSync(join(cwd, 'cadence.yaml'), 'utf8')}  - { name: lint2, command: node outil.mjs, format: eslint-json }\n`);
    if (base) writeFileSync(join(cwd, '.cadence/analyse/lint2.json'), JSON.stringify(base));
    else execFileSync(process.execPath, [SCRIPT, '--init', '--outil', 'lint2'], { cwd });
    git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'feat(L9): adopte lint2\n\nAnalyse-adoption: lint2');
  };

  it('le scénario de la revue (main a déjà lint, la session adopte lint2) : intégré, et « ligne de base neuve » est au journal, une fois, et au détail', () => {
    const repo = projet(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Adopte lint2', lot: 'L9', exec: fauxClaude([adopter()]), out });
    expect(e.etat).toBe('integre');
    const dite = /^analyse : ligne de base neuve : lint2 \(\.cadence\/analyse\/lint2\.json\) — adoption déclarée par le commit [0-9a-f]{7,} \(Analyse-adoption: lint2\)$/;
    expect(l.filter((x) => dite.test(x))).toHaveLength(1);
    expect(e.detail).toMatch(/^analyse : ligne de base neuve : lint2 \(\.cadence\/analyse\/lint2\.json\) — adoption déclarée par le commit [0-9a-f]{7,} \(Analyse-adoption: lint2\) — à relire$/m);
    // la ligne de fin du run, que le lead lit, porte le détail
    expect(l.join('\n')).toMatch(/cadence run \S+ : integre[^\n]*\nanalyse : ligne de base neuve : lint2/);
  });

  it('un run sans base neuve ne dit rien de tel, et son détail reste vide', () => {
    const repo = projet(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Ajoute b', lot: 'L9', exec: fauxClaude([ecrit('src/b.js', 'propre\n')]), out });
    expect(e.etat).toBe('integre');
    expect(e.detail).toBe('');
    expect(l.join('\n')).not.toContain('ligne de base neuve');
  });

  it('M1 par cadence run : la base de lint2 gonflée à 40 fois la mesure rend la porte rouge ; la session la re-mesure et le run est intégré, base dite', () => {
    const repo = projet(), { l, out } = io(), prompts: string[] = [];
    const remesurer = (cwd: string, args: string[]) => {
      prompts.push(args[1]);
      execFileSync(process.execPath, [SCRIPT, '--init', '--outil', 'lint2', '--contre', 'main'], { cwd });
      git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'fix(L9): la mesure');
    };
    const e = executerRun({ repo, demande: 'Adopte lint2', lot: 'L9', exec: fauxClaude([adopter({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40 }), remesurer]), out });
    expect(prompts[0]).toContain('ligne de base neuve (absente de main');
    expect(prompts[0]).toContain('src/a.js|no-todo : 40 → 1');
    expect(e.etat).toBe('integre');
    expect(JSON.parse(readFileSync(join(repo, '.cadence/analyse/lint2.json'), 'utf8'))).toEqual({ 'src/a.js|no-todo': 1, 'src/a.js|no-todo|total': 1 });
    expect(l.filter((x) => x.startsWith('analyse : ligne de base neuve : lint2'))).toHaveLength(1);
    expect(e.detail).toContain('analyse : ligne de base neuve : lint2');
  });

  it('M1 par cadence run : gonflée et jamais corrigée, rendue au lead (porte-rouge), rien d\'intégré', () => {
    const repo = projet(), { out } = io();
    const e = executerRun({ repo, demande: 'Adopte lint2', lot: 'L9', exec: fauxClaude([adopter({ 'src/a.js|no-todo': 40, 'src/a.js|no-todo|total': 40 }), () => {}]), out });
    expect(e.etat).toBe('porte-rouge');
    expect(e.detail).toContain('ligne de base neuve (absente de main');
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('lint2.json');
  });

  it('M3 par cadence run (projet sans plan natif) : une config d\'outil changée sans « Analyse-config » est rouge ; déclarée, le run est intégré et le dit', () => {
    const seuil = (message: string) => (cwd: string) => { writeFileSync(join(cwd, 'seuils.json'), '{"max":9}\n'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', message); };
    const rouge = executerRun({ repo: projet(', configs: [seuils.json]'), demande: 'Seuil', lot: 'L9', exec: fauxClaude([seuil('feat(L9): seuil'), () => {}]), out: io().out });
    expect(rouge.etat).toBe('porte-rouge');
    expect(rouge.detail).toContain('« Analyse-config: lint » dans le message d\'un commit du lot');
    const { l, out } = io();
    const e = executerRun({ repo: projet(', configs: [seuils.json]'), demande: 'Seuil', lot: 'L9', exec: fauxClaude([seuil('feat(L9): seuil\n\nAnalyse-config: lint')]), out });
    expect(e.etat).toBe('integre');
    expect(l.filter((x) => /^analyse : config changée : lint — seuils\.json \(nouveau\) — changement déclaré par le commit [0-9a-f]{7,} \(Analyse-config: lint\)$/.test(x))).toHaveLength(1);
    expect(e.detail).toMatch(/analyse : config changée : lint — seuils\.json \(nouveau\) — .* — à relire/);
  });
});
