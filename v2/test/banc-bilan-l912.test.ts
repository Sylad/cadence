import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bilan, classerAuPassage, classerPassage, depotGit, lignesBilan, lignesClassement, nomRapport, tranche, type Depot, type Passage } from '../src/bench/bilan.js';
import type { Mesure } from '../src/bench/bras.js';
import { bench, empreinte } from '../src/bench/cli.js';
import { rapport, type ResultatBanc, type Verdict } from '../src/bench/verdict.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L912 (D-40) : chaque rouge du banc est classé régression réelle (corrigée ensuite par un commit de v2/ hors du banc) ou bruit (charge,
// réseau ou amont, rejoué vert sans changement, banc lui-même corrigé) ; `bench bilan` compte sur 4 semaines bancs joués, heures de machine,
// régressions réelles, faux rouges et ce que la suite de tests seule aurait laissé passer. Vécu du 27-11 : 2 rouges sur 3 bancs mécaniques dus à la charge.

const mesure = (bras: string, echec: string | null = null): Mesure => ({ bras, banc: '1', debut: '', fin: '', duree_s: 100, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec });
const res = (echec: string | null = null): ResultatBanc[] => [{ banc: '1-ol-companion-L239', taille: 'retouche', visible: false, reponses: false, frais: false,
  mesures: { A: mesure('A'), 'cadence-run': mesure('cadence-run', echec) }, jugement: null, fuites: {} }];
const critere = (nom: string, ok: boolean, x: { bloquant?: boolean; non_mesurable?: string } = {}) => ({ nom, valeur: 'v', seuil: 's', ok, bloquant: x.bloquant ?? true, ...x });

describe('au passage : le rapport classe ce qu\'il sait déjà', () => {
  it('temps non mesurable (L911) : bruit ; rouge sans cause connue : non tranché, à trancher par bench bilan', () => {
    const v: Verdict = { vert: false, criteres: [critere('temps des retouches', false, { bloquant: false, non_mesurable: 'charge 23,58 au-dessus de 16,00 (32 cœurs ÷ 2)' }),
      critere('aucune fuite', false), critere('temps total', true)] };
    const cl = classerAuPassage(v, res());
    expect(cl).toEqual({ 'temps des retouches': { classe: 'bruit', cause: 'non mesurable (charge 23,58 au-dessus de 16,00 (32 cœurs ÷ 2))' },
      'aucune fuite': { classe: 'non tranché', cause: expect.stringMatching(/^à trancher par « cadence2 bench bilan » : régression réelle si un commit de v2\/ hors du banc/) } });
    const md = rapport(res(), 'A', 'cadence-run', v, { date: '2026-11-27', empreinte: 'e', classement: lignesClassement(cl) });
    expect(md).toContain('## Classement des rouges (L912)\n\n- temps des retouches : bruit — non mesurable (charge 23,58');
    expect(md).toContain('- aucune fuite : non tranché — à trancher');
  });
  it('un bras en échec pour le réseau ou l\'amont : ses rouges sont du bruit', () => {
    const cl = classerAuPassage({ vert: false, criteres: [critere('aucun bras en échec', false)] }, res('API Error: 529 overloaded'));
    expect(cl['aucun bras en échec']).toEqual({ classe: 'bruit', cause: 'réseau ou amont (1-ol-companion-L239/cadence-run : API Error: 529 overloaded)' });
  });
  it('rien de rouge : pas de section', () => {
    expect(lignesClassement(classerAuPassage({ vert: true, criteres: [critere('aucune fuite', true)] }, res()))).toEqual([]);
  });
});

const p = (date: string, empreinte: string, vert: boolean, rouges: string[] = [], x: Partial<Passage> = {}): Passage => ({ date, empreinte, vert, rouges, niveau: 'mecanique', duree_s: 1800, ...x });
/** e1 → c1 ; e2 → c2 (après un commit de run) ; e3 → c3 (après un commit du banc seul). */
const depot: Depot = {
  commitDe: (e) => ({ e1: 'c1', e2: 'c2', e3: 'c3' } as Record<string, string>)[e],
  commitsEntre: (a, b) => ({ 'c1..c2': [{ commit: 'aaa fix(L1): le run rend son rapport', fichiers: ['v2/src/run/run.ts', 'v2/src/bench/cli.ts'] }],
    'c1..c3': [{ commit: 'bbb fix(L2): compte des tests d\'origine', fichiers: ['v2/src/bench/sans-juge.ts', 'v2/src/cli.ts'] }] } as Record<string, { commit: string; fichiers: string[] }[]>)[`${a}..${b}`] ?? [],
};
const sansRapport = () => null;

describe('après coup : la suite de l\'historique tranche', () => {
  it('rejoué vert sur la même empreinte : bruit', () => {
    const r = p('2026-11-27T07:01:00Z', 'e1', false, ['aucune fuite']);
    expect(classerPassage(r, [p('2026-11-27T07:36:00Z', 'e1', true)], depot, sansRapport)['aucune fuite']).toEqual({ classe: 'bruit', cause: 'rejoué vert sans changement (2026-11-27-0836)' });
  });
  it('vert après un commit de v2/ hors du banc : régression réelle, avec le commit ; après un commit du banc seul : bruit, banc corrigé', () => {
    const r = p('2026-11-26T16:27:00Z', 'e1', false, ['tests d\'origine verts']);
    expect(classerPassage(r, [p('2026-11-27T07:36:00Z', 'e2', true)], depot, sansRapport)['tests d\'origine verts'])
      .toEqual({ classe: 'régression réelle', cause: 'corrigée avant le vert du 2026-11-27-0836', commits: ['aaa fix(L1): le run rend son rapport'] });
    expect(classerPassage(r, [p('2026-11-27T07:36:00Z', 'e3', true)], depot, sansRapport)['tests d\'origine verts'].cause)
      .toBe('banc corrigé : vert le 2026-11-27-0836 après 1 commit(s) du banc seulement (v2/src/bench/, v2/src/sequence/, v2/src/cli.ts)');
  });
  it('le vert suivant est celui de la même famille ; sans lui, ou hors de main : non tranché', () => {
    const r = p('2026-11-26T10:21:00Z', 'e1', false, ['mutations tuées'], { niveau: undefined });
    expect(classerPassage(r, [p('2026-11-26T16:27:00Z', 'e2', true)], depot, sansRapport)['mutations tuées']).toEqual({ classe: 'non tranché', cause: 'aucun passage vert depuis (avec juges)' });
    expect(classerPassage(p('2026-11-26T10:21:00Z', 'eX', false, ['aucune fuite']), [p('2026-11-27T07:36:00Z', 'e2', true)], depot, sansRapport)['aucune fuite'].cause)
      .toBe('empreinte absente de l\'historique de main (eX)');
  });
  it('un temps rouge sous la charge (marqué à l\'historique, ou lu au rapport d\'avant L911) : bruit non mesurable, les autres rouges suivent la règle', () => {
    const r = p('2026-11-26T10:21:00Z', 'e1', false, ['temps des retouches', 'aucune fuite']);
    const lire = () => ({ charge: { coeurs: 32, depart: [5], fin: [38.74] } });
    const cl = classerPassage(r, [p('2026-11-26T16:27:00Z', 'e1', true)], depot, lire);
    expect(cl).toEqual({ 'temps des retouches': { classe: 'bruit', cause: 'non mesurable (charge 38,74 au-dessus de 16,00 (32 cœurs ÷ 2))' },
      'aucune fuite': { classe: 'bruit', cause: 'rejoué vert sans changement (2026-11-26-1727)' } });
    expect(classerPassage({ ...r, charge_haute: 'charge 23,58 au-dessus de 16,00' }, [], depot, sansRapport)['temps des retouches'].cause).toBe('non mesurable (charge 23,58 au-dessus de 16,00)');
  });
  it('un rouge tranché à la main (classements.json) passe avant la règle', () => {
    const r = p('2026-11-26T16:27:00Z', 'e1', false, ['aucune fuite']);
    expect(nomRapport(r)).toBe('2026-11-26-1727-e1');
    expect(tranche({ '2026-11-26-1727-e1': { '*': 'bruit : fuite du jeu de données' } }, r, 'aucune fuite')).toEqual({ classe: 'bruit', cause: 'tranché à la main : fuite du jeu de données' });
    expect(tranche({ '2026-11-26-1727-e1': { 'aucune fuite': 'peut-être' } }, r, 'aucune fuite')).toBeUndefined();
  });
});

describe('bench bilan : 4 semaines', () => {
  const MAINTENANT = new Date('2026-11-27T17:00:00Z');
  const tous = [
    p('2026-10-20T08:00:00Z', 'e1', false, ['temps total']), // hors fenêtre
    p('2026-11-26T16:27:00Z', 'e1', false, ['tests d\'origine verts']),
    p('2026-11-26T16:53:00Z', 'e1', false, ['tests d\'origine verts']),
    p('2026-11-27T07:01:00Z', 'e2', false, ['temps des retouches'], { charge_haute: 'charge 23,58 au-dessus de 16,00' }),
    p('2026-11-27T07:36:00Z', 'e2', true),
    { date: '2026-11-25T19:07:00Z', empreinte: 'e1', vert: false, rouges: ['aucune fuite'], type: 'sequence', sequence: 'aether-b68-court', run: '2026-11-25-1819-e1', repetition: 1 },
  ];
  it('comptes, heures, critères et ce que la suite seule aurait laissé passer', () => {
    const b = bilan(tous, [{ run: '2026-11-26-1059-e1-bruit', duree_s: 1314 }], { maintenant: MAINTENANT, semaines: 4, depot, lire: sansRapport, criteres: ['cohérence UI'] });
    expect(b.joues).toEqual({ mecanique: 4, 'séquence aether-b68-court': 1, 'bruit (A contre A)': 1 });
    expect(b.heures).toBeCloseTo((4 * 1800 + 108 * 60 + 1314) / 3600, 5); // séquence : de 18:19 à 20:07, heure de Paris
    const l = lignesBilan(b);
    expect(l[0]).toBe('Bilan du banc du 2026-10-30 au 2026-11-27 (L912, D-40)');
    expect(l).toContain('- bancs joués : 6 passages (mecanique 4, séquence aether-b68-court 1, bruit (A contre A) 1)');
    expect(l).toContain(`- heures de machine : ${b.heures.toFixed(1).replace('.', ',')} h`);
    expect(l).toContain('- régressions réelles attrapées : 1 (2 rouge(s) de critère, corrigés par un commit de v2/ hors du banc ; une par vert qui les clôt)');
    expect(l).toContain('- faux rouges (bruit) : 1 (non mesurable 1)');
    expect(l).toContain('- non tranchés : 1 (aucun passage vert depuis 1) ; passages non mesurables (charge) : 0');
    expect(l.find((x) => x.startsWith('- ce qu\'aurait laissé passer la suite de tests seule'))).toMatch(/: 1 régression\(s\)/);
    expect(l).toContain('| tests d\'origine verts | 2 | 2 | 0 | 0 |');
    expect(l).toContain('Critères sans régression réelle sur la fenêtre (à retirer ou fondre dans la porte s\'ils n\'attrapent rien en 4 semaines) : aucune fuite, cohérence UI, temps des retouches');
    expect(l).toContain('- 2026-11-26 17:27 mecanique e1 — tests d\'origine verts : régression réelle, corrigée avant le vert du 2026-11-27-0836 : aaa fix(L1): le run rend son rapport');
  });
  it('la commande lit la racine du banc (historique, rapports, classements.json) ; --semaines faux : code 2', async () => {
    const racine = dossierTemp('banc-l912-');
    mkdirSync(join(racine, 'rapports'));
    writeFileSync(join(racine, 'historique.jsonl'), `${tous.map((x) => JSON.stringify(x)).join('\n')}\nligne illisible\n`);
    writeFileSync(join(racine, 'rapports', '2026-11-26-1059-e1-bruit.md'), '# Banc\nDurée du passage : 1314 s\n');
    writeFileSync(join(racine, 'classements.json'), JSON.stringify({ '2026-11-26-1727-e1': { '*': 'bruit : jeu de données changé' } }));
    const io = ioTest({ BENCH_ROOT: racine }); io.now = () => MAINTENANT;
    expect(await bench(['--bilan'], io, dossierTemp('depot-vide-l912-'))).toBe(0);
    expect(io.sortie).toContain('- bancs joués : 6 passages (mecanique 4, séquence aether-b68-court 1, bruit (A contre A) 1)');
    expect(io.sortie.some((x) => x.includes('tests d\'origine verts : bruit, tranché à la main : jeu de données changé'))).toBe(true);
    const faux = ioTest({ BENCH_ROOT: racine });
    expect(await bench(['bilan', '--semaines', '0'], faux, '/d')).toBe(2);
    expect(faux.erreurs[0]).toMatch(/^usage : cadence2 bench bilan \[--semaines N\]/);
  });
});

describe('le dépôt réel : empreinte → commit, commits de v2/ entre deux', () => {
  it('même empreinte que celle du banc (cli.ts), et les fichiers de v2/ de chaque commit', () => {
    const d = dossierTemp('depot-l912-');
    const g = (...a: string[]) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    const ecrire = (f: string, x: string) => { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), x); };
    ecrire('v2/src/run/run.ts', 'a'); ecrire('v2/briefs/bras-A.md', 'b'); g('add', '.'); g('commit', '-qm', 'un');
    const [c1, e1] = [g('rev-parse', 'HEAD'), empreinte(d)];
    ecrire('README.md', 'hors v2'); g('add', '.'); g('commit', '-qm', 'hors mesure');
    ecrire('v2/src/run/run.ts', 'a2'); ecrire('v2/hooks/h.mjs', 'h'); g('add', '.'); g('commit', '-qm', 'fix(L1): run');
    const [c3, e3] = [g('rev-parse', 'HEAD'), empreinte(d)];
    const dep = depotGit(d);
    expect([dep.commitDe(e1), dep.commitDe(e3), dep.commitDe('inconnue')]).toEqual([c1, c3, undefined]);
    expect(dep.commitsEntre(c1, c3)).toEqual([{ commit: `${c3.slice(0, 7)} fix(L1): run`, fichiers: ['v2/hooks/h.mjs', 'v2/src/run/run.ts'] }]);
  });
});
