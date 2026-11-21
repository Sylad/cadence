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
function projet(): string {
  const repo = depot('true'), ordre = join(repo, '..', 'ordre.log');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: echo build >> ${ordre}\n  test: echo tests >> ${ordre}\nanalyse:\n  - { name: lint, command: ORDRE=${ordre} node outil.mjs, format: eslint-json }\n`);
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
