import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { controlesEclair, empreinte, passage, pretAPasser } from '../src/bench/cli.js';
import { statut } from '../src/bench/verdict.js';
import { run } from '../src/cli.js';
import { creerExecuteur } from '../src/bench/bras.js';

const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
function racine(): string {
  const r = mkdtempSync(join(tmpdir(), 'bench-'));
  for (const id of ['1-a', '2-b']) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd'); writeFileSync(join(r, 'secrets', id, 'mesure.md'), 'm');
  }
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${brief}\nC:\n  modele: opus\n  brief: ${brief}\n`);
  return r;
}
const commit = (cwd: string) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'bras'], { cwd });
/** Faux claude : un bras commite tout de suite ; un juge écrit un JSON valide dans le fichier demandé. */
const exec: Executeur = (args, o) => {
  const p = args[args.indexOf('-p') + 1];
  const m = /dans (\S+\.json)/.exec(p);
  if (!m && existsSync(join(o.cwd, '.git'))) commit(o.cwd);
  if (m) writeFileSync(m[1], JSON.stringify(m[1].endsWith('meca.json') ? { X: meca, Y: meca }
    : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
  return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
};
const prep = (_b: unknown, cible: string) => {
  mkdirSync(cible, { recursive: true });
  execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
  return { testsBase: 0 };
};

describe('passage du banc', () => {
  it('joue les bras un banc après l\'autre, ordre alterné, et écrit rapport et historique', () => {
    const r = racine(); const ordre: string[] = [];
    const exec2: Executeur = (args, o) => { if (!args.includes('--resume') && !/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) ordre.push(o.cwd.split('/').slice(-2).join('/')); return exec(args, o); };
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.vert).toBe(true);
    expect(ordre).toEqual(['1-a/c1', '1-a/c2', '2-b/c1', '2-b/c2']);
    const map = (id: string) => JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', id, 'resultat.json'), 'utf8')).clones;
    expect(map('1-a')).toEqual({ c1: 'A', c2: 'C' });
    expect(map('2-b')).toEqual({ c1: 'C', c2: 'A' });
    expect(JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', '1-a', 'resultat.json'), 'utf8')).suite_base).toEqual({ A: 0, C: 0 });
    const rap = JSON.parse(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.json'), 'utf8'));
    expect(rap.resultats.map((x: { clones: unknown }) => x.clones)).toEqual([{ c1: 'A', c2: 'C' }, { c1: 'C', c2: 'A' }]);
    expect(readdirSync(join(r, 'rapports')).sort()).toEqual(['2026-11-08-1100-e1.json', '2026-11-08-1100-e1.md']);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim())).toMatchObject({ empreinte: 'e1', vert: true, hebdo: false });
  });

  it('R11 : un bras en échec saute les juges du banc, verdict rouge', () => {
    const r = racine(); let juges = 0;
    const exec2: Executeur = (args, o) => {
      const p = args[args.indexOf('-p') + 1];
      if (/dans \S+\.json/.test(p)) { juges++; return exec(args, o); }
      if (o.cwd.endsWith('1-a/c1')) return { stdout: JSON.stringify({ session_id: 's', is_error: true, modelUsage: {} }), code: 0 };
      return exec(args, o);
    };
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(juges).toBe(0);
    expect(v.vert).toBe(false);
  });

  it('R12 : une préparation qui échoue n\'arrête pas les autres bancs', () => {
    const r = racine(); const cwds: string[] = [];
    const prep2 = (b: { id: string }, cible: string) => { if (b.id === '1-a') throw new Error('futur visible'); return prep(b, cible); };
    const exec2: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) cwds.push(o.cwd); return exec(args, o); };
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep2 as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(cwds.length).toBe(2);
    expect(cwds.every((c) => c.includes('2-b'))).toBe(true);
    expect(v.vert).toBe(false);
    const res = JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', '1-a', 'resultat.json'), 'utf8'));
    expect(res.mesures.A.echec).toContain('préparation : futur visible');
  });

  const lancer = (r: string) => passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never,
    maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
  it('verrou : pid vivant refuse, pid mort est repris, libéré après', () => {
    const r = racine();
    writeFileSync(join(r, 'passage.lock'), `${process.pid} x`);
    expect(() => lancer(r)).toThrow(/déjà en cours/);
    writeFileSync(join(r, 'passage.lock'), '999999 x');
    expect(lancer(r).vert).toBe(true);
    expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });
  it('verrou : même pid mais autre démarrage de la machine = périmé, repris', () => {
    const r = racine();
    writeFileSync(join(r, 'passage.lock'), `${process.pid} x boot-d-un-autre-demarrage`);
    expect(lancer(r).vert).toBe(true);
    expect(existsSync(join(r, 'passage.lock'))).toBe(false);
  });
  it('en-cours.json : présent pendant un bras (banc, phase), absent après, même après une levée', () => {
    const r = racine(); const vus: Record<string, unknown>[] = [];
    const espion: Executeur = (a, o) => { const f = join(r, 'en-cours.json'); if (existsSync(f)) vus.push(JSON.parse(readFileSync(f, 'utf8'))); return exec(a, o); };
    passage({ racine: r, numeros: ['1', '2'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: espion, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(vus[0]).toMatchObject({ run: '2026-11-08-1100-e1', candidat: 'C', reference: 'A', bancs_total: 2, banc: '1-a', repetition: 1, phase: 'bras A', termines: 0 });
    expect(vus.some((v) => v.banc === '2-b' && v.termines === 1)).toBe(true);
    expect(existsSync(join(r, 'en-cours.json'))).toBe(false);
    const r2 = racine(); writeFileSync(join(r2, 'bras.yaml'), 'A:\n  modele: opus\n  brief: /nulle/part\n');
    expect(() => passage({ racine: r2, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never, maintenant: new Date(), empreinte: 'e1', home: r2, out: () => {} })).toThrow();
    expect(existsSync(join(r2, 'en-cours.json'))).toBe(false);
  });
  it('phase : un bras qui lève est étiqueté « bras X »', () => {
    const r = racine();
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: () => { throw new Error('boum'); }, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.vert).toBe(false);
    const res = JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', '1-a', 'resultat.json'), 'utf8'));
    expect(res.mesures.A.echec).toBe('bras A : boum');
  });
});

describe('pretAPasser et empreinte', () => {
  function depot(): { repo: string; brief: string } {
    const repo = mkdtempSync(join(tmpdir(), 'depot-'));
    mkdirSync(join(repo, 'v2', 'src'), { recursive: true }); mkdirSync(join(repo, 'v2', 'briefs')); mkdirSync(join(repo, 'v2', 'dist'));
    writeFileSync(join(repo, 'v2', 'src', 'a.ts'), 'x'); writeFileSync(join(repo, 'v2', 'briefs', 'b.md'), 'b'); writeFileSync(join(repo, 'v2', 'dist', 'cli.js'), 'j');
    execFileSync('bash', ['-c', 'git init -q -b main && git add v2/src v2/briefs && git -c user.email=t@t -c user.name=t commit -q -m i'], { cwd: repo });
    const t = new Date(Date.now() + 5000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), t, t);
    return { repo, brief: join(repo, 'v2', 'briefs', 'b.md') };
  }
  it('prêt quand propre, construit et briefs dans le dépôt', () => {
    const { repo, brief } = depot();
    expect(pretAPasser(repo, { A: { nom: 'A', modele: 'm', brief } })).toBeNull();
  });
  it('refuse : changement non commité, dist périmé, brief hors dépôt', () => {
    const { repo, brief } = depot(); const d = { A: { nom: 'A', modele: 'm', brief } };
    writeFileSync(join(repo, 'v2', 'src', 'a.ts'), 'y');
    expect(pretAPasser(repo, d)).toMatch(/non commités/);
    execFileSync('git', ['checkout', 'v2/src/a.ts'], { cwd: repo });
    const vieux = new Date(Date.now() - 100000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), vieux, vieux);
    expect(pretAPasser(repo, d)).toMatch(/npm run build/);
    const t = new Date(Date.now() + 5000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), t, t);
    expect(pretAPasser(repo, { A: { nom: 'A', modele: 'm', brief: '/ailleurs/b.md' } })).toMatch(/hors de/);
  });
  it('brief relatif résolu depuis la racine du banc', () => {
    const { repo } = depot();
    expect(pretAPasser(repo, { A: { nom: 'A', modele: 'm', brief: 'v2/briefs/b.md' } }, repo)).toBeNull();
    expect(pretAPasser(repo, { A: { nom: 'A', modele: 'm', brief: 'v2/briefs/b.md' } }, '/ailleurs')).toMatch(/hors de/);
  });
  it('empreinte inconnue sans dépôt git', () => {
    expect(empreinte(mkdtempSync(join(tmpdir(), 'nogit-')))).toBe('inconnue');
  });
});

describe('executeur en groupe de processus', () => {
  it('tue les processus laissés en arrière-plan par la commande', () => {
    const d = mkdtempSync(join(tmpdir(), 'ex-')); const cmd = join(d, 'faux.sh');
    const marque = `300.${process.pid}`;
    writeFileSync(cmd, `#!/bin/bash\nsleep ${marque} &\necho '{"ok":1}'\n`, { mode: 0o755 });
    const r = creerExecuteur(cmd)([], { cwd: d, env: process.env });
    expect(r.stdout).toContain('ok'); expect(r.code).toBe(0);
    expect(spawnSync('pgrep', ['-f', `sleep ${marque.replace('.', '[.]')}`]).status).toBe(1);
  });
  it('au délai dépassé, le groupe entier est tué (le bras ne continue pas)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ex-')); const cmd = join(d, 'long.sh');
    writeFileSync(cmd, '#!/bin/bash\nsleep 20.456\n', { mode: 0o755 });
    creerExecuteur(cmd, 2000)([], { cwd: d, env: process.env });
    const fin = Date.now() + 3000;
    while (spawnSync('pgrep', ['-f', 'sleep 20[.]456']).status === 0 && Date.now() < fin) spawnSync('sleep', ['0.2']);
    expect(spawnSync('pgrep', ['-f', 'sleep 20[.]456']).status).toBe(1);
  });
});

describe('banc éclair', () => {
  const mes = (bras: string, duree_s: number, questions = 0) => ({ bras, banc: '1-a', debut: '', fin: '', duree_s, tokens: 0, cout_usd: 0, questions, questions_texte: [], sessions: [], echec: null });
  const res = (a: number, c: number, q = 0) => [{ banc: '1-a', taille: 'retouche', visible: false, reponses: false, frais: false, mesures: { A: mes('A', a), C: mes('C', c, q) }, jugement: null, fuites: {} }] as never;

  it('contrôles : temps ≤ 1,2 × A et aucune question, affichés avec les chiffres', () => {
    expect(controlesEclair(res(100, 120), 'A', 'C')).toEqual({ ok: true, lignes: ['temps candidat ≤ 1,2 × A : ok (120 s contre 100 s)', 'questions du candidat : 0 / 0 ok'] });
    const lent = controlesEclair(res(100, 121), 'A', 'C');
    expect(lent.ok).toBe(false); expect(lent.lignes[0]).toBe('temps candidat ≤ 1,2 × A : ROUGE (121 s contre 100 s)');
    const bavard = controlesEclair(res(100, 90, 2), 'A', 'C');
    expect(bavard.ok).toBe(false); expect(bavard.lignes[1]).toBe('questions du candidat : 0 / 2 ROUGE');
  });

  it('ROUGE avec la cause : bras en échec, mesure absente, aucun banc', () => {
    const base = res(100, 0)[0] as { mesures: Record<string, unknown> };
    const echec = [{ ...base, mesures: { A: mes('A', 100), C: { ...mes('C', 0), echec: 'bras C : boum' } } }] as never;
    const e = controlesEclair(echec, 'A', 'C');
    expect(e.ok).toBe(false); expect(e.lignes).toHaveLength(2);
    for (const l of e.lignes) expect(l).toMatch(/ROUGE \(bras en échec : C, bras C : boum\)/);
    const absente = controlesEclair([{ ...base, mesures: { A: mes('A', 100) } }] as never, 'A', 'C');
    expect(absente.ok).toBe(false); for (const l of absente.lignes) expect(l).toMatch(/ROUGE \(mesure absente : bras C, banc 1-a\)/);
    const rien = controlesEclair([], 'A', 'C');
    expect(rien.ok).toBe(false); for (const l of rien.lignes) expect(l).toMatch(/ROUGE \(aucun banc joué\)/);
  });

  it('un seul banc joué, hebdo: false, contrôles imprimés avant le verdict, dans le rapport et l\'historique', () => {
    const r = racine(); const sortie: string[] = []; const cwds = new Set<string>();
    const exec2: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) cwds.add(o.cwd.split('/').slice(-2)[0]); return exec(args, o); };
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: (l) => sortie.push(l), eclair: true });
    expect(v).toMatchObject({ vert: true, eclair_ok: true });
    expect([...cwds]).toEqual(['1-a']);
    const h = JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim());
    expect(h).toMatchObject({ bancs: ['1-a'], hebdo: false, eclair_ok: true });
    const i = sortie.findIndex((l) => l.startsWith('temps candidat'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sortie[i + 1]).toMatch(/^questions du candidat/);
    expect(sortie.findIndex((l) => l.startsWith('VERT'))).toBeGreaterThan(i + 1);
    expect(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.md'), 'utf8')).toContain('## Contrôles éclair');
  });
  it('contrôles éclair rouges : eclair_ok false dans l\'historique, ROUGE au rapport', () => {
    const r = racine();
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', prep: prep as never, eclair: true,
      exec: (args, o) => (o.cwd.endsWith('c2') ? { stdout: JSON.stringify({ session_id: 's', modelUsage: {} }), code: 0 } : exec(args, o)),
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.eclair_ok).toBe(false);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim()).eclair_ok).toBe(false);
    expect(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.md'), 'utf8')).toMatch(/## Contrôles éclair\n\n- temps candidat .* ROUGE/);
  });
  it('sans éclair : pas de eclair_ok dans l\'historique', () => {
    const r = racine();
    passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never, maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim())).not.toHaveProperty('eclair_ok');
  });
  it('le passage est nommé à l\'heure de Paris (M-5)', () => {
    const r = racine();
    passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never, maintenant: new Date('2026-11-07T23:30:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(readdirSync(join(r, 'runs'))).toEqual(['2026-11-08-0030-e1']);
    expect(readFileSync(join(r, 'rapports', '2026-11-08-0030-e1.md'), 'utf8')).toMatch(/^# Banc 2026-11-08 /);
  });

  it('une ligne éclair verte n\'autorise pas la publication', () => {
    const ligne = JSON.stringify({ date: '2026-11-08T10:00:00.000Z', empreinte: 'e1', candidat: 'C', bancs: ['1-a'], hebdo: false, frais: 0, vert: true, rouges: [] });
    expect(statut([ligne], new Date('2026-11-09T10:00:00Z'), 'e1').publication_ok).toBe(false);
  });

  it('la sous-commande est dans l\'aide', async () => {
    const sortie: string[] = [];
    await run(['--help'], { cwd: '/', env: {}, now: () => new Date(), out: (l) => sortie.push(l), err: () => {} });
    expect(sortie.join('\n')).toMatch(/bench court\|hebdo\|eclair\|/);
  });
});

describe('répétitions (R18)', () => {
  const base = { ref: 'A', cand: 'C', hebdo: false, juge: 'opus', prep: prep as never, maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1' };
  it('N = 2 : quatre bras par banc, ordre alterné par banc et par répétition, clones r1/r2, ids #k', () => {
    const r = racine(); const ordre: string[] = [];
    const exec2: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) ordre.push(o.cwd.split('/').slice(-3).join('/')); return exec(args, o); };
    passage({ ...base, racine: r, repetitions: 2, exec: exec2, home: r, out: () => {} });
    expect(ordre).toEqual(['1-a/r1/c1', '1-a/r1/c2', '1-a/r2/c1', '1-a/r2/c2', '2-b/r1/c1', '2-b/r1/c2', '2-b/r2/c1', '2-b/r2/c2']);
    const run = join(r, 'runs', '2026-11-08-1100-e1');
    const map = (id: string, k: number) => JSON.parse(readFileSync(join(run, id, `r${k}`, 'resultat.json'), 'utf8')).clones;
    expect(map('1-a', 1)).toEqual({ c1: 'A', c2: 'C' }); expect(map('1-a', 2)).toEqual({ c1: 'C', c2: 'A' });
    expect(map('2-b', 1)).toEqual({ c1: 'C', c2: 'A' }); expect(map('2-b', 2)).toEqual({ c1: 'A', c2: 'C' });
    expect(existsSync(join(r, 'eval', '2026-11-08-1100-e1', '2-b', 'r2'))).toBe(true);
    const rap = JSON.parse(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.json'), 'utf8'));
    expect(rap.resultats.map((x: { banc: string }) => x.banc)).toEqual(['1-a#1', '1-a#2', '2-b#1', '2-b#2']);
    expect(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.md'), 'utf8')).toContain('Répétitions : 2');
  });
  it('eclair avec N = 2 : deux répétitions du banc 1, contrôles sur la somme', () => {
    const r = racine(); const sortie: string[] = [];
    const v = passage({ ...base, racine: r, numeros: ['1'], repetitions: 2, exec, home: r, out: (l) => sortie.push(l),
      eclair: true });
    expect(v.vert).toBe(true);
    expect(sortie.some((l) => l.startsWith('temps candidat'))).toBe(true);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim()).bancs).toEqual(['1-a#1', '1-a#2']);
  });
  it('N = 1 : ids et dossiers inchangés', () => {
    const r = racine();
    passage({ ...base, racine: r, numeros: ['1'], exec, home: r, out: () => {} });
    expect(existsSync(join(r, 'runs', '2026-11-08-1100-e1', '1-a', 'c1.patch'))).toBe(true);
  });
  it('--repetitions 0, -1, 1.5, abc : usage et code 2, pour court, hebdo, lancer et eclair', async () => {
    for (const sous of ['court', 'hebdo', 'eclair', 'lancer']) for (const v of ['0', '-1', '1.5', 'abc']) {
      const err: string[] = [];
      const rc = await run(['bench', sous, '--bancs', '1', '--repetitions', v], { cwd: '/', env: { BENCH_ROOT: racine() }, now: () => new Date(), out: () => {}, err: (l) => err.push(l) });
      expect(rc).toBe(2); expect(err.join('\n')).toMatch(/--repetitions/);
    }
  });
  it('Mesure.banc porte #k (normal et erreur) ; frais compte les bancs de base', () => {
    const r = racine(); writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\nfrais: true\n');
    passage({ ...base, racine: r, numeros: ['1'], repetitions: 2, exec, home: r, out: () => {} });
    const rap = JSON.parse(readFileSync(join(r, 'rapports', '2026-11-08-1100-e1.json'), 'utf8'));
    expect(rap.resultats.map((x: { mesures: Record<string, { banc: string }> }) => x.mesures.A.banc)).toEqual(['1-a#1', '1-a#2']);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim()).frais).toBe(1);
    const r2 = racine();
    passage({ ...base, racine: r2, numeros: ['1'], repetitions: 2, exec: () => { throw new Error('boum'); }, home: r2, out: () => {} });
    const rap2 = JSON.parse(readFileSync(join(r2, 'rapports', '2026-11-08-1100-e1.json'), 'utf8'));
    expect(rap2.resultats.map((x: { mesures: Record<string, { banc: string }> }) => x.mesures.A.banc)).toEqual(['1-a#1', '1-a#2']);
  });
});

describe('garde de publication (C-1, I-7)', () => {
  it('l\'historique porte la référence et le modèle du candidat lu dans bras.yaml', () => {
    const r = racine(); writeFileSync(join(r, 'bras.yaml'), readFileSync(join(r, 'bras.yaml'), 'utf8').replace(/C:\n  modele: opus/, 'C:\n  modele: fable'));
    passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim())).toMatchObject({ candidat: 'C', reference: 'A', modele_candidat: 'fable' });
  });
  it('--candidat égal à --reference : refusé, code 2', async () => {
    const err: string[] = [];
    const rc = await run(['bench', 'court', '--candidat', 'A', '--reference', 'A'], { cwd: '/', env: { BENCH_ROOT: racine() }, now: () => new Date(), out: () => {}, err: (l) => err.push(l) });
    expect(rc).toBe(2); expect(err.join('\n')).toMatch(/même bras/);
  });
});

describe('travail du bras (I-2)', () => {
  /** Banc 1-a : c1 = A (commite), c2 = C (fait `bras`). */
  const jouer = (bras: (cwd: string) => void, prep2 = prep) => {
    const r = racine(); let juges = 0;
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', prep: prep2 as never, garderClones: true,
      exec: (args, o) => { if (/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) juges++; else if (o.cwd.endsWith('c2')) { bras(o.cwd); return { stdout: JSON.stringify({ session_id: 's', modelUsage: {} }), code: 0 }; } return exec(args, o); },
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    return { v, juges, C: JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', '1-a', 'resultat.json'), 'utf8')).mesures.C };
  };
  it('aucun commit : échec « aucun commit », juges sautés, rouge', () => {
    const { v, juges, C } = jouer(() => {});
    expect(C.echec).toBe('aucun commit'); expect(juges).toBe(0); expect(v.vert).toBe(false);
  });
  it('travail laissé hors commit (même après un commit) : échec « travail non commité »', () => {
    expect(jouer((c) => { commit(c); writeFileSync(join(c, 'oubli.ts'), 'x'); }).C.echec).toBe('travail non commité');
    expect(jouer((c) => writeFileSync(join(c, 'oubli.ts'), 'x')).C.echec).toBe('travail non commité');
  });
  it('un fichier non suivi laissé par l\'install avant le bras ne compte pas ; un commit propre passe', () => {
    const prepSale = (b: unknown, cible: string) => { const x = prep(b, cible); writeFileSync(join(cible, 'artefact-install'), 'x'); return x; };
    expect(jouer(commit, prepSale).C.echec).toBeNull();
  });
});

describe('nettoyage des clones (I-3)', () => {
  const jouer = (garderClones?: boolean) => {
    const r = racine();
    const exec2: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) { mkdirSync(`${o.cwd}.captures`, { recursive: true }); writeFileSync(`${o.cwd}.captures/a.png`, 'p'); } return exec(args, o); };
    passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never, garderClones,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    return join(r, 'runs', '2026-11-08-1100-e1', '1-a');
  };
  it('après resultat.json : patch et commits gardés à côté, clone effacé, captures gardées', () => {
    const d = jouer();
    for (const c of ['c1', 'c2']) {
      expect(existsSync(join(d, c)), `${c} reste`).toBe(false);
      expect(existsSync(join(d, `${c}.patch`))).toBe(true);
      expect(readFileSync(join(d, `${c}.commits.txt`), 'utf8')).toMatch(/bras/);
      expect(existsSync(join(d, `${c}.captures`, 'a.png'))).toBe(true);
    }
    expect(existsSync(join(d, 'resultat.json'))).toBe(true);
  });
  it('--garder-clones : les clones restent', () => {
    const d = jouer(true);
    expect(existsSync(join(d, 'c1', '.git'))).toBe(true);
  });
});

describe('banc invalide (I-5)', () => {
  it('un banc.yaml invalide met ses deux bras en échec, le passage continue ; un fichier sous bancs/ est ignoré', () => {
    const r = racine(); writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\n'); writeFileSync(join(r, 'bancs', 'LISEZMOI.md'), 'x');
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.vert).toBe(false);
    const res = (id: string) => JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-1100-e1', id, 'resultat.json'), 'utf8'));
    for (const b of ['A', 'C']) expect(res('1-a').mesures[b].echec).toMatch(/^banc invalide : banc 1-a : champ « source » manquant/);
    expect(res('2-b').mesures.C.echec).toBeNull();
  });
});
