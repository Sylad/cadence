import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur, Mesure } from '../src/bench/bras.js';
import { bench, jumeau, lirePassages, numerosARemesurer, passage } from '../src/bench/cli.js';
import { complet } from '../src/bench/complet.js';
import { BARRE_SPEC, bancsARemesurer, bruitParBanc, datePassage, verdictSansJuge, type PassageLu, type ResultatBanc } from '../src/bench/verdict.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L738 : depuis L736 les bras du banc ne sont plus identiques ; un bruit figé sur l'historique d'avant rendrait les bancs 3 et 6 non bloquants pour toujours.
// Règle : le bruit d'un banc expire 14 jours après sa dernière paire A contre A ; le samedi remesure les bancs bruités ou dont le bruit expire dans les 7 jours.
const mes = (bras: string, duree_s: number, empreinte_bras = 'meme'): Mesure =>
  ({ bras, banc: 'b', debut: '', fin: '', duree_s, tokens: 1, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null, empreinte_bras });
const banc = (id: string, a: number, c: number, e: [string, string] = ['meme', 'meme']): ResultatBanc => ({
  banc: id, taille: 'fonction', visible: false, reponses: false, frais: false, mesures: { A: mes('A', a, e[0]), C: mes('C', c, e[1]) }, jugement: null,
  fuites: { A: [], C: [] }, sans_juge: { A: { suite_ok: true, caches_ok: true }, C: { suite_ok: true, caches_ok: true } } });
/** Un passage A contre A du jour `j` (novembre 2026, 10:00 à Paris) sur un banc, d'écart `a` contre `c`. */
const paire = (j: number, id: string, a: number, c: number): PassageLu => ({ run: `2026-11-${String(j).padStart(2, '0')}-1000-e0-bruit`, resultats: [banc(id, a, c)] });
const le = (j: number, h = 10) => new Date(Date.UTC(2026, 10, j, h - 1)); // 10:00 à Paris en novembre (CET)

describe('datePassage : l\'instant d\'un passage vient de son nom, à l\'heure de Paris', () => {
  it('hiver, été, nom sans date', () => {
    expect(datePassage('2026-11-15-1749-edc99cb3f24c')?.toISOString()).toBe('2026-11-15T16:49:00.000Z');
    expect(datePassage('2026-07-01-1200-e-bruit')?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(datePassage('r1')).toBeNull();
  });
});

describe('le bruit d\'un banc expire 14 jours après sa dernière paire A contre A (L738)', () => {
  const h = [paire(1, '3-x', 100, 500)];

  it('13 jours après la paire, le banc est bruité ; 15 jours après, il n\'a plus de bruit', () => {
    expect(bruitParBanc(h, le(14))).toEqual({ '3-x': 5 });
    expect(bruitParBanc(h, le(15))).toEqual({ '3-x': 5 }); // 14 jours pile : encore valable
    expect(bruitParBanc(h, le(16))).toEqual({});
  });

  it('sans bruit récent, le banc redevient bloquant au seuil par défaut (1,5 × A, 1,2 × A)', () => {
    const res = [{ ...banc('3-x', 100, 200), taille: 'retouche' as const }];
    const bruite = verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, bruit: bruitParBanc(h, le(14)) });
    expect(bruite.vert).toBe(true);
    expect(bruite.criteres.find((x) => x.nom === 'temps total')).toMatchObject({ valeur: 'aucun banc au temps fiable', bloquant: false });
    const expire = verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, bruit: bruitParBanc(h, le(16)) });
    expect(expire.vert).toBe(false);
    expect(expire.criteres.filter((x) => x.nom.startsWith('temps')).map((x) => [x.nom, x.seuil, x.ok, x.bloquant]))
      .toEqual([['temps total', '≤ 1.5 × A', false, true], ['temps des retouches', '≤ 1.2 × A', false, true]]);
  });

  it('les paires L735 d\'avant L736 expirent elles aussi : au 30-11, les bancs 3 et 6 ne sont plus bruités', () => {
    const l735: PassageLu = { run: '2026-11-15-1604-f83140f3ab70', resultats: [banc('6-ol-companion-L167', 75, 719, ['', ''])] };
    expect(bruitParBanc([l735], le(29))).toEqual({ '6-ol-companion-L167': 719 / 75 });
    expect(bruitParBanc([l735], le(30, 18))).toEqual({});
  });

  it('une remesure calme remplace un vieux bruit : chaque paire compte 14 jours', () => {
    const remesure = [...h, paire(10, '3-x', 100, 110)];
    expect(bruitParBanc(remesure, le(14))['3-x']).toBe(5);
    expect(bruitParBanc(remesure, le(16))['3-x']).toBeCloseTo(1.1);
    expect(bruitParBanc(remesure, le(25))).toEqual({});
  });

  it('bras différents (cadence-run contre A depuis L736) : la paire ne remesure rien', () => {
    expect(bruitParBanc([{ run: '2026-11-14-1000-e', resultats: [banc('3-x', 100, 500, ['a', 'c'])] }], le(15))).toEqual({});
  });
});

describe('bancs à remesurer par le banc complet du samedi (L738)', () => {
  it('bruité, ou dernière paire de 7 jours ou plus (bruit qui expire dans les 7 jours, ou expiré) ; jamais un banc sans paire', () => {
    const h = [paire(19, '1-calme', 100, 120), paire(20, '3-bruite', 100, 300), paire(14, '6-expire-bientot', 100, 110), paire(1, '7-expire', 100, 110)];
    const ids = ['1-calme', '3-bruite', '6-expire-bientot', '7-expire', '8-frais'];
    expect(bancsARemesurer(h, le(21), ids)).toEqual(['3-bruite', '6-expire-bientot', '7-expire']);
    expect(bancsARemesurer(h, le(20, 12), ids)).toEqual(['3-bruite', '7-expire']); // le 20 à midi : la paire du 14 a moins de 7 jours
  });
});

describe('cadence2 bench bruit : A contre son jumeau, sans juge (L738)', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  function racine(brasEnPlus = ''): string {
    const r = dossierTemp('bench-l738-');
    for (const id of ['1-a', '3-b', '6-c']) {
      mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
      writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
      writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
    }
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: opus\n  brief: ${BRIEF}\n${brasEnPlus}`);
    return r;
  }
  const prep = (_b: unknown, cible: string) => {
    mkdirSync(cible, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
    return { testsBase: 0 };
  };
  const exec: Executeur = (_args, o) => {
    writeFileSync(join(o.cwd, 'f.ts'), 'x');
    execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -q -m bras'], { cwd: o.cwd });
    return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };

  it('le passage oppose A à A-bis, de même empreinte : son rapport remesure le bruit, l\'historique de la garde ne le voit pas', async () => {
    const r = racine(), sortie: string[] = [];
    await passage({ racine: r, numeros: ['3'], niveau: 'bruit', ref: 'A', cand: jumeau('A'), hebdo: false, juge: 'opus', exec, prep: prep as never,
      maintenant: new Date('2026-11-21T09:00:00Z'), empreinte: 'e1', home: r, out: (l) => sortie.push(l) });
    expect(existsSync(join(r, 'historique.jsonl'))).toBe(false);
    const [p] = lirePassages(r);
    expect(p.run).toBe('2026-11-21-1000-e1-bruit');
    const m = p.resultats[0].mesures;
    expect(Object.keys(m).sort()).toEqual(['A', 'A-bis']);
    expect(m['A-bis'].empreinte_bras).toBe(m.A.empreinte_bras);
    expect(sortie.at(-1)).toMatch(/^bruit remesuré, A contre A-bis : 3-b non mesuré — /); // le faux claude rend la main en 0 s
    m.A.duree_s = 300; m['A-bis'].duree_s = 330;
    expect(bruitParBanc([p], new Date('2026-12-04T09:00:00Z'))['3-b']).toBeCloseTo(1.1);
    expect(bruitParBanc([p], new Date('2026-12-06T09:00:00Z'))).toEqual({});
  });

  it('rien à remesurer : code 0 sans passage ; A-bis déjà dans bras.yaml : refusé (code 2)', async () => {
    const io = ioTest({ BENCH_ROOT: racine(), HOME: '/x' });
    expect(await bench(['bruit'], io, '/d')).toBe(0);
    expect(io.sortie.join('\n')).toContain('bruit : aucun banc à remesurer');
    const refus = ioTest({ BENCH_ROOT: racine('A-bis:\n  modele: sonnet\n  brief: x\n'), HOME: '/x' });
    expect(await bench(['bruit', '--bancs', '3'], refus, '/d')).toBe(2);
    expect(refus.erreurs.join('\n')).toContain('bras A-bis déjà défini');
  });

  it('bench complet joue d\'abord le passage A contre A sur les bancs à remesurer, puis le court ; sans banc à remesurer, rien ne change', async () => {
    const r = racine();
    mkdirSync(join(r, 'sequences', 's1'), { recursive: true }); mkdirSync(join(r, 'rapports'), { recursive: true });
    writeFileSync(join(r, 'rapports', '2026-11-14-1000-e0-bruit.json'), JSON.stringify({ verdict: {}, resultats: [banc('3-b', 100, 400), banc('1-a', 100, 110)] }));
    const appels: string[][] = [];
    const d = { bench: async (a: string[]) => { appels.push(a); return 0; }, sequence: async () => 0 };
    const io = { ...ioTest({ BENCH_ROOT: r, HOME: '/x' }), now: () => le(21) };
    expect(numerosARemesurer(r, le(21))).toEqual(['1', '3']);
    expect(await complet([], io, d)).toBe(0);
    expect(appels.slice(0, 2)).toEqual([['bruit', '--bancs', '1,3'], ['court', '--candidat', 'cadence-run', '--reference', 'A']]);
    appels.length = 0;
    expect(await complet([], { ...io, now: () => le(15) }, d)).toBe(0); // le 15 : banc 3 bruité seulement
    expect(appels[0]).toEqual(['bruit', '--bancs', '3']);
  });
});
