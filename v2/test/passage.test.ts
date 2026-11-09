import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cheminReglages, libererReglages, type Executeur } from '../src/bench/bras.js';
import { dossierTranscripts } from '../src/bench/fuites.js';
import { empreinteUtilisateur, passageSequence } from '../src/sequence/passage.js';
import { dossierTemp } from './temp.js';

const sh = (cwd: string, cmd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const GIT = 'git -c user.email=t@t -c user.name=t';
// « Suite du projet » : un script node qui écrit le JSON de vitest ; it('n') passe sauf si src/n.casse existe, it.skip est ignoré ; src/crash = aucun JSON.
const SUITE = `const fs=require('fs'),p=require('path');if(fs.existsSync('src/crash'))process.exit(3);const o=process.argv.find(x=>x.startsWith('--outputFile=')).slice(13);
const testResults=fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).map(f=>({name:p.resolve('tests',f),status:'passed',
assertionResults:[...fs.readFileSync(p.join('tests',f),'utf8').matchAll(/it(\\.skip)?\\('(\\w+)'\\)/g)].map(m=>({ancestorTitles:[],title:m[2],
status:m[1]?'skipped':fs.existsSync('src/'+m[2]+'.casse')?'failed':'passed'}))}));fs.writeFileSync(o,JSON.stringify({testResults}));`;

function racine() {
  const r = dossierTemp('seqpass-');
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
let horloge = 0;
/** Un appel d'outil et son résultat réussi (deux lignes, même horodatage) : seul un Read réussi compte (R31). */
const outil = (name: string, input: object) => { const timestamp = new Date(Date.UTC(2026, 10, 8) + ++horloge * 1000).toISOString(), id = `o${horloge}`;
  return `${JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } })}\n${JSON.stringify({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id }] } })}`; };
type Geste = (c: string, ecrire: (lignes: string[], sous?: string) => void) => void | 'plante' | 'erreur';

/** Faux claude. Par défaut, chaque bras écrit (Write) puis commite src/<bras><k>.js ; `gestes['A2']` ajoute un comportement à l'étape. */
function faux(r: string, d: string, gestes: Record<string, Geste>) {
  const vu = { ordre: [] as string[], etapes: [] as string[], juges: [] as string[] }; let n = 0;
  const exec: Executeur = (args, o) => {
    const p = args[args.indexOf('-p') + 1];
    const j = /dans (\S+\.json)/.exec(p);
    if (j) {
      vu.juges.push(p);
      writeFileSync(j[1], JSON.stringify(j[1].endsWith('meca.json') ? { X: meca, Y: meca, remplaces: [] }
        : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
      return { stdout: JSON.stringify({ session_id: 'j', total_cost_usd: 0, modelUsage: {} }), code: 0 };
    }
    const b = /BRAS-(\w)/.exec(p)![1], k = Number(/demande (\d)/.exec(p)![1]), c = o.cwd, session = `s${++n}`;
    vu.ordre.push(`${b}${k}`); vu.etapes.push(JSON.parse(readFileSync(join(r, 'en-cours.json'), 'utf8')).etape);
    const t = dossierTranscripts(r, c);
    const ecrire = (lignes: string[], sous = '') => { const f = join(t, session, sous); mkdirSync(sous ? dirname(f) : t, { recursive: true });
      writeFileSync(sous ? f : `${f}.jsonl`, lignes.join('\n')); };
    const g = gestes[`${b}${k}`]?.(c, ecrire);
    if (g === 'plante') throw new Error('plantage du bras');
    if (g === 'erreur') return { stdout: JSON.stringify({ session_id: session, is_error: true, subtype: 'error_during_execution' }), code: 1 };
    if (!existsSync(join(t, `${session}.jsonl`))) ecrire([outil('Write', { file_path: join(c, 'src', 'app.js') })]);
    writeFileSync(join(c, 'src', `${b}${k}.js`), 'v'); sh(c, `git add -A && ${GIT} commit -qm e${k}`);
    return { stdout: JSON.stringify({ session_id: session, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
  return { exec, vu };
}
const opts = (r: string, exec: Executeur) => ({ racine: r, id: 's1', ref: 'A', cand: 'C', juge: 'opus', exec, maintenant: new Date('2026-11-08T10:00:00Z'),
  empreinte: 'e1', home: r, out: () => {}, pret: () => null, jscpd: ['false'], tirage: () => 0 });
const lire = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('passage d\'une séquence', () => {
  it('3 étapes × 2 bras : ordre alterné, régressions par bras, tests affaiblis, lecture, fuites, échec puis reprise, juges sur l\'état final', () => {
    const { r, d } = racine();
    const piece = join(d, 'etapes', '1', 'pieces', 'fig.png'), dir = (x: string) => join(r, 'runs', '2026-11-08-1100-e1', 's1', x);
    const { exec, vu } = faux(r, d, {
      // I3 : fil principal [pièce t1, écriture t4], sous-agent [norme t2, écriture t3] : sans tri par horodatage, une lecture tombe après une écriture
      A1: (c, ecrire) => { const p1 = outil('Read', { file_path: piece }), n2 = outil('Read', { file_path: join(c, 'docs', 'norme.md') });
        const w3 = outil('Write', { file_path: join(c, 'src', 'b.js') }), w4 = outil('Write', { file_path: join(c, 'src', 'app.js') });
        ecrire([p1, w4]); ecrire([n2, w3], 'subagents/agent-1.jsonl'); },
      C1: (c, ecrire) => ecrire([outil('Write', { file_path: join(c, 'src', 'app.js') }), outil('Read', { file_path: piece }),
        outil('Bash', { command: `cat ${join(d, 'etapes', '3', 'demande.md')}` })]),
      A2: (_c, ecrire) => { ecrire([outil('Bash', { command: `cat ${join(d, 'etapes', '3', 'demande.md')}` })]); return 'plante'; },
      C2: (c) => writeFileSync(join(c, 'src', 'x.casse'), ''),
      A3: (c, ecrire) => { sh(c, 'git rm -q tests/b.test.js'); writeFileSync(join(c, 'tests', 'a.test.js'), "it('x')\nit('w')\n");
        ecrire([outil('Read', { file_path: `${c}.build-1.log` }), outil('Bash', { command: `cat ${dir('etape-1.c2.json')} ${dir('suite-0.c2.json')}` })]); },
      C3: (c) => { writeFileSync(join(c, 'tests', 'a.test.js'), "it('x')\nit.skip('y')\n"); symlinkSync('/nulle/part.ts', join(c, 'src', 'lien.ts')); },
    });
    const res = passageSequence(opts(r, exec));
    expect(vu.ordre).toEqual(['A1', 'C1', 'C2', 'A2', 'A3', 'C3']);
    expect(vu.etapes).toEqual(['1/3', '1/3', '2/3', '2/3', '3/3', '3/3']);
    const A = res.etapes.A, C = res.etapes.C;
    expect(res.base).toMatchObject({ A: { suite: { passes: 3, total: 3 }, build_ok: true }, C: { suite: { passes: 3, total: 3 }, build_ok: true } });
    expect(res.base.A.maintenabilite).toMatchObject({ duplication_pct: null, fichiers_400: 0 }); // étape 0 de la pente
    expect(A[1].mesure.echec).toMatch(/plantage du bras/); expect(A[2].mesure.echec).toBeNull(); // échec à l'étape 2, l'étape 3 est jouée
    expect(A[1].fuites).toEqual([join(d, 'etapes', '3', 'demande.md')]); // M4 : bras planté, transcripts lus quand même
    expect(A.map((e) => e.regressions)).toEqual([{ rouges: [], disparus: [] }, { rouges: [], disparus: [] },
      { rouges: [], disparus: ['tests/a.test.js > y', 'tests/b.test.js > z'] }]);
    expect(A[2].nouveaux).toEqual(['tests/a.test.js > w']);
    expect(A[2].tests_affaiblis).toEqual({ fichiers_supprimes: ['tests/b.test.js'], tests_retires: ['tests/a.test.js > y', 'tests/b.test.js > z'], skip_only: [] });
    expect(C.map((e) => e.regressions)).toEqual([{ rouges: [], disparus: [] }, { rouges: ['tests/a.test.js > x'], disparus: [] },
      { rouges: [], disparus: ['tests/a.test.js > y'] }]); // x rouge depuis l'étape 2 : compté une fois
    expect(C[2].tests_affaiblis).toEqual({ fichiers_supprimes: [], tests_retires: [], skip_only: ['tests/a.test.js > y'] });
    expect(C[2].mesure_en_erreur).toBeNull(); // lien cassé ignoré par la maintenabilité
    expect(A[0].suite).toEqual({ passes: 3, total: 3 }); expect(C[1].suite).toEqual({ passes: 2, total: 3 });
    expect(A[0].lecture).toMatchObject({ ouvertes: [piece, join(dir('c1'), 'docs', 'norme.md')], apres_ecriture: [] });
    expect(C[0].lecture).toMatchObject({ ouvertes: [], apres_ecriture: [piece] });
    expect(A[0].fuites).toEqual([]); expect(C[0].fuites).toEqual([join(d, 'etapes', '3', 'demande.md')]);
    expect(A[2].fuites).toEqual([dir('etape-1.c2.json'), dir('suite-0.c2.json')]); // M3 : son build-1.log est permis, les mesures de l'autre non
    expect(A.every((e) => e.build_ok && e.portee_suite === 'Suite mesurée : tout le dépôt')).toBe(true);
    expect(A.every((e) => typeof e.reponses === 'boolean')).toBe(true); // questions inutiles du verdict
    expect(res.clones).toEqual({ c1: 'A', c2: 'C' }); expect(res.reglages_utilisateur).toEqual([]); expect(res.sorties_attendues).toBe(0); expect(A.every((e) => e.reglages_utilisateur?.length === 0)).toBe(true);
    expect(vu.juges).toHaveLength(3); // mécanique, puis aveugle dans les deux ordres (R39)
    expect(vu.juges[2]).toContain(join('ordre-2', 'aveugle.json'));
    for (const t of ['1. demande 1', '3. demande 3', 'c2.ts (v2)', 'reg.ts (vr)', 'remplacé par l\'étape k']) expect(vu.juges[0]).toContain(t);
    expect(vu.juges[0]).not.toContain('adapte-les à l\'état final');
    expect(lire(dir('etape-2.c2.json'))).toMatchObject({ k: 2, regressions: { rouges: ['tests/a.test.js > x'] }, mesure: { bras: 'c2' } });
    expect(lire(dir('suite-2.c2.json')).testResults).toHaveLength(2); // JSON brut de la suite, dans le run
    expect(lire(dir('resultat.json')).clones).toEqual({ c1: 'A', c2: 'C' });
    expect(existsSync(dir('c1'))).toBe(false); expect(readFileSync(dir('c1.patch'), 'utf8')).toContain('b.test.js');
    expect(existsSync(join(r, 'en-cours.json'))).toBe(false); expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });

  it('bras avec réglages : pièces et références (résolues dans CE clone) par l\'environnement ; réglages touchés pendant l\'étape = contournement (R31)', () => {
    const { r, d } = racine();
    const settings = join(r, 'settings.json'); writeFileSync(settings, '{"hooks":{}}');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${join(r, 'brief-A.md')}\nC:\n  modele: opus\n  brief: ${join(r, 'brief-C.md')}\n  settings: ${settings}\n`);
    const vus: Record<string, unknown> = {};
    const env: Record<string, NodeJS.ProcessEnv> = {};
    const { exec: base } = faux(r, d, { C2: (c) => { libererReglages(c); chmodSync(cheminReglages(c), 0o600); writeFileSync(cheminReglages(c), '{}'); } });
    const exec: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) env[`${o.cwd.slice(-2)}-${Object.keys(env).length}`] = o.env; return base(args, o); };
    const res = passageSequence({ ...opts(r, exec), garderClones: true });
    const dir = (x: string) => join(r, 'runs', '2026-11-08-1100-e1', 's1', x), piece = join(d, 'etapes', '1', 'pieces', 'fig.png');
    for (const [k, e] of Object.entries(env)) vus[k] = e.CADENCE_PIECES === undefined ? null : JSON.parse(e.CADENCE_PIECES);
    expect(vus).toEqual({ 'c1-0': null, 'c2-1': [piece, join(dir('c2'), 'docs', 'norme.md')], 'c2-2': [], 'c1-3': null, 'c1-4': null, 'c2-5': [] });
    expect(env['c2-1']).toMatchObject({ CADENCE_CLONE: dir('c2'), CADENCE_BANC_RACINE: r });
    expect(res.etapes.C.map((e) => e.fuites.filter((f) => f.startsWith('contournement')).length)).toEqual([0, 1, 0]);
    expect(res.etapes.A.every((e) => e.fuites.length === 0)).toBe(true);
    expect(statSync(dir('c2.reglages')).mode & 0o777).toBe(0o700); // rendu effaçable en fin de séquence
  });

  it('suite en erreur à une étape : notée, et l\'étape suivante se compare à la dernière mesure réussie', () => {
    const { r, d } = racine();
    const { exec } = faux(r, d, { A1: (c) => writeFileSync(join(c, 'src', 'crash'), ''),
      A2: (c) => { rmSync(join(c, 'src', 'crash')); writeFileSync(join(c, 'src', 'x.casse'), ''); } });
    const A = passageSequence(opts(r, exec)).etapes.A;
    expect(A[0].suite_en_erreur).toMatch(/aucun JSON|Command failed/); expect(A[0].regressions).toBeUndefined();
    expect(A[1].suite_en_erreur).toBeNull(); expect(A[1].regressions).toEqual({ rouges: ['tests/a.test.js > x'], disparus: [] });
    expect(lire(join(r, 'runs', '2026-11-08-1100-e1', 's1', 'suite-1.c1.json')).erreur).toBeTruthy();
  });

  it('une mesure qui lève (etatGit sans .git) est notée, l\'autre bras et les étapes suivantes sont jouées', () => {
    const { r, d } = racine();
    const { exec, vu } = faux(r, d, { C2: (c) => { rmSync(join(c, '.git'), { recursive: true }); return 'erreur'; } });
    const res = passageSequence(opts(r, exec));
    const C = res.etapes.C;
    expect(C[1].mesure.echec).toBeTruthy(); expect(C[1].mesure_en_erreur).toMatch(/^tests affaiblis : /);
    expect(C[2].mesure_en_erreur).toMatch(/^état avant : /); expect(C[2].mesure.echec).toBe('non lancé');
    expect(vu.ordre).toEqual(['A1', 'C1', 'C2', 'A2', 'A3']);
    expect(res.etapes.A.map((e) => e.mesure_en_erreur)).toEqual([null, null, null]);
  });

  it('un clone sans commit est en échec (travail non livré), la suite continue', () => {
    const { r, d } = racine(); const { exec } = faux(r, d, {});
    const paresseux: Executeur = (args, o) => (/BRAS-C/.test(args[args.indexOf('-p') + 1])
      ? { stdout: JSON.stringify({ session_id: 'p', total_cost_usd: 0, modelUsage: {} }), code: 0 } : exec(args, o));
    const res = passageSequence(opts(r, paresseux));
    expect(res.etapes.C.map((e) => e.mesure.echec)).toEqual(['aucun commit', 'aucun commit', 'aucun commit']);
  });

  it('R36 : empreinte des réglages utilisateur — CLAUDE.md, ses @imports récursifs (relatifs au fichier qui importe), settings*.json s\'ils existent', () => {
    const h = dossierTemp('home-'), cl = join(h, '.claude');
    mkdirSync(join(cl, 'sous'), { recursive: true });
    writeFileSync(join(cl, 'CLAUDE.md'), 'intro\n@RTK.md\nmail noreply@x.com\n@sous/a.md\n'); writeFileSync(join(cl, 'RTK.md'), 'r');
    writeFileSync(join(cl, 'sous', 'a.md'), '@b.md'); writeFileSync(join(cl, 'sous', 'b.md'), '@../CLAUDE.md'); writeFileSync(join(cl, 'settings.json'), '{}');
    const e = empreinteUtilisateur(h);
    expect(Object.keys(e).sort()).toEqual(['CLAUDE.md', 'RTK.md', 'settings.json', 'settings.local.json', 'sous/a.md', 'sous/b.md'].map((f) => join(cl, f)));
    expect(e[join(cl, 'settings.local.json')]).toBe('-'); // absent : sa création sera vue
    expect(empreinteUtilisateur(h)).toEqual(e); // stable
    writeFileSync(join(cl, 'sous', 'b.md'), '@../CLAUDE.md\nchangé');
    expect(Object.keys(e).filter((f) => empreinteUtilisateur(h)[f] !== e[f])).toEqual([join(cl, 'sous', 'b.md')]);
  });

  it('R36 : un fichier importé par ~/.claude/CLAUDE.md modifié pendant une étape est nommé à cette étape, aux suivantes et avant les juges', () => {
    const { r, d } = racine(), cl = join(r, '.claude'); // home = r (opts)
    mkdirSync(cl); writeFileSync(join(cl, 'CLAUDE.md'), '@RTK.md'); writeFileSync(join(cl, 'RTK.md'), 'avant'); writeFileSync(join(cl, 'settings.json'), '{}');
    const { exec } = faux(r, d, { A2: () => writeFileSync(join(cl, 'RTK.md'), 'après') });
    const res = passageSequence(opts(r, exec));
    expect(res.etapes.C.map((e) => e.reglages_utilisateur)).toEqual([[], [], [join(cl, 'RTK.md')]]); // C2 joue avant A2
    expect(res.etapes.A.map((e) => e.reglages_utilisateur)).toEqual([[], [join(cl, 'RTK.md')], [join(cl, 'RTK.md')]]);
    expect(res.reglages_utilisateur).toEqual([join(cl, 'RTK.md')]);
  });

  it('R36, M3 : un réglage modifié PENDANT les juges est aussi nommé dans reglages_utilisateur', () => {
    const { r, d } = racine(), cl = join(r, '.claude');
    mkdirSync(cl); writeFileSync(join(cl, 'CLAUDE.md'), '@RTK.md'); writeFileSync(join(cl, 'RTK.md'), 'avant');
    const { exec } = faux(r, d, {});
    const juge: Executeur = (a, o) => { if (/meca\.json/.test(a[a.indexOf('-p') + 1])) writeFileSync(join(cl, 'RTK.md'), 'pendant le juge'); return exec(a, o); };
    const res = passageSequence(opts(r, juge));
    expect(res.etapes.A.every((e) => e.reglages_utilisateur?.length === 0)).toBe(true);
    expect(res.reglages_utilisateur).toEqual([join(cl, 'RTK.md')]);
  });

  it('m4 : @chemin suivi d\'une ponctuation (,;:.) retirée, extension .md gardée ; un import illisible = « illisible », sans exception', () => {
    const h = dossierTemp('home-'), cl = join(h, '.claude'); mkdirSync(cl, { recursive: true });
    writeFileSync(join(cl, 'CLAUDE.md'), 'voir @RTK.md, puis @a.md; (et @b.md) enfin @c.md.\n'); for (const f of ['RTK.md', 'a.md', 'b.md', 'c.md']) writeFileSync(join(cl, f), f);
    const e = empreinteUtilisateur(h);
    expect(Object.keys(e).sort()).toEqual(['CLAUDE.md', 'RTK.md', 'a.md', 'b.md', 'c.md', 'settings.json', 'settings.local.json'].map((f) => join(cl, f)));
    expect(Object.values(e).filter((x) => x === '-')).toHaveLength(2); // seuls les settings*.json absents
    chmodSync(join(cl, 'a.md'), 0o000);
    try {
      const apres = empreinteUtilisateur(h);
      expect(apres[join(cl, 'a.md')]).toBe('illisible');
      expect(Object.keys(e).filter((f) => apres[f] !== e[f])).toEqual([join(cl, 'a.md')]);
    } finally { chmodSync(join(cl, 'a.md'), 0o644); }
  });

  it('R35 : les sorties attendues des secrets vont au juge mécanique (toutes étapes, avec leur k) ; JSON sans elles = jugement refusé', () => {
    const { r, d } = racine(), sec = join(r, 'secrets', 'sequences', 's1', 'sequence-secrets.yaml');
    writeFileSync(sec, `${readFileSync(sec, 'utf8')}sorties:\n  3: [légende du globe en D/A quand D/A est choisi]\n  1: [cartouche à 3 h]\n`);
    writeFileSync(join(dirname(sec), 'mesure.md'), '## Écran\nnpm run start:local\n'); // B1
    const { exec, vu } = faux(r, d, {});
    const res = passageSequence(opts(r, exec));
    expect(res.sorties_attendues).toBe(2);
    expect(vu.juges[0]).toContain('S1 (i=1). étape 1 : cartouche à 3 h\nS2 (i=2). étape 3 : légende du globe en D/A quand D/A est choisi');
    expect(vu.juges[0]).toContain(join(dirname(sec), 'mesure.md')); // B1 : le juge lit le mesure.md des secrets de la séquence
    expect(vu.juges.some((p) => p.includes('sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [] (manquants : 1, 2)'))).toBe(true); // M2 : relance précise
    expect(res.jugement).toBeNull(); // le faux juge n'a pas rendu les sorties : échec fermé
  });

  it('refusé quand le dépôt n\'est pas prêt, sans verrou laissé', () => {
    const { r, d } = racine(); const { exec } = faux(r, d, {});
    expect(() => passageSequence({ ...opts(r, exec), pret: () => 'v2/src sale' })).toThrow(/séquence refusée : v2\/src sale/);
    expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });
});
