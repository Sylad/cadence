import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloneModifie, TestsIntrouvables, jouerTests, lectureReferences, maintenabilite, regressions } from '../src/sequence/mesures.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
function depot(): string {
  const d = mkdtempSync(join(tmpdir(), 'mesures-'));
  g(d, 'init', '-q'); mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules\n.vite\n');
  g(d, 'add', '.'); g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return d;
}
// Fausse commande de test : écrit le JSON de vitest pour les fichiers reçus ; « ok » passe, « ko » échoue.
function faux(mode = ''): string {
  const f = join(mkdtempSync(join(tmpdir(), 'faux-')), 'faux.cjs');
  writeFileSync(f, `const fs=require('fs');const a=process.argv.slice(2);
const out=a.find(x=>x.startsWith('--outputFile=')).slice(13);const files=a.filter(x=>!x.startsWith('--'));
${mode}
const testResults=files.map(n=>({name:n,assertionResults:[{ancestorTitles:['suite'],title:'ok',fullName:'suite ok',status:'passed'},
{ancestorTitles:['suite'],title:'ko',fullName:'suite ko',status:n.includes('b.')?'failed':'passed'}]}));
fs.writeFileSync(out,JSON.stringify({testResults}));process.exit(1);`);
  return `node ${f}`;
}
const cache = (d: string) => { const s = join(d, '..', `src-${Math.random()}.spec.ts`); writeFileSync(s, 'x'); return s; };

describe('jouerTests', () => {
  it('copie, lance, lit les statuts par id, et laisse le clone intact', () => {
    const d = depot(); const s1 = cache(d); const s2 = cache(d);
    const r = jouerTests(d, [{ src: s1, dest: 'src/a.spec.ts' }, { src: s2, dest: 'src/b.spec.ts' }], faux(), 20_000);
    expect(r).toMatchObject({ passes: 3, total: 4, echoues: ['src/b.spec.ts > suite > ko'] });
    expect(r.statuts['src/a.spec.ts > suite > ok']).toBe(true);
    expect(existsSync(join(d, 'src', 'a.banc-cache.spec.ts'))).toBe(false);
    expect(g(d, 'status', '--porcelain')).toBe('');
  });
  it('nettoie aussi quand la commande plante sans rien écrire', () => {
    const d = depot();
    expect(() => jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], 'node -e "process.exit(2)"', 20_000)).toThrow();
    expect(existsSync(join(d, 'src', 'a.banc-cache.spec.ts'))).toBe(false);
    expect(g(d, 'status', '--porcelain')).toBe('');
  });
  it('lève CloneModifie si la commande laisse un fichier dans le clone', () => {
    const d = depot();
    const cmd = faux(`fs.writeFileSync(${JSON.stringify(join(d, 'trace.txt'))},'x');`);
    expect(() => jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], cmd, 20_000)).toThrow(CloneModifie);
    expect(existsSync(join(d, 'src', 'a.banc-cache.spec.ts'))).toBe(false);
  });
  it('lit le vrai format de vitest (un test vert, un rouge)', () => {
    const d = depot();
    const h = mkdtempSync(join(tmpdir(), 'hid-'));
    writeFileSync(join(h, 'p.ts'), "import {it,expect} from 'vitest';it('vert',()=>expect(1).toBe(1));\n");
    writeFileSync(join(h, 'q.ts'), "import {describe,it,expect} from 'vitest';describe('grp',()=>{it('rouge',()=>expect(1).toBe(2));});\n");
    const bin = join(import.meta.dirname, '..', 'node_modules', '.bin', 'vitest');
    const r = jouerTests(d, [{ src: join(h, 'p.ts'), dest: 'src/p.spec.ts' }, { src: join(h, 'q.ts'), dest: 'src/q.spec.ts' }],
      `${bin} run --root . --config /dev/null`, 60_000);
    expect(r.statuts).toEqual({ 'src/p.spec.ts > vert': true, 'src/q.spec.ts > grp > rouge': false });
    expect(r).toMatchObject({ passes: 1, total: 2 });
    expect(g(d, 'status', '--porcelain')).toBe('');
  });
});

const vitestBin = join(import.meta.dirname, '..', 'node_modules', '.bin', 'vitest');
const cacheTxt = (d: string, txt: string) => { const s = join(d, '..', `h-${Math.random()}.ts`); writeFileSync(s, txt); return s; };
const fauxJson = (tests: object[]) => { const f = join(mkdtempSync(join(tmpdir(), 'fj-')), 'f.cjs');
  writeFileSync(f, `const a=process.argv.slice(2);const o=a.find(x=>x.startsWith('--outputFile=')).slice(13);const n=a.find(x=>!x.startsWith('--'));
require('fs').writeFileSync(o,JSON.stringify({testResults:[{name:n,status:'passed',assertionResults:${JSON.stringify(tests)}}]}));`); return `node ${f}`; };

describe('jouerTests, échec fermé et restauration', () => {
  it('include du projet : le nom de copie garde .test.ts ; un fichier filtré par l\'include lève TestsIntrouvables', () => {
    const d = depot();
    writeFileSync(join(d, 'vitest.config.mjs'), "export default { test: { include: ['test/**/*.test.ts'] } };\n");
    g(d, 'add', '.'); g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'cfg');
    const vert = cacheTxt(d, "import {it,expect} from 'vitest';it('vert',()=>expect(1).toBe(1));\n");
    const r = jouerTests(d, [{ src: vert, dest: 'test/x.test.ts' }], vitestBin + ' run', 60_000);
    expect(r.statuts).toEqual({ 'test/x.test.ts > vert': true });
    expect(() => jouerTests(d, [{ src: vert, dest: 'src/y.spec.ts' }], vitestBin + ' run', 60_000)).toThrow(TestsIntrouvables);
    expect(g(d, 'status', '--porcelain')).toBe('');
  });
  it('import cassé : fichier en erreur, ids connus passés au rouge', () => {
    const d = depot();
    const casse = cacheTxt(d, "import './inexistant.js';import {it} from 'vitest';it('a',()=>{});\n");
    const r = jouerTests(d, [{ src: casse, dest: 'src/c.spec.ts' }], `${vitestBin} run`, 60_000, ['src/c.spec.ts > a', 'autre > z']);
    expect(r.fichiers_en_erreur).toEqual(['src/c.spec.ts']);
    expect(r.statuts['src/c.spec.ts > a']).toBe(false);
    expect(r.statuts['autre > z']).toBeUndefined();
    expect(r.passes).toBe(0);
  });
  it('aucun test : TestsIntrouvables', () => {
    const d = depot();
    expect(() => jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], fauxJson([]), 20_000)).toThrow(TestsIntrouvables);
  });
  it('doublons suffixés #2, skipped et todo comptés à part', () => {
    const d = depot();
    const t = (title: string, status: string) => ({ ancestorTitles: [], title, status });
    const r = jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], fauxJson([t('x', 'passed'), t('x', 'failed'), t('s', 'skipped'), t('d', 'todo')]), 20_000);
    expect(r.statuts).toEqual({ 'src/a.spec.ts > x': true, 'src/a.spec.ts > x #2': false });
    expect(r.ignores).toBe(2);
  });
  it('balaie une copie laissée par un run planté, snapshots compris', () => {
    const d = depot();
    mkdirSync(join(d, 'src', '__snapshots__'));
    writeFileSync(join(d, 'src', 'old.banc-cache.spec.ts'), 'x');
    writeFileSync(join(d, 'src', '__snapshots__', 'old.banc-cache.spec.ts.snap'), 'x');
    jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], faux(), 20_000);
    expect(g(d, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
  it('restaure un suivi modifié et supprime un neuf, puis lève CloneModifie', () => {
    const d = depot();
    const cmd = faux(`fs.writeFileSync(${JSON.stringify(join(d, 'src', 'a.ts'))},'pirate');fs.writeFileSync(${JSON.stringify(join(d, 'neuf.txt'))},'x');`);
    expect(() => jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], cmd, 20_000)).toThrow(CloneModifie);
    expect(readFileSync(join(d, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(d, 'neuf.txt'))).toBe(false);
  });
  it('un non suivi déjà présent dont le contenu change est détecté, jamais touché', () => {
    const d = depot();
    const p = join(d, 'brouillon.txt'); writeFileSync(p, 'v1');
    expect(() => jouerTests(d, [{ src: cache(d), dest: 'src/a.spec.ts' }], faux(`fs.writeFileSync(${JSON.stringify(p)},'v2');`), 20_000)).toThrow(/non touché brouillon\.txt/);
    expect(readFileSync(p, 'utf8')).toBe('v2');
  });
  it('retire les dossiers créés pour les copies', () => {
    const d = depot();
    jouerTests(d, [{ src: cache(d), dest: 'nouveau/profond/a.spec.ts' }], faux(), 20_000);
    expect(existsSync(join(d, 'nouveau'))).toBe(false);
  });
});

describe('regressions', () => {
  it('ne compte que passé avant puis rouge après (rouge déjà avant ignoré, nouveau test rouge ignoré)', () => {
    const avant = { a: true, b: false, c: true, d: true };
    const apres = { a: false, b: false, c: true, e: false, d: true };
    expect(regressions(avant, apres)).toEqual(['a']);
  });
  it('un vert d\'avant absent d\'après est une régression (échec fermé)', () => {
    expect(regressions({ a: true, b: false }, { })).toEqual(['a']);
  });
});

const ligne = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
describe('lectureReferences', () => {
  const pieces = ['/ref/spec.pdf', '/ref/maquette.pdf', '/ref/autre.md'];
  it('compte avant la première écriture, signale après-écriture, manquantes et partielles', () => {
    const l = [ligne('Read', { file_path: '/ref/spec.pdf' }), ligne('Read', { file_path: '/ref/maquette.pdf', pages: '1' }),
      ligne('Read', { file_path: '/c/clone/hors-liste.md' }), ligne('Edit', { file_path: '/c/clone/src/x.ts' }),
      ligne('Read', { file_path: '/ref/autre.md' }), 'pas du json'];
    expect(lectureReferences(l, pieces, '/c/clone')).toEqual({ ouvertes: ['/ref/spec.pdf', '/ref/maquette.pdf'], manquantes: [],
      apres_ecriture: ['/ref/autre.md'], partielles: ['/ref/maquette.pdf'] });
  });
  it('une écriture hors du clone ne ferme pas la fenêtre ; une pièce jamais lue est manquante', () => {
    const l = [ligne('Write', { file_path: '/tmp/notes.md' }), ligne('Read', { file_path: '/ref/spec.pdf' })];
    const r = lectureReferences(l, pieces, '/c/clone');
    expect(r.ouvertes).toEqual(['/ref/spec.pdf']); expect(r.manquantes).toEqual(['/ref/maquette.pdf', '/ref/autre.md']);
  });
  it('une lecture complète après une partielle n\'est plus partielle', () => {
    const l = [ligne('Read', { file_path: '/ref/spec.pdf', limit: 10 }), ligne('Read', { file_path: '/ref/spec.pdf' })];
    expect(lectureReferences(l, ['/ref/spec.pdf']).partielles).toEqual([]);
  });
});

describe('lectureReferences, cas annexes', () => {
  it('NotebookEdit (notebook_path) ferme la fenêtre ; un sous-agent compte', () => {
    const l = [ligne('Read', { file_path: '/ref/a.md' }), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/ref/b.md' } }] } }),
      ligne('NotebookEdit', { notebook_path: '/c/clone/n.ipynb' }), ligne('Read', { file_path: '/ref/c.md' })];
    expect(lectureReferences(l, ['/ref/a.md', '/ref/b.md', '/ref/c.md'], '/c/clone')).toMatchObject({ ouvertes: ['/ref/a.md', '/ref/b.md'], apres_ecriture: ['/ref/c.md'] });
  });
});

describe('maintenabilite', () => {
  it('compte les tailles et met null (jamais 0) si jscpd est absent', () => {
    const d = depot();
    writeFileSync(join(d, 'src', 'gros.ts'), 'x\n'.repeat(450));
    const m = maintenabilite(d, ['src'], ['/introuvable/jscpd']);
    expect(m.duplication_pct).toBeNull();
    expect(m.raison).toMatch(/ENOENT|introuvable/);
    expect(m.fichiers_400).toBe(1);
    expect(m.plus_gros[0]).toEqual({ fichier: 'src/gros.ts', lignes: 451 });
  });
});

describe('jouerTests, suite du projet (R24)', () => {
  it('sans copie, commande avec <sortie> : ids relatifs au clone, clone intact', () => {
    const d = depot();
    writeFileSync(join(d, 'src', 'v.spec.ts'), "import {it,expect} from 'vitest';it('vert',()=>expect(1).toBe(1));it('rouge',()=>expect(1).toBe(2));\n");
    g(d, 'add', '.'); g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'spec');
    const r = jouerTests(d, [], `${vitestBin} run --reporter=json --outputFile=<sortie>/suite.json`, 60_000);
    expect(r.statuts).toEqual({ 'src/v.spec.ts > vert': true, 'src/v.spec.ts > rouge': false });
    expect(g(d, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});
