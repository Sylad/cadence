// L756, revue (notes 1 et 2) : (1) le juge est le modèle PRINCIPAL de ses sessions (system/init, lu en stream-json comme pour les bras) ; un modèle
// auxiliaire facturé (Haiku) est nommé à part, jamais présenté comme une résolution de l'alias, et son apparition ne fait pas dire « juges changés » ;
// (2) une répétition de séquence interrompue écrit sa ligne d'historique avec modeles_exacts, « id non lu » quand aucune session n'a dit son modèle.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { ecartsEnvironnement, enteteEnvironnement, environnement, modelesExacts } from '../src/bench/environnement.js';
import { preparer } from '../src/bench/preparer.js';
import { juger } from '../src/bench/juges.js';
import { sequence } from '../src/sequence/cli.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

/** Flux stream-json d'une session : init (modèle principal), puis le result dont le modelUsage compte aussi les auxiliaires. */
const flux = (session: string, modele: string, autres: string[] = []) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: modele, claude_code_version: '2.1.325' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fini', session_id: session, total_cost_usd: 0,
    modelUsage: Object.fromEntries([modele, ...autres].map((m) => [m, { inputTokens: 1 }])) }),
].join('\n');

describe('juges : le modèle juge à part des modèles auxiliaires facturés', () => {
  it('juger() lit le modèle principal dans le system/init (stream-json) et range Haiku dans les auxiliaires', () => {
    const r = dossierTemp('juges-aux-l756-');
    const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'd');
    const secrets = join(r, 'secrets', '1-t'); mkdirSync(secrets, { recursive: true }); writeFileSync(join(secrets, 'mesure.md'), 'm');
    const A = join(r, 'runs', 'A'), cand = join(r, 'runs', 'cand'); mkdirSync(A, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: A });
    execFileSync('git', ['clone', '-q', A, cand]);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: A, encoding: 'utf8' }).trim();
    const b: Banc = { id: '1-t', dir, secrets, projet: 't', source: '/s', base, install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: false };
    const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
    const avis = { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: 'r' };
    const sorties = [{ X: meca, Y: meca, remplaces: [] }, avis, avis], formats: string[] = [];
    let i = 0;
    const exec: Executeur = (args) => {
      formats.push(`${args[args.indexOf('--output-format') + 1]}${args.includes('--verbose') ? ' --verbose' : ''}`);
      writeFileSync(/dans (\S+\.json)/.exec(args[args.indexOf('-p') + 1])![1], JSON.stringify(sorties[i++]));
      return { stdout: flux(`j${i}`, 'claude-opus-5-5', i === 2 ? ['claude-haiku-5-5'] : []), code: 0 };
    };
    const j = juger(b, { A, cand }, join(r, 'eval'), 'opus', exec, () => 0.2);
    expect(formats).toEqual(Array(3).fill('stream-json --verbose')); // le system/init n'est que dans le flux
    expect(j).toMatchObject({ modeles_juge: ['claude-opus-5-5'], autres_modeles_juge: ['claude-haiku-5-5'], prefere: 'egal' });
  });

  it('l\'en-tête nomme le juge puis les auxiliaires ; un auxiliaire qui apparaît ne fait pas dire « juges changés » ; l\'historique ne garde que le juge', () => {
    const avant = environnement('2.1.325', {}, [], { alias: 'opus', jugements: [{ modeles_juge: ['claude-opus-5-5'] }] });
    const apres = environnement('2.1.325', {}, [], { alias: 'opus', jugements: [{ modeles_juge: ['claude-opus-5-5'], autres_modeles_juge: ['claude-haiku-5-5'] }] });
    expect(enteteEnvironnement(apres, null)).toContain('Juges : alias opus → claude-opus-5-5 ; autres modèles facturés : claude-haiku-5-5');
    expect(ecartsEnvironnement(avant, apres)).toEqual([]);
    expect(modelesExacts(apres)).toEqual({ juges: ['claude-opus-5-5'] });
    const sansInit = environnement('2.1.325', {}, [], { alias: 'opus', jugements: [{ modeles_juge: [], autres_modeles_juge: ['claude-haiku-5-5'] }] });
    expect(enteteEnvironnement(sansInit, null)).toContain('Juges : alias opus → non lu (aucune session de juge n\'a rendu son system/init) ; autres modèles facturés : claude-haiku-5-5');
    expect(modelesExacts(sansInit)).toEqual({ juges: 'id non lu' });
  });
});

describe('séquence : une répétition interrompue écrit modeles_exacts', () => {
  const sh = (cwd: string, cmd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  const GIT = 'git -c user.email=t@t -c user.name=t';
  const SUITE = `const fs=require('fs'),p=require('path');const o=process.argv.find(x=>x.startsWith('--outputFile=')).slice(13);
fs.writeFileSync(o,JSON.stringify({testResults:[{name:p.resolve('tests/a.test.js'),status:'passed',assertionResults:[{ancestorTitles:[],title:'x',status:'passed'}]}]}));`;
  const JSCPD = `const a=process.argv,o=a[a.indexOf('--output')+1];require('fs').writeFileSync(o+'/jscpd-report.json',JSON.stringify({statistics:{total:{percentage:1}}}));`;
  function racine() {
    const r = dossierTemp('seq-echec-l756-'), src = join(r, 'projet');
    mkdirSync(join(src, 'tests'), { recursive: true }); mkdirSync(join(src, 'src'));
    writeFileSync(join(src, 'suite.cjs'), SUITE); writeFileSync(join(src, 'tests', 'a.test.js'), "it('x')\n"); writeFileSync(join(src, 'src', 'app.js'), '1');
    sh(src, `git init -q -b main && git add . && ${GIT} commit -qm base`);
    const d = join(r, 'sequences', 's1'), s = join(r, 'secrets', 'sequences', 's1');
    mkdirSync(join(d, 'etapes', '1'), { recursive: true }); writeFileSync(join(d, 'etapes', '1', 'demande.md'), 'demande 1');
    mkdirSync(s, { recursive: true }); writeFileSync(join(s, 'c1.ts'), 'x');
    writeFileSync(join(d, 'sequence.yaml'), `projet: p\nsource: ${src}\nbase: main\ninstall: "true"\ntests: "true"
suite_projet: { vitest_json: "node suite.cjs --outputFile=<sortie>/r-<k>.json", build: "true" }
etapes:\n  - { k: 1, lot: L1, demande: etapes/1/demande.md, taille: fonction }\n`);
    writeFileSync(join(s, 'reg.ts'), 'x');
    writeFileSync(join(s, 'sequence-secrets.yaml'), 'caches:\n  1: { fichiers: [c1.ts], commande: v1 }\nregression: { a_partir_de: 1, fichiers: [reg.ts], commande: vr }\n');
    const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${brief}\nsequence-v2:\n  modele: sonnet\n  brief: ${brief}\n`);
    writeFileSync(join(r, 'jscpd.cjs'), JSCPD);
    return r;
  }
  const ID: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' };
  /** Les bras commitent et disent leur modèle ; le juge tombe (exception) : la répétition est interrompue APRÈS les étapes jouées. */
  const exec: Executeur = (args, o) => {
    if (/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) throw new Error('juge tombé');
    writeFileSync(join(o.cwd, 'src', 'f.js'), 'v'); sh(o.cwd, `git add -A && ${GIT} commit -qm e`);
    return { stdout: flux('s', ID[args[args.indexOf('--model') + 1]]), code: 0 };
  };
  const lancer = async (r: string, prep?: typeof preparer) => {
    const io = ioTest({ BENCH_ROOT: r, HOME: r });
    const code = await sequence(['s1'], io, { exec, pret: () => null, jscpd: ['node', join(r, 'jscpd.cjs')], empreinte: 'e1', horloge: () => new Date('2026-11-09T10:00:00Z'), ...(prep && { prep }) });
    return { code, h: JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim()) };
  };

  it('interrompue après les étapes : la ligne rouge porte l\'id de chaque bras lu dans ses sessions', async () => {
    const { code, h } = await lancer(racine());
    expect(code).toBe(1);
    expect(h.rouges[0]).toMatch(/^répétition non terminée : .*juge tombé/);
    expect(h.modeles_exacts).toEqual({ A: ['claude-opus-5-5'], 'sequence-v2': ['claude-sonnet-5-5'] });
  });

  it('interrompue avant toute session : « id non lu » pour chaque bras, jamais l\'alias', async () => {
    const { h } = await lancer(racine(), () => { throw new Error('disque plein'); });
    expect(h.rouges[0]).toMatch(/disque plein/);
    expect(h.modeles_exacts).toEqual({ A: 'id non lu', 'sequence-v2': 'id non lu' });
  });
});
