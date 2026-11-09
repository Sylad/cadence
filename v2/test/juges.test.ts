import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { anonymiser, avisLu, combiner, etatGit, juger, travailNonLivre, validerAveugle, validerMeca } from '../src/bench/juges.js';

const meca = { suite_ok: true, caches_passes: 2, caches_total: 2, mutations_tuees: 5, mutations_total: 6, attendu: 'oui', mutations: [] };
const aveugle = { X: { bloquants: 0, majeurs: 1, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 2 }, prefere: 'Y', ui: 'na', raisons: 'r' };
const aveugle2 = { X: aveugle.Y, Y: aveugle.X, prefere: 'X', ui: 'na', raisons: 'r2' }; // R39 : le même avis, ordre permuté

function decor(): { b: Banc; clones: Record<string, string>; dirEval: string } {
  const r = mkdtempSync(join(tmpdir(), 'juges-'));
  const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'd');
  const secrets = join(r, 'secrets', '1-t'); mkdirSync(secrets, { recursive: true }); writeFileSync(join(secrets, 'mesure.md'), 'm');
  const clones: Record<string, string> = {};
  // Un seul dépôt, cloné pour le second bras : la base est le même commit des deux côtés (deux commits faits à des secondes
  // différentes auraient deux sha, et `git diff base..HEAD` échouerait dans l'un d'eux).
  clones.A = join(r, 'runs', 'A'); mkdirSync(clones.A, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: clones.A });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: clones.A });
  clones.cand = join(r, 'runs', 'cand');
  execFileSync('git', ['clone', '-q', clones.A, clones.cand]);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clones.A, encoding: 'utf8' }).trim();
  return { b: { id: '1-t', dir, secrets, projet: 't', source: '/s', base, install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: false },
    clones, dirEval: join(r, 'runs', 'eval') };
}
/** Faux claude : écrit dans le fichier SORTIE du brief les JSON donnés, un par appel. */
function fauxJuge(sorties: object[], vus: string[][] = [], dirEvalVu = ''): Executeur {
  let i = 0;
  return (args, o) => {
    vus.push(args);
    expect(o.env.KUBECONFIG).toBe('/nonexistent');
    const p = args[args.indexOf('-p') + 1];
    if (i === 0 && dirEvalVu) { expect(existsSync(join(dirEvalVu, 'X', '.git'))).toBe(false); expect(existsSync(join(dirEvalVu, 'X.patch'))).toBe(true); }
    const m = /dans (\S+\.json)/.exec(p);
    writeFileSync(m![1], JSON.stringify(sorties[i++] ?? {}));
    return { stdout: JSON.stringify({ session_id: `j${i}`, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
}

describe('juges', () => {
  it('anonymise selon le tirage', () => {
    expect(anonymiser(['A', 'cand'], () => 0.2)).toEqual({ X: 'A', Y: 'cand' });
    expect(anonymiser(['A', 'cand'], () => 0.8)).toEqual({ X: 'cand', Y: 'A' });
  });
  it('valide les JSON des juges', () => {
    expect(validerMeca({ X: meca, Y: meca, remplaces: [] })).toEqual([]);
    expect(validerMeca({ X: meca, remplaces: [] })).toEqual(['Y manquant']);
    expect(validerMeca({ X: { ...meca, caches_passes: 3 }, Y: meca, remplaces: [] })).toEqual(['X.caches_passes > caches_total']);
    expect(validerMeca({ X: meca, Y: meca, remplaces: ['a.spec.ts > t'] })).toEqual([]);
    expect(validerMeca({ X: meca, Y: meca })).toEqual(["remplaces n'est pas une liste de textes"]);
    expect(validerMeca({ X: meca, Y: meca, remplaces: [3] })).toEqual(["remplaces n'est pas une liste de textes"]);
    expect(validerAveugle(aveugle)).toEqual([]);
    expect(validerAveugle({ ...aveugle, prefere: 'Z' })).toEqual(['prefere doit valoir X, Y ou egal']);
  });
  it('R35, M2 (R38) : sorties rendues par index {i, verdict, preuve}, i = 1..n exactement, dans l\'ordre, sans doublon ; ignorées sans sortie déclarée', () => {
    const at = [{ k: 1, sortie: 'a' }, { k: 2, sortie: 'b' }];
    const so = [{ i: 1, verdict: 'oui', preuve: 'capture X-1.png' }, { i: 2, verdict: 'incertain', preuve: 'curl /api : 500' }];
    const avec = (x: unknown, y: unknown = so) => validerMeca({ X: { ...meca, sorties: x }, Y: { ...meca, sorties: y }, remplaces: [] }, at);
    expect(avec(so)).toEqual([]);
    expect(validerMeca({ X: meca, Y: meca, remplaces: [] })).toEqual([]); // banc ou séquence sans sorties : inchangé
    expect(avec(undefined)).toEqual(['X.sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [] (manquants : 1, 2)']);
    expect(avec(so.slice(0, 1))).toEqual(['X.sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [1] (manquants : 2)']);
    expect(avec([so[1], so[0]])).toEqual(['X.sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [2, 1]']);
    expect(avec([so[0], so[0]])).toEqual(['X.sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [1, 1] (manquants : 2)']);
    expect(avec([{ ...so[0], i: '1' }, so[1]])).toHaveLength(1); // i texte : refusé
    expect(avec([...so, { i: 3, verdict: 'oui', preuve: 'p' }])).toEqual(['X.sorties : i attendus [1, 2] dans l\'ordre, sans doublon ; reçus [1, 2, 3]']);
    expect(avec(so, [{ ...so[0], verdict: 'peut-être' }, { ...so[1], preuve: ' ' }])).toEqual(['Y.sorties[i=1].verdict doit valoir oui, non ou incertain', 'Y.sorties[i=2].preuve vide']);
    // le texte n'a pas à être recopié : une reformulation ne coûte plus le jugement
    expect(avec(so.map((x) => ({ ...x, k: 9, sortie: 'reformulée' })))).toEqual([]);
  });
  it('R35, M1, M2, m2 : sorties vérifiées d\'abord sur les copies intactes (avant mutations), captures à part ; le code rattache k et texte ; X/Y écrits', () => {
    const { b, clones, dirEval } = decor();
    const at = [{ k: 1, sortie: 'légende en D/A' }, { k: 3, sortie: 'cartouche à 3 h' }];
    const so = [{ i: 1, verdict: 'non', preuve: 'captures-sorties-X/legende.png : L/H', sortie: 'recopie fausse' }, { i: 2, verdict: 'oui', preuve: 'p' }];
    const vus: string[][] = [];
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: { ...meca, sorties: so }, Y: { ...meca, sorties: so }, remplaces: [] }, aveugle, aveugle2], vus), () => 0.2, '', at);
    expect(j!.meca.A.sorties).toEqual([{ i: 1, k: 1, sortie: 'légende en D/A', verdict: 'non', preuve: 'captures-sorties-X/legende.png : L/H' }, { i: 2, k: 3, sortie: 'cartouche à 3 h', verdict: 'oui', preuve: 'p' }]);
    expect(j!.anonymat).toEqual({ X: 'A', Y: 'cand' }); // m2 : preuves captures-X/... vérifiables
    const p = vus[0][vus[0].indexOf('-p') + 1];
    for (const t of ['S1 (i=1). étape 1 : légende en D/A', 'S2 (i=2). étape 3 : cartouche à 3 h', 'application réelle', 'état final', '"sorties"', '"i"', 'captures-sorties-X']) expect(p).toContain(t);
    expect(p.indexOf('sorties attendues, cachées')).toBeLessThan(p.indexOf('Mutations')); // M1 : avant toute mutation
    expect(p).not.toMatch(/captures-X\b/); // m2 : jamais les dossiers du juge aveugle
    expect(p).not.toContain('{{');
    const sans: string[][] = [];
    juger(b, clones, dirEval, 'opus', fauxJuge([{ X: meca, Y: meca, remplaces: [] }, aveugle, aveugle2], sans), () => 0.2);
    expect(sans[0][sans[0].indexOf('-p') + 1]).not.toMatch(/application réelle|\{\{/);
  });
  it('désanonymise le jugement (X = A, Y = cand), garde-fous prod sur les sessions', () => {
    const { b, clones, dirEval } = decor();
    const vus: string[][] = [];
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: meca, Y: { ...meca, caches_passes: 1 }, remplaces: ['o.spec.ts > t'] }, aveugle, aveugle2], vus, dirEval), () => 0.2);
    expect(j!.meca.cand.caches_passes).toBe(1);
    expect(j!.remplaces).toEqual(['o.spec.ts > t']); // une seule liste, pour les deux bras
    expect(j!.defauts.A.majeurs).toBe(1);
    expect(j!.prefere).toBe('cand');
    expect(readFileSync(join(dirEval, 'demande.md'), 'utf8')).toBe('d');
    expect(vus.every((a) => a[a.indexOf('--disallowedTools') + 1].includes('Bash(kubectl:*)'))).toBe(true);
  });
  it('JSON invalide deux fois : banc non jugé (null), jamais un vert par défaut', () => {
    const { b, clones, dirEval } = decor();
    expect(juger(b, clones, dirEval, 'opus', fauxJuge([{}, {}]), () => 0.2)).toBeNull();
    for (const k of ['X', 'Y']) expect(existsSync(join(dirEval, k)), `copie ${k} restée`).toBe(false);
  });
  it('sortie claude illisible ou code non nul : null, sans exception (R7)', () => {
    const { b, clones, dirEval } = decor();
    expect(juger(b, clones, dirEval, 'opus', () => ({ stdout: 'boum', code: 1 }), () => 0.2)).toBeNull();
    const erreur: Executeur = () => ({ stdout: JSON.stringify({ session_id: 's', is_error: true }), code: 0 });
    expect(juger(b, clones, dirEval, 'opus', erreur, () => 0.2)).toBeNull();
  });
  it('clone qui n\'est pas un dépôt git : null, sans exception', () => {
    const { b, clones, dirEval } = decor();
    clones.cand = mkdtempSync(join(tmpdir(), 'pasgit-'));
    expect(juger(b, clones, dirEval, 'opus', fauxJuge([]), () => 0.2)).toBeNull();
    for (const k of ['X', 'Y']) expect(existsSync(join(dirEval, k)), `copie ${k} restée`).toBe(false);
  });
  it('le juge aveugle voit des copies fraîches, sans les mutations du mécanique', () => {
    const { b, clones, dirEval } = decor();
    let n = 0;
    const exec: Executeur = (args) => {
      const m = /dans (\S+\.json)/.exec(args[args.indexOf('-p') + 1])!;
      if (n++ === 0) { writeFileSync(join(dirEval, 'X', 'MUTATION'), 'm'); writeFileSync(m[1], JSON.stringify({ X: meca, Y: meca, remplaces: [] })); }
      else { expect(existsSync(join(dirEval, 'X', 'MUTATION'))).toBe(false); writeFileSync(m[1], JSON.stringify(n === 2 ? aveugle : aveugle2)); }
      return { stdout: JSON.stringify({ session_id: `s${n}` }), code: 0 };
    };
    expect(juger(b, clones, dirEval, 'opus', exec, () => 0.2)).not.toBeNull();
    expect(n).toBe(3); // mécanique, puis aveugle dans les deux ordres (R39)
  });
  it('tirage 0.8 : X = cand, Y = A', () => {
    const { b, clones, dirEval } = decor();
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: { ...meca, caches_passes: 1 }, Y: meca, remplaces: [] }, aveugle, aveugle2]), () => 0.8);
    expect(j!.meca.cand.caches_passes).toBe(1);
    expect(j!.remplaces).toEqual([]);
    expect(j!.meca.A.caches_passes).toBe(2);
    expect(j!.defauts.cand.majeurs).toBe(1);
    expect(j!.defauts.A.mineurs).toBe(2);
    expect(j!.prefere).toBe('A');
  });
  it('premier JSON invalide, relance valide : accepté', () => {
    const { b, clones, dirEval } = decor();
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{}, { X: meca, Y: meca, remplaces: [] }, aveugle, aveugle2]), () => 0.2);
    expect(j).not.toBeNull();
    expect(j!.prefere).toBe('cand');
  });
});

/** R39 : faux juge qui lit quel bras est en X (fichier bras.txt de la copie) et rend son avis selon l'ordre. */
function jugeSelonOrdre(avis: (enX: string, passage: number) => object | null, vus: string[] = []): Executeur {
  let i = 0;
  return (args) => {
    const p = args[args.indexOf('-p') + 1], f = /dans (\S+\.json)/.exec(p)![1]; vus.push(p);
    const r = i++ === 0 ? { X: meca, Y: meca, remplaces: [] } : avis(readFileSync(join(dirname(f), 'X', 'bras.txt'), 'utf8'), i - 1);
    writeFileSync(f, JSON.stringify(r ?? {}));
    return { stdout: JSON.stringify({ session_id: `s${i}` }), code: 0 };
  };
}
const d = (bloquants: number, majeurs: number, mineurs: number) => ({ bloquants, majeurs, mineurs });
function decorMarque() {
  const x = decor();
  for (const [n, c] of Object.entries(x.clones)) writeFileSync(join(c, 'bras.txt'), n);
  return x;
}

describe('R39 : juge aveugle joué deux fois, ordre X/Y permuté', () => {
  it('avis cohérent dans les deux ordres : gardé, ramené au bras ; les deux passages et leurs raisons gardés', () => {
    const { b, clones, dirEval } = decorMarque();
    const vus: string[] = [];
    const j = juger(b, clones, dirEval, 'opus', jugeSelonOrdre((enX) => ({ X: d(0, 0, 0), Y: d(0, 0, 0), prefere: enX === 'cand' ? 'X' : 'Y', ui: enX === 'cand' ? 'X' : 'Y', raisons: `vu ${enX} en X` }), vus), () => 0.2)!;
    expect([j.prefere, j.ui]).toEqual(['cand', 'cand']);
    expect(j.anonymat).toEqual({ X: 'A', Y: 'cand' });
    expect(j.aveugle_ordres!.map((o) => [o.anonymat, o.prefere])).toEqual([[{ X: 'A', Y: 'cand' }, 'cand'], [{ X: 'cand', Y: 'A' }, 'cand']]);
    expect(j.raisons).toContain('vu A en X'); expect(j.raisons).toContain('vu cand en X');
    expect(vus).toHaveLength(3);
    expect(vus[2]).toContain(join(dirEval, 'aveugle-2.json'));
    expect(existsSync(join(dirEval, 'aveugle.json')) && existsSync(join(dirEval, 'aveugle-2.json'))).toBe(true);
    expect(avisLu(j, 'prefere')).toBe('cand');
  });
  it('biais de position (X toujours préféré) : indécis ; ui na dans les deux ordres reste na', () => {
    const { b, clones, dirEval } = decorMarque();
    const j = juger(b, clones, dirEval, 'opus', jugeSelonOrdre(() => ({ X: d(0, 0, 0), Y: d(0, 0, 0), prefere: 'X', ui: 'na', raisons: 'r' })), () => 0.2)!;
    expect([j.prefere, j.ui]).toEqual(['indécis', 'na']);
    expect(avisLu(j, 'prefere')).toBe('indécis (A dans un ordre, cand dans l\'autre)');
  });
  it('défauts finaux par bras : max champ par champ des deux passages', () => {
    const { b, clones, dirEval } = decorMarque();
    // passage 1 : X = A ; passage 2 : X = cand
    const avis = (enX: string, k: number) => (k === 1 ? { X: d(0, 1, 0), Y: d(0, 0, 2), prefere: 'egal', ui: 'na', raisons: 'r' } : { X: d(0, 0, 3), Y: d(1, 0, 0), prefere: 'egal', ui: 'na', raisons: 'r' });
    const j = juger(b, clones, dirEval, 'opus', jugeSelonOrdre(avis), () => 0.2)!;
    expect(j.defauts).toEqual({ A: d(1, 1, 0), cand: d(0, 0, 3) });
    expect(j.prefere).toBe('egal');
  });
  it('un des deux passages invalide après relance : jugement null (échec fermé)', () => {
    for (const rate of [1, 2]) {
      const { b, clones, dirEval } = decorMarque();
      const vus: string[] = [];
      const j = juger(b, clones, dirEval, 'opus', jugeSelonOrdre((_, k) => (k >= rate && k <= rate + 1 ? null : { X: d(0, 0, 0), Y: d(0, 0, 0), prefere: 'X', ui: 'na', raisons: 'r' }), vus), () => 0.2);
      expect(j).toBeNull();
      expect(vus).toHaveLength(rate === 1 ? 3 : 4); // passage 1 raté (et relance) : pas de second passage
      for (const k of ['X', 'Y']) expect(existsSync(join(dirEval, k)), `copie ${k} restée`).toBe(false);
    }
  });
  it('combiner : prefere egal dans un ordre et un bras dans l\'autre : indécis ; na contre X : indécis', () => {
    const o = (X: string, prefere: string, ui: string) => ({ X: d(0, 0, 0), Y: d(0, 0, 0), prefere, ui, raisons: '', anonymat: { X, Y: X === 'A' ? 'C' : 'A' } });
    expect(combiner([o('A', 'egal', 'na'), o('C', 'Y', 'X')])).toMatchObject({ prefere: 'indécis', ui: 'indécis' });
    expect(combiner([o('A', 'X', 'egal'), o('C', 'Y', 'egal')])).toMatchObject({ prefere: 'A', ui: 'egal' });
  });
});

describe('travailNonLivre : captures du serveur MCP Playwright (S7, 2e occurrence)', () => {
  it('.playwright-mcp/ laissé dans le clone n\'est pas du travail non commité ; un vrai fichier oublié, si', () => {
    const d = mkdtempSync(join(tmpdir(), 'pw-')), g = (...a: string[]) => execFileSync('git', a, { cwd: d });
    g('init', '-q'); writeFileSync(join(d, 'a.ts'), '1'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const avant = etatGit(d);
    writeFileSync(join(d, 'a.ts'), '2'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'travail');
    mkdirSync(join(d, '.playwright-mcp')); writeFileSync(join(d, '.playwright-mcp', '01-legende.png'), 'png');
    expect(travailNonLivre(avant, etatGit(d))).toBeNull();
    writeFileSync(join(d, 'oublie.ts'), 'x');
    expect(travailNonLivre(avant, etatGit(d))).toBe('travail non commité');
  });
});
