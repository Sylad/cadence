import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloneModifie, TestsIntrouvables, jouerTests, lectureReferences, maintenabilite } from '../src/sequence/mesures.js';
import { dossierTemp } from './temp.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
function depot(): string {
  const d = dossierTemp('mesures-');
  g(d, 'init', '-q'); mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules\n.vite\n');
  g(d, 'add', '.'); g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return d;
}
// Fausse commande de test : écrit le JSON de vitest pour les fichiers reçus ; « ok » passe, « ko » échoue.
function faux(mode = ''): string {
  const f = join(dossierTemp('faux-'), 'faux.cjs');
  writeFileSync(f, `const fs=require('fs');const a=process.argv.slice(2);
const out=a.find(x=>x.startsWith('--outputFile=')).slice(13);const files=a.filter(x=>!x.startsWith('--'));
${mode}
const testResults=files.map(n=>({name:n,assertionResults:[{ancestorTitles:['suite'],title:'ok',fullName:'suite ok',status:'passed'},
{ancestorTitles:['suite'],title:'ko',fullName:'suite ko',status:n.includes('b.')?'failed':'passed'}]}));
fs.writeFileSync(out,JSON.stringify({testResults}));process.exit(1);`);
  return `node ${f}`;
}
const cache = (d: string) => { void d; const s = join(dossierTemp('cache-'), 'src.spec.ts'); writeFileSync(s, 'x'); return s; };

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
    const h = dossierTemp('hid-');
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
const cacheTxt = (d: string, txt: string) => { void d; const s = join(dossierTemp('cache-'), 'h.ts'); writeFileSync(s, txt); return s; };
const fauxJson = (tests: object[]) => { const f = join(dossierTemp('fj-'), 'f.cjs');
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

let idOutil = 0; // chaque appel porte un id ; son résultat réussi suit sur la même ligne logique (R31 : seul un Read réussi compte)
const ligne = (name: string, input: object) => { const id = `m${++idOutil}`;
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } })}`; };
const L = (l: string[]) => l.flatMap((x) => x.split('\n'));
describe('lectureReferences', () => {
  const pieces = ['/ref/spec.pdf', '/ref/maquette.pdf', '/ref/autre.md'];
  it('compte avant la première écriture, signale après-écriture, manquantes et partielles', () => {
    const l = [ligne('Read', { file_path: '/ref/spec.pdf' }), ligne('Read', { file_path: '/ref/maquette.pdf', pages: '1' }),
      ligne('Read', { file_path: '/c/clone/hors-liste.md' }), ligne('Edit', { file_path: '/c/clone/src/x.ts' }),
      ligne('Read', { file_path: '/ref/autre.md' }), 'pas du json'];
    expect(lectureReferences(L(l), pieces, '/c/clone')).toEqual({ ouvertes: ['/ref/spec.pdf', '/ref/maquette.pdf'], manquantes: [],
      apres_ecriture: ['/ref/autre.md'], partielles: ['/ref/maquette.pdf'], pages_inconnues: [] });
  });
  it('une écriture hors du clone ne ferme pas la fenêtre ; une pièce jamais lue est manquante', () => {
    const l = [ligne('Write', { file_path: '/tmp/notes.md' }), ligne('Read', { file_path: '/ref/spec.pdf' })];
    const r = lectureReferences(L(l), pieces, '/c/clone');
    expect(r.ouvertes).toEqual(['/ref/spec.pdf']); expect(r.manquantes).toEqual(['/ref/maquette.pdf', '/ref/autre.md']);
  });
  it('une lecture complète après une partielle n\'est plus partielle', () => {
    const l = [ligne('Read', { file_path: '/ref/spec.pdf', limit: 10 }), ligne('Read', { file_path: '/ref/spec.pdf' })];
    expect(lectureReferences(L(l), ['/ref/spec.pdf']).partielles).toEqual([]);
  });
});

describe('lectureReferences, cas annexes', () => {
  it('NotebookEdit (notebook_path) ferme la fenêtre ; un sous-agent compte', () => {
    const l = [ligne('Read', { file_path: '/ref/a.md' }), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'sb', name: 'Read', input: { file_path: '/ref/b.md' } }] } }),
      JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'sb' }] } }),
      ligne('NotebookEdit', { notebook_path: '/c/clone/n.ipynb' }), ligne('Read', { file_path: '/ref/c.md' })];
    expect(lectureReferences(L(l), ['/ref/a.md', '/ref/b.md', '/ref/c.md'], '/c/clone')).toMatchObject({ ouvertes: ['/ref/a.md', '/ref/b.md'], apres_ecriture: ['/ref/c.md'] });
  });
});

describe('lectureReferences, écritures sans effet (S7)', () => {
  const res = (id: string, contenu: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: contenu }] } });
  const app = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  it('un Edit refusé par le hook ou en erreur, un Bash refusé par le hook ne ferment pas la fenêtre ; un Bash en erreur par son code de sortie, si', () => {
    const l = [app('r1', 'Edit', { file_path: '/c/clone/a.ts' }), res('r1', "PreToolUse:Edit hook error: Lis d'abord en entier"),
      app('r2', 'Write', { file_path: '/c/clone/b.ts' }), res('r2', 'File has not been read yet'),
      app('r3', 'Bash', { command: 'echo x > a.ts', cwd: '/c/clone' }), res('r3', 'PreToolUse:Bash hook error: refusé'),
      ...L([ligne('Read', { file_path: '/ref/a.md' })]),
      app('r4', 'Bash', { command: 'echo x > a.ts' }), res('r4', 'Exit code 1'), ...L([ligne('Read', { file_path: '/ref/b.md' })])];
    expect(lectureReferences(l, ['/ref/a.md', '/ref/b.md'], '/c/clone')).toMatchObject({ ouvertes: ['/ref/a.md'], apres_ecriture: ['/ref/b.md'] });
  });
});

describe('maintenabilite', () => {
  it('ne compte que les fichiers du dépôt : un cache ignoré par .gitignore (.angular/) est exclu, un fichier nouveau compte ; jscpd reçoit --gitignore', () => {
    const d = depot();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n.angular/\n');
    mkdirSync(join(d, 'src', '.angular', 'cache'), { recursive: true });
    writeFileSync(join(d, 'src', '.angular', 'cache', 'vendor.js'), 'x\n'.repeat(900));
    writeFileSync(join(d, 'src', 'nouveau.ts'), 'x\n'.repeat(500));
    const trace = join(dossierTemp('jscpd-'), 'args.json');
    const faux = join(dirname(trace), 'faux.cjs');
    writeFileSync(faux, `require('fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)));`);
    const m = maintenabilite(d, ['src'], [process.execPath, faux]);
    expect(m.plus_gros.map((x) => x.fichier)).toEqual(['src/nouveau.ts', 'src/a.ts']);
    expect(m.fichiers_400).toBe(1);
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual(expect.arrayContaining(['--gitignore', '**/node_modules/**,**/.*/**,**/dist/**']));
  });
  it('compte les tailles et met null (jamais 0) si jscpd est absent', () => {
    const d = depot();
    writeFileSync(join(d, 'src', 'gros.ts'), 'x\n'.repeat(450));
    const m = maintenabilite(d, ['src'], ['/introuvable/jscpd']);
    expect(m.duplication_pct).toBeNull();
    expect(m.raison).toMatch(/ENOENT|introuvable/);
    expect(m.fichiers_400).toBe(1);
    expect(m.plus_gros[0]).toEqual({ fichier: 'src/gros.ts', lignes: 451 });
  });
  it('ignore un lien symbolique cassé et un lien vers un dossier', () => {
    const d = depot();
    symlinkSync('/nulle/part.ts', join(d, 'src', 'casse.ts')); symlinkSync(d, join(d, 'src', 'boucle'));
    expect(maintenabilite(d, ['src'], ['/introuvable/jscpd']).plus_gros.map((x) => x.fichier)).toEqual(['src/a.ts']);
  });
});

describe('jouerTests, suite du projet (R24)', () => {
  it('sans copie, commande avec <sortie> : ids relatifs au clone, clone intact', () => {
    const d = depot();
    writeFileSync(join(d, 'src', 'v.spec.ts'), "import {it,expect} from 'vitest';it('vert',()=>expect(1).toBe(1));it('rouge',()=>expect(1).toBe(2));\n");
    g(d, 'add', '.'); g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'spec');
    const brut = join(dossierTemp('brut-'), 'suite.json');
    const r = jouerTests(d, [], `${vitestBin} run --reporter=json --outputFile=<sortie>/suite.json`, 60_000, [], brut);
    expect(JSON.parse(readFileSync(brut, 'utf8')).testResults).toHaveLength(1);
    expect(r.statuts).toEqual({ 'src/v.spec.ts > vert': true, 'src/v.spec.ts > rouge': false });
    expect(g(d, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});

describe('lectureReferences, couverture (R31)', () => {
  const d = dossierTemp('couv-');
  const long = join(d, 'long.md'), pdf = join(d, 'sans-pages.pdf');
  writeFileSync(long, 'l\n'.repeat(2500)); writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
  it('texte de 2500 lignes : sans limit = partiel ; 1-2000 + 2001-2500 = entier', () => {
    expect(lectureReferences(L([ligne('Read', { file_path: long })]), [long]).partielles).toEqual([long]);
    expect(lectureReferences(L([ligne('Read', { file_path: long }), ligne('Read', { file_path: long, offset: 2001, limit: 500 })]), [long]).partielles).toEqual([]);
  });
  it('un Read en erreur n\'ouvre pas la pièce', () => {
    const l = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Read', input: { file_path: long } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'trop gros' }] } })];
    expect(lectureReferences(l, [long])).toMatchObject({ ouvertes: [], manquantes: [long] });
  });
  it('PDF au nombre de pages inconnu : pages 1-3 contiguës comptent, signalées « pages inconnues »', () => {
    expect(lectureReferences(L([ligne('Read', { file_path: pdf, pages: '1-3' })]), [pdf])).toMatchObject({ partielles: [], pages_inconnues: [pdf] });
    expect(lectureReferences(L([ligne('Read', { file_path: pdf, pages: '2-3' })]), [pdf]).partielles).toEqual([pdf]);
  });
});
