import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preparer } from '../src/bench/preparer.js';
import { statut } from '../src/bench/verdict.js';
import type { Executeur } from '../src/bench/bras.js';
import { run } from '../src/cli.js';
import { sequence, type Dep } from '../src/sequence/cli.js';
import { ioTest } from './cli.test.js';

const sh = (cwd: string, cmd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const GIT = 'git -c user.email=t@t -c user.name=t';
const SUITE = `const fs=require('fs'),p=require('path');const o=process.argv.find(x=>x.startsWith('--outputFile=')).slice(13);
fs.writeFileSync(o,JSON.stringify({testResults:[{name:p.resolve('tests/a.test.js'),status:'passed',assertionResults:[{ancestorTitles:[],title:'x',status:'passed'}]}]}));`;
const JSCPD = `const a=process.argv,o=a[a.indexOf('--output')+1];require('fs').writeFileSync(o+'/jscpd-report.json',JSON.stringify({statistics:{total:{percentage:1}}}));`;
const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };

/** Séquence de 2 étapes, bras A et sequence-v2 ; `jscpd` est un faux jscpd. */
function racine() {
  const r = mkdtempSync(join(tmpdir(), 'seqcli-')), src = join(r, 'projet');
  mkdirSync(join(src, 'tests'), { recursive: true }); mkdirSync(join(src, 'src'));
  writeFileSync(join(src, 'suite.cjs'), SUITE); writeFileSync(join(src, 'tests', 'a.test.js'), "it('x')\n"); writeFileSync(join(src, 'src', 'app.js'), '1');
  sh(src, `git init -q -b main && git add . && ${GIT} commit -qm base`);
  const d = join(r, 'sequences', 's1'), s = join(r, 'secrets', 'sequences', 's1');
  for (const k of [1, 2]) { mkdirSync(join(d, 'etapes', String(k)), { recursive: true }); writeFileSync(join(d, 'etapes', String(k), 'demande.md'), `demande ${k}`); }
  mkdirSync(s, { recursive: true }); for (const f of ['c1.ts', 'c2.ts', 'reg.ts']) writeFileSync(join(s, f), 'x');
  writeFileSync(join(d, 'sequence.yaml'), `projet: p\nsource: ${src}\nbase: main\ninstall: "true"\ntests: "true"
suite_projet: { vitest_json: "node suite.cjs --outputFile=<sortie>/r-<k>.json", build: "true" }
etapes:\n  - { k: 1, lot: L1, demande: etapes/1/demande.md, taille: fonction }\n  - { k: 2, lot: L2, demande: etapes/2/demande.md, taille: retouche }\n`);
  writeFileSync(join(s, 'sequence-secrets.yaml'), `caches:\n  1: { fichiers: [c1.ts], commande: v1 }\n  2: { fichiers: [c2.ts], commande: v2 }\nregression: { a_partir_de: 2, fichiers: [reg.ts], commande: vr }\n`);
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${brief}\nsequence-v2:\n  modele: sonnet\n  brief: ${brief}\n`);
  writeFileSync(join(r, 'jscpd.cjs'), JSCPD);
  return r;
}
/** Faux claude : un bras commite ; `paresseux(appel)` : le candidat ne commite pas (échec « aucun commit »). Les juges rendent des verdicts égaux. */
function faux(r: string, paresseux: (appelCandidat: number) => boolean = () => false) {
  const vu = { etapes: [] as string[], reps: [] as number[] }; let cand = 0, n = 0;
  const exec: Executeur = (args, o) => {
    const p = args[args.indexOf('-p') + 1], j = /dans (\S+\.json)/.exec(p);
    if (j) {
      writeFileSync(j[1], JSON.stringify(j[1].endsWith('meca.json') ? { X: meca, Y: meca, remplaces: [] } : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
      return { stdout: JSON.stringify({ session_id: 'j', total_cost_usd: 0, modelUsage: {} }), code: 0 };
    }
    const en = JSON.parse(readFileSync(join(r, 'en-cours.json'), 'utf8')); vu.etapes.push(en.etape); vu.reps.push(en.repetition);
    const estCand = en.phase === 'bras sequence-v2';
    if (!(estCand && paresseux(++cand))) { writeFileSync(join(o.cwd, 'src', `f${++n}.js`), 'v'); sh(o.cwd, `git add -A && ${GIT} commit -qm e`); }
    return { stdout: JSON.stringify({ session_id: `s${n}`, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
  return { exec, vu };
}
const dep = (r: string, exec: Executeur): Dep => ({ exec, pret: () => null, jscpd: ['node', join(r, 'jscpd.cjs')], empreinte: 'e1' });
const histo = (r: string) => readFileSync(join(r, 'historique.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('cadence2 bench sequence : ligne de commande', () => {
  it('usage : sans id, option sans id, --repetitions invalide ou nul : code 2 et l\'usage', async () => {
    for (const a of [[], ['--candidat', 'x'], ['s1', '--repetitions', '0'], ['s1', '--repetitions', 'deux'], ['s1', '--repetitions', '-1']]) {
      const io = ioTest(); expect(await sequence(a, io), a.join(' ')).toBe(2);
      expect(io.erreurs[0]).toMatch(/^usage : cadence2 bench sequence <id> \[--candidat c\] \[--reference r\] \[--repetitions N\]/);
    }
  });
  it('refus (code 2, rien écrit) : même bras, bras absent, dépôt non prêt, séquence introuvable : message net', async () => {
    const r = racine(), { exec } = faux(r);
    const cas: [string[], Dep, RegExp][] = [
      [['s1', '--candidat', 'A'], dep(r, exec), /même bras/],
      [['s1', '--candidat', 'zzz'], dep(r, exec), /bras « zzz » absent/],
      [['s1'], { ...dep(r, exec), pret: () => 'v2/src sale' }, /séquence refusée : v2\/src sale/],
      [['s1'], { ...dep(r, exec), empreinte: 'inconnue' }, /empreinte inconnue/],
    ];
    for (const [a, d, re] of cas) { const io = ioTest({ BENCH_ROOT: r }); expect(await sequence(a, io, d), a.join(' ')).toBe(2); expect(io.erreurs.join('\n')).toMatch(re); }
    const io = ioTest({ BENCH_ROOT: r }); expect(await sequence(['nulle'], io, dep(r, exec))).toBe(1); expect(io.erreurs[0]).toMatch(/séquence nulle/);
    expect(existsSync(join(r, 'historique.jsonl')) || existsSync(join(r, 'passage.lock'))).toBe(false);
  });
  it('un verrou vivant refuse le passage (code 2)', async () => {
    const r = racine(), { exec } = faux(r); writeFileSync(join(r, 'passage.lock'), `${process.pid} 2026-11-08T00:00:00Z`);
    const io = ioTest({ BENCH_ROOT: r }); expect(await sequence(['s1'], io, dep(r, exec))).toBe(2); expect(io.erreurs[0]).toMatch(/déjà en cours/);
  });
  it('aide et aiguillage : « cadence2 » liste la commande, « bench sequence » sans id affiche son usage', async () => {
    const a = ioTest(); await run([], a); expect(a.sortie.join('\n')).toMatch(/cadence2 bench sequence <id> \[--candidat c\] \[--reference r\] \[--repetitions N\]/);
    const b = ioTest(); expect(await run(['bench', 'sequence'], b)).toBe(2); expect(b.erreurs[0]).toMatch(/^usage : cadence2 bench sequence/);
  });
});

describe('cadence2 bench sequence : passage', () => {
  it('défauts (candidat sequence-v2, référence A, 1 répétition) : vert = code 0, rapport md+json et une ligne d\'historique', async () => {
    const r = racine(), { exec, vu } = faux(r), io = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await sequence(['s1'], io, dep(r, exec))).toBe(0);
    expect(vu.etapes).toEqual(['1/2', '1/2', '2/2', '2/2']); expect(vu.reps).toEqual([1, 1, 1, 1]);
    expect(readdirSync(join(r, 'rapports')).sort()).toEqual(['2026-11-09-1100-e1-s1-r1.json', '2026-11-09-1100-e1-s1-r1.md']);
    expect(histo(r)).toMatchObject([{ type: 'sequence', candidat: 'sequence-v2', reference: 'A', modele_candidat: 'sonnet', sequence: 's1', run: '2026-11-09-1100-e1', repetition: 1, vert: true }]);
    expect(io.sortie.join('\n')).toMatch(/VERT — séquence s1, répétition 1\/1/);
    expect(existsSync(join(r, 'en-cours.json')) || existsSync(join(r, 'passage.lock'))).toBe(false);
  });
  it('--repetitions 2 : UN run id, répétitions 1 et 2 en historique et en rapports, dossiers r1 et r2, en-cours.json avec la répétition', async () => {
    const r = racine(), { exec, vu } = faux(r), io = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await sequence(['s1', '--repetitions', '2', '--garder-clones'], io, dep(r, exec))).toBe(0);
    const h = histo(r);
    expect(h.map((l) => [l.run, l.repetition, l.vert])).toEqual([['2026-11-09-1100-e1', 1, true], ['2026-11-09-1100-e1', 2, true]]);
    expect(vu.reps).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(readdirSync(join(r, 'rapports')).filter((f) => f.endsWith('.md')).sort()).toEqual(['2026-11-09-1100-e1-s1-r1.md', '2026-11-09-1100-e1-s1-r2.md']);
    expect(readdirSync(join(r, 'runs', '2026-11-09-1100-e1', 's1')).filter((f) => /^r\d$/.test(f)).sort()).toEqual(['r1', 'r2']);
  });
  it('règle du code de sortie : rouge à la répétition 2 seulement (ou 1 seulement) = 1 ; les deux sont écrites au même run', async () => {
    for (const [paresseux, attendu] of [[(c: number) => c > 2, [true, false]], [(c: number) => c <= 2, [false, true]]] as const) {
      const r = racine(), { exec } = faux(r, paresseux), io = ioTest({ BENCH_ROOT: r, HOME: r });
      expect(await sequence(['s1', '--repetitions', '2'], io, dep(r, exec))).toBe(1);
      const h = histo(r);
      expect(h.map((l) => l.vert)).toEqual(attendu); expect(new Set(h.map((l) => l.run)).size).toBe(1);
      expect(io.sortie.filter((l) => /^(VERT|ROUGE)/.test(l))).toHaveLength(2);
    }
  });
  it('une répétition qui lève : ligne rouge « répétition non terminée », les suivantes jouées, code 1, publication refusée', async () => {
    for (const lance of [2, 1]) {
      const r = racine(), { exec } = faux(r); let appels = 0;
      const prep: typeof preparer = (...a) => { if (++appels === (lance === 2 ? 3 : 1)) throw new Error('disque plein'); return preparer(...a); };
      const io = ioTest({ BENCH_ROOT: r, HOME: r });
      expect(await sequence(['s1', '--repetitions', '2'], io, { ...dep(r, exec), prep })).toBe(1);
      const h = histo(r);
      expect(h.map((l) => [l.repetition, l.repetitions, l.vert])).toEqual(lance === 2 ? [[1, 2, true], [2, 2, false]] : [[1, 2, false], [2, 2, true]]);
      expect(h.find((l) => !l.vert).rouges[0]).toMatch(/^répétition non terminée : .*disque plein/);
      expect(new Set(h.map((l) => l.run)).size).toBe(1);
      expect(io.erreurs.join('\n')).toMatch(/non terminée : .*disque plein/);
      expect(statut(readFileSync(join(r, 'historique.jsonl'), 'utf8').split('\n'), new Date('2026-11-09T12:00:00Z'), 'e1', { A: 'opus', 'sequence-v2': 'sonnet' }).publication_ok).toBe(false);
    }
  });
  it('le rapport dit sa répétition (« Répétition 2/2 »), un fichier par répétition', async () => {
    const r = racine(), { exec } = faux(r);
    await sequence(['s1', '--repetitions', '2'], ioTest({ BENCH_ROOT: r, HOME: r }), dep(r, exec));
    expect(readFileSync(join(r, 'rapports', '2026-11-09-1100-e1-s1-r2.md'), 'utf8')).toMatch(/^Répétition 2\/2$/m);
  });
});
