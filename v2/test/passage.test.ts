import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { dossierTranscripts } from '../src/bench/fuites.js';
import { passageSequence } from '../src/sequence/passage.js';

const sh = (cwd: string, cmd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const GIT = 'git -c user.email=t@t -c user.name=t';
// « Suite du projet » : un script node qui écrit le JSON de vitest ; it('n') passe sauf si src/n.casse existe, it.skip est ignoré.
const SUITE = `const fs=require('fs'),p=require('path');const o=process.argv.find(x=>x.startsWith('--outputFile=')).slice(13);
const testResults=fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).map(f=>({name:p.resolve('tests',f),status:'passed',
assertionResults:[...fs.readFileSync(p.join('tests',f),'utf8').matchAll(/it(\\.skip)?\\('(\\w+)'\\)/g)].map(m=>({ancestorTitles:[],title:m[2],
status:m[1]?'skipped':fs.existsSync('src/'+m[2]+'.casse')?'failed':'passed'}))}));fs.writeFileSync(o,JSON.stringify({testResults}));`;

function racine() {
  const r = mkdtempSync(join(tmpdir(), 'seqpass-'));
  const src = join(r, 'projet'); mkdirSync(join(src, 'tests'), { recursive: true }); mkdirSync(join(src, 'src')); mkdirSync(join(src, 'docs'));
  writeFileSync(join(src, 'suite.cjs'), SUITE);
  writeFileSync(join(src, 'tests', 'a.test.js'), "it('x')\nit('y')\n"); writeFileSync(join(src, 'tests', 'b.test.js'), "it('z')\n");
  writeFileSync(join(src, 'docs', 'norme.md'), 'n'); writeFileSync(join(src, 'src', 'app.js'), '1');
  sh(src, `git init -q -b main && git add . && ${GIT} commit -qm base`);
  const d = join(r, 'sequences', 's1'), s = join(r, 'secrets', 'sequences', 's1');
  for (const k of [1, 2, 3]) { mkdirSync(join(d, 'etapes', String(k)), { recursive: true }); writeFileSync(join(d, 'etapes', String(k), 'demande.md'), `demande ${k}`); }
  mkdirSync(join(d, 'etapes', '1', 'pieces')); writeFileSync(join(d, 'etapes', '1', 'pieces', 'fig.png'), 'p');
  mkdirSync(s, { recursive: true }); for (const f of ['c1.ts', 'c2.ts', 'c3.ts', 'reg.ts']) writeFileSync(join(s, f), 'x');
  writeFileSync(join(d, 'sequence.yaml'), `projet: p\nsource: ${src}\nbase: main\ninstall: "true"\ntests: "true"
suite_projet: { vitest_json: "node suite.cjs --outputFile=<sortie>/r-<k>.json", build: "test ! -e src/build.casse" }
etapes:
  - { k: 1, lot: L1, demande: etapes/1/demande.md, pieces: [etapes/1/pieces/fig.png], references_depot: [docs/norme.md], taille: fonction }
  - { k: 2, lot: L2, demande: etapes/2/demande.md, taille: retouche }
  - { k: 3, lot: L3, demande: etapes/3/demande.md, taille: retouche }\n`);
  writeFileSync(join(s, 'sequence-secrets.yaml'), `caches:\n  1: { fichiers: [c1.ts], commande: v1 }\n  2: { fichiers: [c2.ts], commande: v2 }\n  3: { fichiers: [c3.ts], commande: v3 }
regression: { a_partir_de: 3, fichiers: [reg.ts], commande: vr }\n`);
  for (const b of ['A', 'C']) writeFileSync(join(r, `brief-${b}.md`), `BRAS-${b}\n{{DEMANDE}}\n{{CLONE}}`);
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${join(r, 'brief-A.md')}\nC:\n  modele: opus\n  brief: ${join(r, 'brief-C.md')}\n`);
  return { r, d };
}

const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
const outil = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

/** Faux claude. A : lit la pièce puis écrit ; échoue à l'étape 2 sans commit ; supprime b.test.js à l'étape 3.
 * C : écrit avant de lire la pièce et lit la demande 3 à l'étape 1 ; casse le test x à l'étape 2 ; passe y en .skip à l'étape 3. */
function faux(r: string, d: string) {
  const vu = { ordre: [] as string[], etapes: [] as string[], juges: [] as string[] }; let n = 0;
  const exec: Executeur = (args, o) => {
    const p = args[args.indexOf('-p') + 1];
    const j = /dans (\S+\.json)/.exec(p);
    if (j) {
      vu.juges.push(p);
      writeFileSync(j[1], JSON.stringify(j[1].endsWith('meca.json') ? { X: meca, Y: meca }
        : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
      return { stdout: JSON.stringify({ session_id: 'j', total_cost_usd: 0, modelUsage: {} }), code: 0 };
    }
    const b = /BRAS-(\w)/.exec(p)![1], k = Number(/demande (\d)/.exec(p)![1]), c = o.cwd, session = `s${++n}`;
    vu.ordre.push(`${b}${k}`); vu.etapes.push(JSON.parse(readFileSync(join(r, 'en-cours.json'), 'utf8')).etape);
    const piece = join(d, 'etapes', '1', 'pieces', 'fig.png'), ecrit = outil('Write', { file_path: join(c, 'src', 'app.js') });
    const lignes = b === 'A' ? [outil('Read', { file_path: piece }), outil('Read', { file_path: join(c, 'docs', 'norme.md') }), ecrit]
      : [ecrit, outil('Read', { file_path: piece }), outil('Bash', { command: `cat ${join(d, 'etapes', '3', 'demande.md')}` })];
    const t = dossierTranscripts(r, c); mkdirSync(t, { recursive: true }); writeFileSync(join(t, `${session}.jsonl`), k === 1 ? lignes.join('\n') : ecrit);
    if (b === 'A' && k === 2) return { stdout: JSON.stringify({ session_id: session, is_error: true, subtype: 'error_during_execution' }), code: 1 };
    if (b === 'C' && k === 2) writeFileSync(join(c, 'src', 'x.casse'), '');
    if (b === 'A' && k === 3) sh(c, 'git rm -q tests/b.test.js');
    if (b === 'C' && k === 3) writeFileSync(join(c, 'tests', 'a.test.js'), "it('x')\nit.skip('y')\n");
    writeFileSync(join(c, 'src', `${b}${k}.js`), 'v'); sh(c, `git add -A && ${GIT} commit -qm e${k}`);
    return { stdout: JSON.stringify({ session_id: session, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
  return { exec, vu };
}
const opts = (r: string, exec: Executeur) => ({ racine: r, id: 's1', ref: 'A', cand: 'C', juge: 'opus', exec, maintenant: new Date('2026-11-08T10:00:00Z'),
  empreinte: 'e1', home: r, out: () => {}, pret: () => null, jscpd: ['false'], tirage: () => 0 });

describe('passage d\'une séquence', () => {
  it('3 étapes × 2 bras : ordre alterné, régressions par bras, tests affaiblis, lecture, fuites, échec puis reprise, juges sur l\'état final', () => {
    const { r, d } = racine(); const { exec, vu } = faux(r, d);
    const res = passageSequence(opts(r, exec));
    expect(vu.ordre).toEqual(['A1', 'C1', 'C2', 'A2', 'A3', 'C3']);
    expect(vu.etapes).toEqual(['1/3', '1/3', '2/3', '2/3', '3/3', '3/3']);
    const A = res.etapes.A, C = res.etapes.C;
    expect(A.map((e) => e.k)).toEqual([1, 2, 3]);
    expect(A[1].mesure.echec).toMatch(/error_during_execution/); expect(A[2].mesure.echec).toBeNull(); // échec à l'étape 2, l'étape 3 est jouée
    expect(A.map((e) => e.regressions)).toEqual([[], [], ['tests/b.test.js > z']]);
    expect(C.map((e) => e.regressions)).toEqual([[], ['tests/a.test.js > x'], ['tests/a.test.js > y']]); // x rouge depuis l'étape 2 : compté une fois
    expect(A[2].tests_affaiblis).toEqual({ fichiers_supprimes: 1, tests_retires: 1, skip_only_ajoutes: 0 });
    expect(C[2].tests_affaiblis).toEqual({ fichiers_supprimes: 0, tests_retires: 0, skip_only_ajoutes: 1 });
    expect(A[0].suite).toEqual({ passes: 3, total: 3 }); expect(C[1].suite).toEqual({ passes: 2, total: 3 });
    const piece = join(d, 'etapes', '1', 'pieces', 'fig.png');
    expect(A[0].lecture).toMatchObject({ ouvertes: [piece, join(r, 'runs', res.run, 's1', 'c1', 'docs', 'norme.md')], apres_ecriture: [] });
    expect(C[0].lecture).toMatchObject({ ouvertes: [], apres_ecriture: [piece] });
    expect(A[0].fuites).toEqual([]); expect(C[0].fuites).toEqual([join(d, 'etapes', '3', 'demande.md')]);
    expect(A.every((e) => e.build_ok)).toBe(true);
    expect(res.clones).toEqual({ c1: 'A', c2: 'C' });
    expect(vu.juges).toHaveLength(2);
    for (const t of ['1. demande 1', '3. demande 3', 'c2.ts (v2)', 'reg.ts (vr)']) expect(vu.juges[0]).toContain(t);
    const dir = join(r, 'runs', res.run, 's1');
    expect(JSON.parse(readFileSync(join(dir, 'etape-2.c2.json'), 'utf8'))).toMatchObject({ k: 2, regressions: ['tests/a.test.js > x'], mesure: { bras: 'c2' } });
    expect(JSON.parse(readFileSync(join(dir, 'resultat.json'), 'utf8')).clones).toEqual({ c1: 'A', c2: 'C' });
    expect(existsSync(join(dir, 'c1'))).toBe(false); expect(readFileSync(join(dir, 'c1.patch'), 'utf8')).toContain('b.test.js');
    expect(existsSync(join(r, 'en-cours.json'))).toBe(false); expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });

  it('un clone sans commit est en échec (travail non livré), la suite continue', () => {
    const { r, d } = racine(); const { exec } = faux(r, d);
    const paresseux: Executeur = (args, o) => (/BRAS-C/.test(args[args.indexOf('-p') + 1])
      ? { stdout: JSON.stringify({ session_id: 'p', total_cost_usd: 0, modelUsage: {} }), code: 0 } : exec(args, o));
    const res = passageSequence(opts(r, paresseux));
    expect(res.etapes.C.map((e) => e.mesure.echec)).toEqual(['aucun commit', 'aucun commit', 'aucun commit']);
  });

  it('refusé quand le dépôt n\'est pas prêt, sans verrou laissé', () => {
    const { r, d } = racine(); const { exec } = faux(r, d);
    expect(() => passageSequence({ ...opts(r, exec), pret: () => 'v2/src sale' })).toThrow(/séquence refusée : v2\/src sale/);
    expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });
});
