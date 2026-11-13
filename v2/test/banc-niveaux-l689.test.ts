import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { bench, commandeBanc, enParallele, passage } from '../src/bench/cli.js';
import { nomCache } from '../src/bench/sans-juge.js';
import { PUBLIE, statut, verdictSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L689 (D-3) : bancs en trois niveaux (micro et mécanique sans juge IA, complet avec juges avant une release), bancs d'un passage en parallèle,
// et garde de publication qui mesure cadence run contre A sur la version à publier.
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
const FOND = join(import.meta.dirname, 'fond');

/** Une racine de banc : un vrai dépôt source (pour `preparer`), des bancs qui le citent, deux bras. `tests` : la suite du projet. */
function racine(bancs: string[], tests = 'test ! -e rouge.txt'): string {
  const r = dossierTemp('banc-l689-'), src = join(r, 'source');
  mkdirSync(src); git(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'a.txt'), 'a'); git(src, 'add', '.'); git(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  for (const id of bancs) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), `projet: p\nsource: ${src}\nbase: ${git(src, 'rev-parse', 'HEAD')}\ninstall: "true"\ntests: ${JSON.stringify(tests)}\ntaille: fonction\n`);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
  }
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: opus\n  brief: ${BRIEF}\n`);
  return r;
}
const commit = (cwd: string, f = 'fait.txt') => { writeFileSync(join(cwd, f), 'x'); git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bras'); };
const sortie = JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} });
const base = { ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', maintenant: new Date('2026-11-13T15:00:00Z'), empreinte: 'e1', out: () => {} };
const prepReel = (await import('../src/bench/preparer.js')).preparer;

describe('nom d\'un test d\'origine posé à côté de ceux du bras', () => {
  it('garde le suffixe que le lanceur de tests reconnaît', () => {
    expect(nomCache('src/x.test.ts')).toBe('src/x.cache-banc.test.ts');
    expect(nomCache('a/b.spec.tsx')).toBe('a/b.cache-banc.spec.tsx');
    expect(nomCache('tests/test_x.py')).toBe('tests/test_x_cache_banc.py');
  });
});

describe('banc micro et mécanique : mesurés sans juge IA (L689)', () => {
  it('aucune session de juge ; suite et tests d\'origine joués dans le clone du bras ; rapport et historique disent le niveau', async () => {
    const r = racine(['1-a']); mkdirSync(join(r, 'secrets', '1-a', 'tests-origine', 't'), { recursive: true });
    writeFileSync(join(r, 'secrets', '1-a', 'tests-origine', 't', 'x.test.sh'), 'origine');
    const sessions: string[] = [];
    const exec: Executeur = (args, o) => { sessions.push(args[args.indexOf('-p') + 1]); commit(o.cwd, o.cwd.endsWith('c2') ? 'rouge.txt' : 'fait.txt'); return { stdout: sortie, code: 0 }; }; // c2 = cadence-run casse la suite
    const v = await passage({ ...base, racine: r, numeros: ['1'], niveau: 'micro', exec, prep: prepReel, home: r });
    expect(sessions).toHaveLength(2); // deux bras, aucun juge
    const res = JSON.parse(readFileSync(join(r, 'runs', '2026-11-13-1600-e1', '1-a', 'resultat.json'), 'utf8'));
    expect(res.jugement).toBeNull();
    expect(res.sans_juge).toEqual({ A: { suite_ok: true, caches_ok: true }, 'cadence-run': { suite_ok: false, caches_ok: false } }); // c1 = A, c2 = cadence-run
    expect(readFileSync(join(r, 'runs', '2026-11-13-1600-e1', '1-a', 'c1.tests-origine.log'), 'utf8')).toBe(''); // la suite a bien tourné avec le test posé
    expect(v.vert).toBe(false);
    expect(v.criteres.filter((c) => !c.ok).map((c) => c.nom)).toEqual(['suite du projet verte', 'tests d\'origine verts']);
    const rap = readFileSync(join(r, 'rapports', '2026-11-13-1600-e1.md'), 'utf8');
    expect(rap).toMatch(/Niveau : micro, sans juge IA \(n'autorise pas la publication\)/); expect(rap).toMatch(/\| sans juge \| ok · ROUGE \|/);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8'))).toMatchObject({ niveau: 'micro', candidat: 'cadence-run', reference: 'A' });
  });
  it('les tests d\'origine posés sont retirés du clone ; un banc sans tests d\'origine les compte « aucun »', async () => {
    const r = racine(['1-a']);
    const exec: Executeur = (_a, o) => { commit(o.cwd); return { stdout: sortie, code: 0 }; };
    const v = await passage({ ...base, racine: r, numeros: ['1'], niveau: 'mecanique', garderClones: true, exec, prep: prepReel, home: r });
    expect(v.vert).toBe(true);
    expect(v.criteres.find((c) => c.nom === 'tests d\'origine verts')?.valeur).toBe('aucun banc avec tests d\'origine');
    expect(git(join(r, 'runs', '2026-11-13-1600-e1', '1-a', 'c1'), 'status', '--porcelain')).toBe('');
  });
  it('verdict sans juge : un bras en échec ou un banc non mesuré est rouge', () => {
    const m = (echec: string | null) => ({ bras: 'x', banc: '1', debut: '', fin: '', duree_s: 10, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec });
    const r: ResultatBanc = { banc: '1', taille: 'fonction', visible: false, reponses: false, frais: false, mesures: { A: m(null), C: m('code 1') }, jugement: null, fuites: { A: [], C: [] } };
    expect(verdictSansJuge([r], 'A', 'C', { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 0, mutations: 0 } }).criteres.filter((c) => !c.ok).map((c) => c.nom))
      .toEqual(['aucun bras en échec', 'bancs mesurés sans juge']);
  });
});

describe('garde de publication : cadence run contre A, sur la version à publier (L689)', () => {
  const now = new Date('2026-11-13T15:00:00Z');
  const l = (o: Record<string, unknown> = {}) => JSON.stringify({ date: '2026-11-13T10:00:00Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus',
    bancs: ['1-a', '3-b', '6-c'], hebdo: false, frais: 0, vert: true, rouges: [], ...o });
  const seq = (o: Record<string, unknown> = {}) => l({ type: 'sequence', sequence: 's', run: 'r1', repetition: 1, repetitions: 1, bancs: ['s'], ...o });
  const ok = (h: string[]) => statut(h, now, 'e1', { 'cadence-run': 'opus', 'equipe-legere': 'opus', A: 'opus' }, PUBLIE).publication_ok;
  it('cadence-run contre A, court et séquence verts : permise', () => expect(ok([l(), seq()])).toBe(true));
  it('équipe légère contre A (le banc hebdo du 13-11) : refusée', () => expect(ok([l({ candidat: 'equipe-legere' }), seq({ candidat: 'equipe-legere' })])).toBe(false));
  it('un banc micro ou mécanique ne compte ni pour ni contre la publication', () => {
    expect(ok([l({ niveau: 'mecanique' }), seq()])).toBe(false);
    expect(ok([l(), l({ niveau: 'micro', bancs: ['1-a'], vert: false }), seq()])).toBe(true);
  });
  it('verifier-publication refusée donne la commande exacte du dépôt à publier, cadence-run contre A', async () => {
    const r = racine([]), sortie: string[] = [];
    const rc = await bench(['verifier-publication'], { cwd: r, env: { BENCH_ROOT: r, HOME: r }, now: () => now, out: (x) => sortie.push(x), err: (x) => sortie.push(x) }, '/depot/a-publier');
    expect(rc).toBe(1);
    expect(sortie.join('\n')).toContain(`« ${commandeBanc('/depot/a-publier', 'court')} »`);
    expect(commandeBanc('/depot/a-publier', 'court')).toBe('node /depot/a-publier/v2/bin/cadence2.js bench court');
    expect(sortie.join('\n')).toMatch(/cadence-run contre A/);
  });
  it('sans --candidat, le banc mesure cadence-run (refus net si bras.yaml ne le déclare pas)', async () => {
    const r = racine([]), err: string[] = []; writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\nequipe-legere:\n  modele: opus\n  brief: ${BRIEF}\n`);
    const rc = await bench(['micro'], { cwd: r, env: { BENCH_ROOT: r, HOME: r }, now: () => now, out: () => {}, err: (x) => err.push(x) });
    expect(rc).toBe(2); expect(err.join('\n')).toMatch(/bras absent/);
  });
});

describe('bancs d\'un passage en parallèle, un processus par banc (L689)', () => {
  it('enParallele : au plus n à la fois, résultats dans l\'ordre des tâches', async () => {
    let enCours = 0, max = 0;
    const res = await enParallele([30, 10, 20, 5], 2, async (ms) => { enCours++; max = Math.max(max, enCours); await new Promise((f) => setTimeout(f, ms)); enCours--; return ms; });
    expect(res).toEqual([30, 10, 20, 5]); expect(max).toBe(2);
  });
  it('trois bancs joués en même temps par de vrais processus cadence2 : ordre alterné gardé, en-cours.json des bancs en parallèle, durée ≈ un banc', async () => {
    const r = racine(['1-a', '3-b', '6-c']), bin = dossierTemp('banc-l689-bin-');
    // faux claude : une seconde par session, puis un commit dans le clone ; il note le début de chaque session
    writeFileSync(join(bin, 'claude'), `#!/bin/bash\ndate +%s%N >> "${r}/debuts"\nsleep 1\necho x > fait.txt; git add -A; git -c user.email=t@t -c user.name=t commit -qm bras\nprintf '${sortie}'\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const vus: string[] = [], sorties: string[] = [];
    const espion = setInterval(() => { try { vus.push(readFileSync(join(r, 'en-cours.json'), 'utf8')); } catch { /* pas encore */ } }, 50);
    const t0 = Date.now();
    const v = await passage({ ...base, racine: r, numeros: ['1', '3', '6'], niveau: 'mecanique', exec: () => { throw new Error('jamais en ligne'); }, prep: prepReel, home: r,
      out: (x) => sorties.push(x), depot: '/depot (branche main, 12345678)',
      enfants: { lanceur: [process.execPath, '--import', join(FOND, 'ts.mjs'), join(FOND, 'cadence.mjs')], paralleles: 3, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } } });
    clearInterval(espion);
    const duree = Date.now() - t0;
    expect(v.criteres.filter((c) => !c.ok)).toEqual([]);
    const rap = JSON.parse(readFileSync(join(r, 'rapports', '2026-11-13-1600-e1.json'), 'utf8'));
    expect(rap.resultats.map((x: { banc: string; clones: unknown }) => [x.banc, x.clones])).toEqual([
      ['1-a', { c1: 'A', c2: 'cadence-run' }], ['3-b', { c1: 'cadence-run', c2: 'A' }], ['6-c', { c1: 'A', c2: 'cadence-run' }]]);
    const debuts = readFileSync(join(r, 'debuts'), 'utf8').trim().split('\n').map((x) => Number(x) / 1e6).sort((a, b) => a - b);
    expect(debuts).toHaveLength(6);
    expect(debuts[2] - debuts[0]).toBeLessThan(900); // les premiers bras des trois bancs démarrent ensemble, pas l'un après l'autre (1 s chacun)
    expect(duree).toBeLessThan(6000 + 4000); // six sessions d'une seconde en série dépasseraient 6 s, plus le démarrage des processus
    expect(vus.some((x) => Object.keys(JSON.parse(x).en_parallele).length >= 2)).toBe(true);
    expect(existsSync(join(r, 'en-cours.json'))).toBe(false);
    expect(sorties[0]).toBe('banc mecanique : dépôt mesuré /depot (branche main, 12345678), empreinte e1, 3 banc(s) à la fois');
    expect(sorties.at(-1)).toMatch(/^VERT — \d+ s — rapport : /);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8'))).toMatchObject({ niveau: 'mecanique', bancs: ['1-a', '3-b', '6-c'] });
    expect(readdirSync(join(r, 'runs', '2026-11-13-1600-e1')).sort()).toEqual(['1-a', '3-b', '6-c', 'taches']);
  }, 60_000);
  it('un processus de banc mort sans résultat met ses deux bras en échec, les autres bancs vont au bout', async () => {
    const r = racine(['1-a']);
    const v = await passage({ ...base, racine: r, numeros: ['1'], exec: () => { throw new Error('jamais en ligne'); }, prep: prepReel, home: r,
      enfants: { lanceur: ['false'], paralleles: 2 } });
    expect(v.vert).toBe(false);
    expect(v.criteres.find((c) => c.nom === 'aucun bras en échec')?.valeur).toMatch(/processus du banc arrêté sans résultat \(code 1\)/);
  });
});
