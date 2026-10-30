import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { bugCodeOf, classifySous, dominantMaillon, ollamaSousClassifier, parseSousCause, readRuns, readSousCache, SOUS_CAUSES, type FixPass, type SousCause, type SousClassification } from '../src/corrections.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const at = (day: string, time = '12:00:00') => `${day}T${time}`;

/** Un dossier de projets avec `n` lots d'une passe de correction chacun, rendus le `day` ; rend le dossier et les clés des passes. */
function world(n: number, day = CUR, constat = 'le cas vide plante') {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', at('2026-10-01', '08:00:00'));
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    writeJournal(runs, 'w1', 'alpha', `L${i + 1}`, { steps: [{ kind: 'implement', ended: at(day, '09:00:00') }, { kind: 'review', constats: [constat], ended: at(day, '10:00:00') }, { kind: 'fix', ended: at(day, '11:00:00') }] });
    keys.push(`w1/alpha--L${i + 1}/3`);
  }
  return { root, runs, keys };
}
const causesFile = (root: string) => join(root, '.cadence', 'corrections.json');
const sousFile = (root: string) => join(root, '.cadence', 'corrections-sous-causes.json');
function writeCauses(root: string, keys: string[], cause = 'bug-code') {
  writeFileSync(causesFile(root), JSON.stringify(Object.fromEntries(keys.map((k) => [k, { cause, by: 'ollama:m' }]))));
}
function writeSous(root: string, entries: Record<string, { sous: string; by?: string; manual?: string }>) {
  writeFileSync(sousFile(root), JSON.stringify(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { by: 'ollama:m', ...v }]))));
}
/** Un tableau de comptes par sous-cause : `counts({ 'cas-limite': 6 })`. */
const counts = (c: Partial<Record<SousCause, number>>) => Object.fromEntries(SOUS_CAUSES.map((s) => [s, c[s] ?? 0])) as Record<SousCause, number>;
const pass = (key: string, findings: string[] = ['un constat']): FixPass => ({ key, project: 'alpha', lot: 'L1', visible: false, findings, commits: ['abc fix'] });

async function cad(cwd: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: { RAF_TODAY: TODAY, ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un faux Ollama : `answer(body)` rend le contenu du message ; `status` fait répondre une erreur. */
async function ollama(answer: (body: any) => string, status = 200) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = JSON.parse(data);
      bodies.push(body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { content: answer(body) } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => server.close() };
}
const isSous = (body: any) => 'sous' in body.format.properties;
const modele = (sous: SousCause) => (body: any) => (isSous(body) ? JSON.stringify({ sous, raison: 'r' }) : JSON.stringify({ cause: 'bug-code', raison: 'r' }));

describe('R1 — liste fermée et passes envoyées', () => {
  it('R1 — une passe bug-code est envoyée au modèle de sous-cause, une passe spec-floue ne l\'est pas', async () => {
    const w = world(2);
    writeFileSync(causesFile(w.root), JSON.stringify({ [w.keys[0]!]: { cause: 'bug-code', by: 'm' }, [w.keys[1]!]: { cause: 'spec-floue', by: 'm' } }));
    const asked: string[] = [];
    const cache = new Map<string, SousClassification>();
    const data = readRuns(w.runs);
    const causes = new Map(Object.entries(JSON.parse(readFileSync(causesFile(w.root), 'utf8')))) as never;
    await classifySous(data.passes, causes, cache, async (p) => { asked.push(p.key); return 'cas-limite'; }, 'm');
    expect(asked).toEqual([w.keys[0]]);
    expect([...cache.keys()]).toEqual([w.keys[0]]);
  });

  it('R1 — une passe dont la relecture à la main (manual) dit bug-code est envoyée, une cause modèle bug-code relue spec-floue ne l\'est pas', async () => {
    const w = world(2);
    const causes = new Map([[w.keys[0]!, { cause: 'spec-floue' as const, manual: 'bug-code' as const, by: 'm' }], [w.keys[1]!, { cause: 'bug-code' as const, manual: 'spec-floue' as const, by: 'm' }]]);
    const asked: string[] = [];
    await classifySous(readRuns(w.runs).passes, causes, new Map(), async (p) => { asked.push(p.key); return 'autre'; }, 'm');
    expect(asked).toEqual([w.keys[0]]);
  });

  it('R1 — une passe sans constat n\'est jamais envoyée', async () => {
    const asked: string[] = [];
    const causes = new Map([['k1', { cause: 'bug-code' as const, by: 'm' }]]);
    const added = await classifySous([pass('k1', [])], causes, new Map(), async (p) => { asked.push(p.key); return 'autre'; }, 'm');
    expect(asked).toEqual([]);
    expect(added).toBe(0);
  });

  it('R1 — une passe non classée par cause n\'est pas envoyée', async () => {
    const asked: string[] = [];
    await classifySous([pass('k1')], new Map(), new Map(), async (p) => { asked.push(p.key); return 'autre'; }, 'm');
    expect(asked).toEqual([]);
  });

  it('R1 — une réponse hors de la liste des sept sous-causes est refusée', async () => {
    expect(SOUS_CAUSES).toHaveLength(7);
    expect(parseSousCause('{"sous":"cas-limite"}')).toBe('cas-limite');
    expect(parseSousCause('{"sous":"spec-floue"}')).toBeNull();
    expect(parseSousCause('{"sous":3}')).toBeNull();
    expect(parseSousCause('cas-limite')).toBeNull();
    const horsListe = ollamaSousClassifier({ url: 'http://h', model: 'm', fetch: (async () => ({ ok: true, json: async () => ({ message: { content: '{"sous":"inventée","raison":"r"}' } }) })) as never });
    expect(await horsListe(pass('k'))).toBeNull();
    const cache = new Map<string, SousClassification>();
    await classifySous([pass('k')], new Map([['k', { cause: 'bug-code' as const, by: 'm' }]]), cache, horsListe, 'm');
    expect(cache.size).toBe(0);
  });
});

describe('R2 — maillon dominant', () => {
  it('R2 — 6 cas-limite et 4 test-vide sur 10 : le maillon dominant est le brief implement', () => {
    expect(dominantMaillon(counts({ 'cas-limite': 6, 'test-vide': 4 })).nom).toBe('brief implement');
  });

  it('R2 — 9 passes sous-classées seulement : aucun maillon dominant, raison donnée', () => {
    const d = dominantMaillon(counts({ 'cas-limite': 9 }));
    expect(d.nom).toBeNull();
    expect(d.raison).toContain('9 passes sous-classées');
    expect(d.raison).toContain('10');
  });

  it('R2 — deux maillons à égalité en tête : aucun maillon dominant', () => {
    const d = dominantMaillon(counts({ 'cas-limite': 5, 'contrat-mal-lu': 5 }));
    expect(d.nom).toBeNull();
    expect(d.raison).toContain('égalité');
    expect(d.raison).toContain('brief implement');
    expect(d.raison).toContain('fiche');
  });

  it('R2 — un maillon à 39 % : aucun maillon dominant, à 40 % : désigné', () => {
    // 100 passes : 39 cas-limite contre 31 + 30 d'autres maillons, puis 40 contre 30 + 30.
    expect(dominantMaillon(counts({ 'cas-limite': 39, 'test-casse': 31, 'contrat-mal-lu': 30 })).nom).toBeNull();
    expect(dominantMaillon(counts({ 'cas-limite': 40, 'test-casse': 30, 'contrat-mal-lu': 30 })).nom).toBe('brief implement');
  });

  it('R2 — la sous-cause autre ne désigne aucun maillon', () => {
    const d = dominantMaillon(counts({ autre: 12 }));
    expect(d.nom).toBeNull();
    expect(dominantMaillon(counts({ autre: 8, 'test-casse': 4 })).nom).toBeNull(); // autre pèse 67 % : le maillon test-casse n'atteint pas 40 %
  });

  it('R2 — chaque sous-cause relève de son maillon (auto-vérification, porte locale, fiche)', () => {
    expect(dominantMaillon(counts({ 'affirmation-fausse': 5, 'appelant-oublie': 5 })).nom).toBe('auto-vérification avant rendu');
    expect(dominantMaillon(counts({ 'test-casse': 10 })).nom).toBe('porte locale');
    expect(dominantMaillon(counts({ 'contrat-mal-lu': 10 })).nom).toBe('fiche');
  });
});

describe('R3 — un échec n\'entre pas au cache', () => {
  it('R3 — Ollama répond 500 : la passe n\'est pas au cache des sous-causes et est comptée sans sous-cause', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    const srv = await ollama(() => '{}', 500);
    try {
      const r = await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify', '--json');
      expect(r.code).toBe(0);
      expect(existsSync(sousFile(w.root))).toBe(false);
      const j = JSON.parse(r.out);
      expect(j.bugCode).toMatchObject({ classees: 0, sansSousCause: 1 });
      const txt = await cad(w.root, {}, 'corrections', w.root);
      expect(txt.out).toContain('sans sous-cause : 1');
    } finally {
      srv.close();
    }
  });

  it('R3 — une relance classe la passe restée hors cache', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'autre' } });
    const srv = await ollama(modele('cas-limite'));
    try {
      const r = await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify');
      expect(r.code).toBe(0);
      expect(srv.bodies.filter(isSous)).toHaveLength(1); // la passe déjà au cache n'est pas redemandée
      const cache = JSON.parse(readFileSync(sousFile(w.root), 'utf8'));
      expect(cache[w.keys[0]!].sous).toBe('autre');
      expect(cache[w.keys[1]!]).toEqual({ sous: 'cas-limite', by: 'ollama:mistral-small3.2:24b' });
    } finally {
      srv.close();
    }
  });

  it('R3 — une panne de sous-cause laisse corrections.json inchangé', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    const before = readFileSync(causesFile(w.root), 'utf8');
    // Le classeur des causes n'a rien à faire (cache plein) ; le sous-classeur échoue (statut 500).
    const srv = await ollama(() => '{}', 500);
    try {
      await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify');
      expect(JSON.parse(readFileSync(causesFile(w.root), 'utf8'))).toEqual(JSON.parse(before));
      expect(srv.bodies.every(isSous)).toBe(true);
    } finally {
      srv.close();
    }
  });
});

describe('R4 — manual prime', () => {
  it('R4 — manual contredit le modèle : le tableau compte la relecture', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite', manual: 'test-vide' } });
    const j = JSON.parse((await cad(w.root, {}, 'corrections', w.root, '--json')).out);
    expect(j.bugCode.parSousCause).toMatchObject({ 'cas-limite': 0, 'test-vide': 1 });
    expect(bugCodeOf([pass('k')], new Map([['k', { sous: 'cas-limite', by: 'm', manual: 'test-vide' }]]))!.parSousCause['test-vide']).toBe(1);
  });

  it('R4 — manual hors liste : la commande refuse le fichier', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite', manual: 'spec-floue' } });
    const r = await cad(w.root, {}, 'corrections', w.root);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${sousFile(w.root)} : sous-cause inconnue pour ${w.keys[0]} : spec-floue`);
  });
});

describe('R5 — le fichier du cache des sous-causes', () => {
  it('R5 — fichier illisible : code 1 et fichier intact', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    for (const bad of ['{pas du json', '[]', 'null']) {
      writeFileSync(sousFile(w.root), bad);
      const r = await cad(w.root, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', w.root, '--classify');
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain(`${sousFile(w.root)} : JSON illisible (un objet clé → classement est attendu), corrigez ou supprimez le fichier`);
      expect(readFileSync(sousFile(w.root), 'utf8')).toBe(bad);
    }
  });

  it('R5 — sous-cause inconnue : code 1 avec la clé citée', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'bof' } });
    const before = readFileSync(sousFile(w.root), 'utf8');
    const r = await cad(w.root, {}, 'corrections', w.root);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${sousFile(w.root)} : sous-cause inconnue pour ${w.keys[0]} : bof`);
    expect(readFileSync(sousFile(w.root), 'utf8')).toBe(before);
  });

  it('R5 — fichier absent : lu comme vide', () => {
    expect(readSousCache(join(tempDir(), 'rien.json')).size).toBe(0);
  });

  it('R5 — --cache-sous-causes lit et écrit un autre fichier', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    const srv = await ollama(modele('test-casse'));
    try {
      const r = await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify', '--cache-sous-causes', 'autre.json');
      expect(r.code).toBe(0);
      expect(existsSync(sousFile(w.root))).toBe(false);
      expect(JSON.parse(readFileSync(join(w.root, 'autre.json'), 'utf8'))[w.keys[0]!].sous).toBe('test-casse');
    } finally {
      srv.close();
    }
  });
});

describe('R6 — la ligne de cadence perf', () => {
  /** Dix passes bug-code de la fenêtre courante, sous-classées. */
  function perfWorld(sous: Partial<Record<SousCause, number>>) {
    const total = Object.values(sous).reduce((a, b) => a! + b!, 0)!;
    const w = world(total, CUR);
    writeCauses(w.root, w.keys);
    const entries: Record<string, { sous: string }> = {};
    let i = 0;
    for (const [s, n] of Object.entries(sous)) for (let k = 0; k < n!; k++) entries[w.keys[i++]!] = { sous: s };
    writeSous(w.root, entries);
    return w;
  }

  it('R6 — la ligne cite les sous-causes dans l\'ordre décroissant et le maillon', async () => {
    const w = perfWorld({ 'test-vide': 4, 'cas-limite': 6 });
    const r = await cad(w.root, {}, 'perf');
    const lines = r.out.split('\n');
    const causes = lines.findIndex((l) => l.includes('causes dominantes'));
    expect(lines[causes + 1]).toBe('  bug de code (10 passes sous-classées sur 10) : 1. cas limite 6 · 2. test vide 4 · maillon dominant : brief implement');
  });

  it('R6 — maillon aucun : la raison est imprimée', async () => {
    const w = perfWorld({ 'cas-limite': 3 });
    const line = (await cad(w.root, {}, 'perf')).out.split('\n').find((l) => l.includes('bug de code ('))!;
    expect(line).toBe('  bug de code (3 passes sous-classées sur 3) : 1. cas limite 3 · maillon dominant : aucun (3 passes sous-classées, il en faut au moins 10)');
  });

  it('R6 — les passes sans sous-cause sont comptées à part', async () => {
    const w = perfWorld({ 'cas-limite': 2 });
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' } });
    const line = (await cad(w.root, {}, 'perf')).out.split('\n').find((l) => l.includes('bug de code ('))!;
    expect(line).toContain('(1 passes sous-classées sur 2)');
    expect(line).toContain('sans sous-cause : 1');
  });

  it('R6 — seules les passes de la fenêtre courante sont comptées', async () => {
    const w = world(2, CUR);
    // une troisième passe, de la fenêtre précédente (10-05)
    writeJournal(w.runs, 'w1', 'alpha', 'L9', { steps: [{ kind: 'implement', ended: at('2026-10-05', '09:00:00') }, { kind: 'review', constats: ['x'], ended: at('2026-10-05', '10:00:00') }, { kind: 'fix', ended: at('2026-10-05', '11:00:00') }] });
    writeCauses(w.root, [...w.keys, 'w1/alpha--L9/3']);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' }, [w.keys[1]!]: { sous: 'cas-limite' }, 'w1/alpha--L9/3': { sous: 'test-vide' } });
    const out = (await cad(w.root, {}, 'perf')).out;
    expect(out).toContain('bug de code (2 passes sous-classées sur 2) : 1. cas limite 2 ·');
    expect(out).not.toContain('test vide');
    const data = JSON.parse((await cad(w.root, {}, 'perf', '--json')).out);
    expect(data.corrections.causes.previous.bugCode).toBeUndefined();
  });
});

describe('R7 — perf lit sans bloquer', () => {
  it('R7 — cache absent : la ligne n/d et le code 0', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    const r = await cad(w.root, {}, 'perf');
    expect(r.code).toBe(0);
    expect(r.out).toContain('  bug de code (2 passes) : sous-causes n/d · à classer : cadence corrections --classify');
    expect(r.err).not.toContain('illisible');
  });

  it('R7 — cache illisible : avertissement, ligne omise, reste du tableau identique, code 0', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    const sans = await cad(w.root, {}, 'perf');
    writeFileSync(sousFile(w.root), '{pas du json');
    const r = await cad(w.root, {}, 'perf');
    expect(r.code).toBe(0);
    expect(r.err).toContain(`perf : ${sousFile(w.root)} illisible, sous-causes n/d`);
    expect(r.out).not.toContain('bug de code (');
    expect(r.out).toBe(sans.out.split('\n').filter((l) => !l.includes('bug de code (')).join('\n'));
    const j = JSON.parse((await cad(w.root, {}, 'perf', '--json')).out);
    expect(j.corrections.causes.current.bugCode).toBeUndefined();
  });

  it('R7 — perf n\'écrit aucun fichier', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'autre' } });
    const lire = () => [causesFile(w.root), sousFile(w.root)].map((f) => readFileSync(f, 'utf8'));
    const avant = lire();
    await cad(w.root, {}, 'perf');
    expect(lire()).toEqual(avant);
    const absent = world(1);
    writeCauses(absent.root, absent.keys);
    await cad(absent.root, {}, 'perf');
    expect(existsSync(sousFile(absent.root))).toBe(false);
  });
});

describe('R9 — rien ne change sans passe bug-code', () => {
  it('R9 — sans bug-code, le rapport texte est identique à celui d\'avant', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys, 'spec-floue');
    const avec = await cad(w.root, {}, 'corrections', w.root);
    expect(avec.out).not.toContain('sous-cause');
    expect(avec.out).not.toContain('Maillon');
    // sans fichier de sous-causes ni passe bug-code : la sortie est celle du rapport seul
    // référence figée (le rapport d'avant le lot), pas le rendu du code courant
    const titres = avec.out.split('\n').filter((l) => l.startsWith('### '));
    expect(titres).toEqual([
      '### Par cause',
      '### Par cause et par projet (passes)',
      '### Lots avec correction',
      '### Lots visibles et non visibles',
      '### Par cause et par visibilité (passes)',
    ]);
    expect(avec.out.split('\n')[0]).toMatch(/^\*\*\d+ lots\*\* passés par une session d'écriture, \*\*\d+ passes de correction\*\* : .* au moins deux\.$/);
    expect(avec.out.trimEnd().split('\n').pop()).toMatch(/^\| non visibles \|/);
    const perf = await cad(w.root, {}, 'perf');
    expect(perf.out).not.toContain('bug de code (');
  });

  it('R9 — --json : les clés existantes sont inchangées, bugCode s\'ajoute', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys, 'spec-floue');
    const sans = JSON.parse((await cad(w.root, {}, 'corrections', w.root, '--json')).out);
    expect(sans.bugCode).toBeUndefined();
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' } });
    const avec = JSON.parse((await cad(w.root, {}, 'corrections', w.root, '--json')).out);
    expect(Object.keys(avec)).toEqual([...Object.keys(sans), 'bugCode']);
    expect(avec.total).toEqual(sans.total);
    expect(avec.bugCode).toMatchObject({ classees: 1, sansSousCause: 1, maillon: { nom: null } });
    expect(Object.keys(avec.bugCode)).toEqual(['classees', 'sansSousCause', 'parSousCause', 'maillon']);
    expect(Object.keys(avec.bugCode.parSousCause)).toEqual([...SOUS_CAUSES]);
  });

  it('R9 — perf --json : les clés de corrections.causes.current existantes sont inchangées', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys, 'spec-floue');
    const sans = JSON.parse((await cad(w.root, {}, 'perf', '--json')).out).corrections.causes.current;
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' } });
    const avec = JSON.parse((await cad(w.root, {}, 'perf', '--json')).out).corrections.causes.current;
    expect(Object.keys(avec)).toEqual([...Object.keys(sans), 'bugCode']);
    expect(avec.bugCode.classees).toBe(1);
  });

  it('R9 — corrections.json n\'est pas modifié par la sous-classification', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    const before = readFileSync(causesFile(w.root), 'utf8');
    const srv = await ollama(modele('autre'));
    try {
      await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify');
      expect(JSON.parse(readFileSync(causesFile(w.root), 'utf8'))).toEqual(JSON.parse(before));
      expect(Object.keys(JSON.parse(readFileSync(causesFile(w.root), 'utf8'))[w.keys[0]!])).toEqual(['cause', 'by']);
    } finally {
      srv.close();
    }
  });
});

describe('R10 — le prompt de sous-classement', () => {
  it('R10 — la requête a temperature 0 et un enum de sept sous-causes', async () => {
    const calls: any[] = [];
    const fake = (async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ message: { content: '{"sous":"test-vide","raison":"r"}' } }) };
    }) as never;
    expect(await ollamaSousClassifier({ url: 'http://h:1/', model: 'm1', fetch: fake })(pass('k'))).toBe('test-vide');
    expect(calls[0].options.temperature).toBe(0);
    expect(calls[0].format.properties.sous.enum).toEqual([...SOUS_CAUSES]);
    expect(calls[0].format.properties.sous.enum).toHaveLength(7);
    expect(calls[0].model).toBe('m1');
    const system = calls[0].messages[0].content as string;
    for (const s of SOUS_CAUSES) expect(system).toContain(`- ${s} :`);
    expect(JSON.stringify(calls[0].messages)).toContain('abc fix');
  });

  it('R10 — les constats sont tronqués à 1500 caractères', async () => {
    const calls: any[] = [];
    const fake = (async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ message: { content: '{"sous":"autre","raison":"r"}' } }) };
    }) as never;
    await ollamaSousClassifier({ url: 'http://h', model: 'm', fetch: fake })(pass('k', ['a'.repeat(1600)]));
    const user = calls[0].messages[1].content as string;
    expect(user).toContain('a'.repeat(1500));
    expect(user).not.toContain('a'.repeat(1501));
  });
});

describe('R12 — les entrées hors passes bug-code sont ignorées', () => {
  it('R12 — une entrée dont la passe est re-classée spec-floue n\'est pas comptée', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' }, [w.keys[1]!]: { sous: 'test-vide' } });
    writeFileSync(causesFile(w.root), JSON.stringify({ [w.keys[0]!]: { cause: 'bug-code', by: 'm' }, [w.keys[1]!]: { cause: 'bug-code', manual: 'spec-floue', by: 'm' } }));
    const j = JSON.parse((await cad(w.root, {}, 'corrections', w.root, '--json')).out);
    expect(j.bugCode).toMatchObject({ classees: 1, sansSousCause: 0 });
    expect(j.bugCode.parSousCause['test-vide']).toBe(0);
  });

  it('R12 — une clé absente de la fenêtre est ignorée et le fichier reste intact', async () => {
    const w = world(1);
    writeCauses(w.root, w.keys);
    writeSous(w.root, { [w.keys[0]!]: { sous: 'cas-limite' }, 'w0/ancien--L0/3': { sous: 'test-vide' } });
    const before = readFileSync(sousFile(w.root), 'utf8');
    const srv = await ollama(modele('autre'));
    try {
      const r = await cad(w.root, { OLLAMA_HOST: srv.host }, 'corrections', w.root, '--classify', '--json');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).bugCode).toMatchObject({ classees: 1, parSousCause: { 'test-vide': 0, 'cas-limite': 1 } });
      expect(readFileSync(sousFile(w.root), 'utf8')).toBe(before);
    } finally {
      srv.close();
    }
  });
});

describe('A1 — la section du rapport texte', () => {
  it('le rapport ajoute la section « Bug de code par sous-cause » avec part et maillon, et la ligne du maillon dominant', async () => {
    const w = world(10);
    writeCauses(w.root, w.keys);
    writeSous(w.root, Object.fromEntries(w.keys.map((k, i) => [k, { sous: i < 6 ? 'cas-limite' : 'test-vide' }])));
    const r = await cad(w.root, {}, 'corrections', w.root);
    expect(r.out).toContain('### Bug de code par sous-cause');
    expect(r.out).toContain('| Sous-cause | Passes | Part | Maillon |');
    expect(r.out).toContain('| cas limite | 6 | 60 % | brief implement |');
    expect(r.out).toContain('| test vide | 4 | 40 % | brief implement |');
    expect(r.out).toContain('Maillon dominant : brief implement — 10 passes sur 10 sous-classées (100 %).');
  });

  it('sans sous-cause classée, la section dit comment les classer et n\'imprime pas de tableau', async () => {
    const w = world(2);
    writeCauses(w.root, w.keys);
    const r = await cad(w.root, {}, 'corrections', w.root);
    expect(r.out).toContain('0 passes sous-classées sur 2 · sans sous-cause : 2 (à classer : cadence corrections --classify)');
    expect(r.out).not.toContain('| Sous-cause |');
    expect(r.out).toContain('Maillon dominant : aucun (0 passes sous-classées, il en faut au moins 10).');
  });
});
