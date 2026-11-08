import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloneModifie, jouerTests, lectureReferences, maintenabilite, regressions } from '../src/sequence/mesures.js';

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

describe('regressions', () => {
  it('ne compte que passé avant puis rouge après (rouge déjà avant ignoré, nouveau test rouge ignoré)', () => {
    const avant = { a: true, b: false, c: true, d: true };
    const apres = { a: false, b: false, c: true, e: false, d: true };
    expect(regressions(avant, apres)).toEqual(['a']);
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

describe('maintenabilite', () => {
  it('compte les tailles et met null (jamais 0) si jscpd est absent', () => {
    const d = depot();
    writeFileSync(join(d, 'src', 'gros.ts'), 'x\n'.repeat(450));
    const m = maintenabilite(d, ['src'], ['/introuvable/jscpd']);
    expect(m.duplication_pct).toBeNull();
    expect(m.fichiers_400).toBe(1);
    expect(m.plus_gros[0]).toEqual({ fichier: 'src/gros.ts', lignes: 451 });
  });
});
