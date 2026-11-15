import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur, Mesure } from '../src/bench/bras.js';
import { lirePassages, passage } from '../src/bench/cli.js';
import { BARRE_SPEC, BRUIT_MAX, bruitParBanc, PAIRES_IDENTIQUES_L735, verdictSansJuge, type PassageLu, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L737 (étude L735, docs/etudes/banc3-lenteur.md) : le critère de temps déclarait rouges des passages où les deux bras étaient identiques.
// Les durées ci-dessous sont celles de ~/bench-cadence/rapports/<run>.json : [banc, référence, candidat, non livré].
type Ligne = [string, number, number, boolean?];
const IDENTIQUES: [string, Ligne[]][] = [
  ['2026-11-13-1717-af18c3783fa3', [['1-ol-companion-L239', 142, 156], ['3-ol-companion-L241', 597, 214], ['6-ol-companion-L167', 518, 71]]],
  ['2026-11-13-2047-2b220bd21ebf', [['1-ol-companion-L239', 166, 186], ['3-ol-companion-L241', 283, 204], ['6-ol-companion-L167', 88, 112]]],
  ['2026-11-14-0002-0118958c983c', [['1-ol-companion-L239', 156, 210], ['3-ol-companion-L241', 335, 668], ['6-ol-companion-L167', 109, 82]]],
  ['2026-11-14-1000-0118958c983c', [['1-ol-companion-L239', 173, 142], ['3-ol-companion-L241', 312, 467], ['6-ol-companion-L167', 441, 479]]],
  ['2026-11-14-1018-0118958c983c', [['1-ol-companion-L239#1', 152, 140], ['1-ol-companion-L239#2', 165, 156], ['3-ol-companion-L241#1', 202, 650],
    ['3-ol-companion-L241#2', 550, 568], ['6-ol-companion-L167#1', 761, 59], ['6-ol-companion-L167#2', 74, 671]]],
  ['2026-11-14-1721-1085f4914df4', [['1-ol-companion-L239', 150, 143], ['3-ol-companion-L241', 749, 498], ['6-ol-companion-L167', 510, 542]]],
  ['2026-11-15-1540-f83140f3ab70', [['1-ol-companion-L239', 147, 183], ['3-ol-companion-L241', 481, 730], ['6-ol-companion-L167', 90, 510]]],
  ['2026-11-15-1604-f83140f3ab70', [['1-ol-companion-L239', 169, 182], ['3-ol-companion-L241', 489, 655], ['6-ol-companion-L167', 75, 719]]],
  ['2026-11-15-1749-edc99cb3f24c', [['1-ol-companion-L239', 202, 178], ['3-ol-companion-L241', 286, 599], ['6-ol-companion-L167', 473, 82, true]]],
];

const mes = (bras: string, duree_s: number, empreinte_bras?: string, echec: string | null = null): Mesure =>
  ({ bras, banc: 'b', debut: '', fin: '', duree_s, tokens: 1, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec, ...(empreinte_bras && { empreinte_bras }) });
const banc = ([id, a, c, nonLivre]: Ligne, e?: [string, string]): ResultatBanc => ({
  banc: id, taille: id.startsWith('1-') ? 'retouche' : 'fonction', visible: false, reponses: false, frais: false,
  mesures: { A: mes('A', a, e?.[0]), C: mes('C', c, e?.[1]) }, jugement: null, fuites: { A: [], C: [] },
  sans_juge: { A: { suite_ok: true, caches_ok: true }, C: { suite_ok: true, caches_ok: true } }, ...(nonLivre && { non_livre: { C: 'plan seul' } }) });
const passages: PassageLu[] = IDENTIQUES.map(([run, l]) => ({ run, resultats: l.map((x) => banc(x)) }));
const TEMPS = ['temps total', 'temps des retouches'];
const LE_15 = new Date('2026-11-15T18:00:00Z'); // L738 : le bruit ne vaut que 14 jours ; ces tests lisent l'historique au soir du 15-11
const rougesTemps = (res: ResultatBanc[], bruit?: Record<string, number>) =>
  verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, ...(bruit && { bruit }) }).criteres.filter((x) => TEMPS.includes(x.nom) && x.bloquant && !x.ok).map((x) => x.nom);

describe('le temps tient compte du bruit de chaque banc (L737)', () => {
  const bruit = bruitParBanc(passages, LE_15);

  it('le bruit de chaque banc est le plus grand écart entre bras identiques : banc 1 1,35, bancs 3 et 6 bruités', () => {
    expect(bruit['1-ol-companion-L239']).toBeCloseTo(210 / 156);
    expect(bruit['3-ol-companion-L241']).toBeCloseTo(650 / 202);
    expect(bruit['6-ol-companion-L167']).toBeCloseTo(761 / 59); // le banc non livré du 15-11 17:49 (473 contre 82) ne compte pas
    expect(bruit['1-ol-companion-L239']).toBeLessThan(BRUIT_MAX);
  });

  it('rejouer les passages à bras identiques : 4 rouges de temps sur 9 avant, 0 après', () => {
    expect(passages.filter((p) => rougesTemps(p.resultats).length).map((p) => p.run))
      .toEqual(['2026-11-14-0002-0118958c983c', '2026-11-15-1540-f83140f3ab70', '2026-11-15-1604-f83140f3ab70', '2026-11-15-1749-edc99cb3f24c']);
    expect(passages.map((p) => rougesTemps(p.resultats, bruit))).toEqual(passages.map(() => []));
  });

  it('un vrai écart × 2 sur un banc non bruité reste rouge, temps total et retouches', () => {
    const res = [banc(['1-ol-companion-L239', 150, 300]), banc(['3-ol-companion-L241', 300, 300]), banc(['6-ol-companion-L167', 300, 300])];
    expect(rougesTemps(res, bruit)).toEqual(['temps total', 'temps des retouches']);
    const v = verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, bruit });
    expect(v.vert).toBe(false);
    expect(v.criteres.find((x) => x.nom === 'temps des retouches')!.seuil).toBe('≤ 202 s (seuil par banc, bruit compris : 1-ol-companion-L239 1,35)');
  });

  it('un banc bruité sort des critères bloquants et se lit, indicatif, dans « temps des bancs bruités »', () => {
    const res = [banc(['1-ol-companion-L239', 150, 150]), banc(['6-ol-companion-L167', 100, 900])];
    const v = verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, bruit });
    expect(v.vert).toBe(true);
    expect(v.criteres.find((x) => x.nom === 'temps total')).toMatchObject({ valeur: '150 s contre 150 s', ok: true, bloquant: true });
    expect(v.criteres.find((x) => x.nom === 'temps des bancs bruités')).toMatchObject({ valeur: '900 s contre 100 s (6-ol-companion-L167 12,9)', ok: false, bloquant: false });
  });

  it('tous les bancs bruités : le temps total n\'a plus de banc fiable et devient indicatif', () => {
    const v = verdictSansJuge([banc(['3-ol-companion-L241', 100, 900])], 'A', 'C', { ...BARRE_SPEC, bruit });
    expect(v.criteres.find((x) => x.nom === 'temps total')).toMatchObject({ valeur: 'aucun banc au temps fiable', bloquant: false });
    expect(v.vert).toBe(true);
  });

  it('sans bruit connu, la règle d\'avant : 1,5 × A et 1,2 × A, mêmes libellés', () => {
    const v = verdictSansJuge([banc(['1-x', 100, 130])], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((x) => x.nom === 'temps des retouches')).toMatchObject({ seuil: '≤ 1.2 × A', ok: false, bloquant: true });
    expect(v.criteres.find((x) => x.nom === 'temps total')).toMatchObject({ seuil: '≤ 1.5 × A', ok: true });
    expect(v.criteres.some((x) => x.nom === 'temps des bancs bruités')).toBe(false);
  });

  it('les règles L733 tiennent : un banc non livré sort de tout, un banc bruité n\'y change rien', () => {
    const res = [banc(['1-ol-companion-L239', 100, 300]), banc(['6-ol-companion-L167', 100, 100, true])];
    const v = verdictSansJuge(res, 'A', 'C', { ...BARRE_SPEC, bruit });
    expect(v.criteres.filter((x) => x.bloquant && !x.ok).map((x) => x.nom)).toEqual(['temps total', 'temps des retouches']);
    expect(v.non_mesurable).toBeUndefined();
  });
});

describe('bruitParBanc : seules les paires de bras identiques mesurent le bruit (L737)', () => {
  it('même empreinte de bras : la paire compte ; empreintes différentes ou absentes : non', () => {
    const p = (run: string, e?: [string, string]): PassageLu => ({ run: `2026-11-15-1000-${run}`, resultats: [banc(['9-x#1', 100, 180], e)] });
    expect(bruitParBanc([p('r1', ['e', 'e'])], LE_15)).toEqual({ '9-x': 1.8 });
    expect(bruitParBanc([p('r1', ['e', 'f']), p('r2')], LE_15)).toEqual({});
  });

  it('un passage de l\'étude L735 compte sans empreinte ; un bras en échec ou un banc non livré, jamais', () => {
    const r = banc(['9-x', 100, 400]); r.mesures.C.echec = 'code 1';
    expect(bruitParBanc([{ run: PAIRES_IDENTIQUES_L735[0], resultats: [banc(['9-x', 100, 150]), r, banc(['8-y', 100, 900, true])] }], LE_15)).toEqual({ '9-x': 1.5 });
  });

  it('lirePassages lit les rapports de bancs dans l\'ordre et saute les séquences et les fichiers illisibles', () => {
    const d = dossierTemp('passages-'), rap = join(d, 'rapports');
    mkdirSync(rap, { recursive: true });
    writeFileSync(join(rap, '2026-11-15-1749-e.json'), JSON.stringify({ verdict: {}, resultats: [banc(['1-a', 1, 2])] }));
    writeFileSync(join(rap, '2026-11-08-1135-e-aether-b68-r1.json'), JSON.stringify({ verdict: {}, resultat: {} }));
    writeFileSync(join(rap, '2026-11-01-0000-e.json'), '{');
    writeFileSync(join(rap, '2026-11-01-0000-e.md'), '# rapport');
    expect(lirePassages(d).map((p) => p.run)).toEqual(['2026-11-15-1749-e']);
    expect(lirePassages(join(d, 'absent'))).toEqual([]);
  });
});

describe('passage : ordre alterné d\'un passage à l\'autre, empreinte du bras notée (L737)', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  function racine(): string {
    const r = dossierTemp('bench-l737-');
    for (const id of ['1-a', '2-b']) {
      mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
      writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
      writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
    }
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\nC:\n  modele: opus\n  brief: ${BRIEF}\nS:\n  modele: sonnet\n  brief: ${BRIEF}\n`);
    return r;
  }
  const prep = (_b: unknown, cible: string) => {
    mkdirSync(cible, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
    return { testsBase: 0 };
  };
  const exec: Executeur = (_args, o) => {
    writeFileSync(join(o.cwd, 'f.ts'), 'x'); // un fichier de code livré : le banc est mesuré (L733)
    execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -q -m bras'], { cwd: o.cwd });
    return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
  const jouer = (r: string, cand: string, quand: string) => passage({ racine: r, ref: 'A', cand, hebdo: false, juge: 'opus', niveau: 'mecanique', exec, prep: prep as never,
    maintenant: new Date(quand), empreinte: 'e1', home: r, out: () => {} });
  const clones = (r: string, run: string, id: string) => JSON.parse(readFileSync(join(r, 'runs', run, id, 'resultat.json'), 'utf8')).clones;

  it('le second passage d\'un banc inverse l\'ordre de ses bras ; les bras de même brief et modèle ont la même empreinte', async () => {
    const r = racine();
    await jouer(r, 'C', '2026-11-15T10:00:00Z');
    await jouer(r, 'C', '2026-11-15T11:00:00Z');
    expect([clones(r, '2026-11-15-1100-e1', '1-a'), clones(r, '2026-11-15-1100-e1', '2-b')]).toEqual([{ c1: 'A', c2: 'C' }, { c1: 'C', c2: 'A' }]);
    expect([clones(r, '2026-11-15-1200-e1', '1-a'), clones(r, '2026-11-15-1200-e1', '2-b')]).toEqual([{ c1: 'C', c2: 'A' }, { c1: 'A', c2: 'C' }]);
    const [p] = lirePassages(r);
    const m = p.resultats[0].mesures;
    expect(m.A.empreinte_bras).toMatch(/^[0-9a-f]{12}$/);
    expect(m.C.empreinte_bras).toBe(m.A.empreinte_bras);
    for (const x of p.resultats) { x.mesures.A.duree_s = 100; x.mesures.C.duree_s = 130; } // le faux claude rend la main en 0 s : un temps nul ne mesure rien
    expect(bruitParBanc([p], LE_15)).toEqual({ '1-a': 1.3, '2-b': 1.3 });
  });

  it('un modèle différent change l\'empreinte : la paire ne mesure pas le bruit', async () => {
    const r = racine();
    await jouer(r, 'S', '2026-11-15T10:00:00Z');
    const [p] = lirePassages(r);
    expect(p.resultats[0].mesures.S.empreinte_bras).not.toBe(p.resultats[0].mesures.A.empreinte_bras);
    for (const x of p.resultats) { x.mesures.A.duree_s = 100; x.mesures.S.duree_s = 130; }
    expect(bruitParBanc([p], LE_15)).toEqual({});
  });
});
