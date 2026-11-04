import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { euros, missingModels, stepEuros, sumEuros } from '../src/cost.js';
import { readPerfConfig, readPerfSettings, type PriceGrid } from '../src/perf-config.js';
import { costView, estimateLines, launchCost } from '../src/orchestrate/cout.js';
import { validateConfig } from '../src/config-set.js';
import { newLot, type LotState, type StepState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

const P = { input: 10, output: 20, cacheRead: 1 };
const GRID: PriceGrid = { fable: P, 'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.5 } };
const use = (input: number, output = 0) => ({ input, cacheWrite: 0, cacheRead: 0, output, counted: input + output });
const mk = (id: string, model: string, steps: unknown[] = [], budget?: number): LotState => {
  const l = newLot({ project: 'demo', repo: '/r', lot: id, title: 't', visible: false, small: false, model: model as never, readOnlyPlan: false });
  l.steps = steps as StepState[];
  if (budget !== undefined) l.budget = budget;
  return l;
};
const st = (model: string, tokens?: unknown) => ({ n: 1, kind: 'implement', model, status: 'ok', started: '2026-11-02T10:00:00Z', ended: '2026-11-02T10:05:00Z', ...(tokens ? { tokens } : {}) });
const yaml = (text: string): string => {
  const f = join(tempDir(), 'cadence.yaml');
  writeFileSync(f, text);
  return f;
};

describe('L578 bornes — stepEuros, nom de modèle quelconque', () => {
  it('noms hérités d\'Object (constructor, __proto__, toString) : sans prix, nommés, jamais un prix hérité', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(stepEuros({ model: name, usage: use(1e6) }, GRID)).toEqual({ missing: name });
    }
  });
  it('modèle vide, absent ou non texte : « inconnu »', () => {
    expect(stepEuros({ usage: use(1e6) }, GRID)).toEqual({ missing: 'inconnu' });
    expect(stepEuros({ model: '', usage: use(1e6) }, GRID)).toEqual({ missing: 'inconnu' });
    expect(stepEuros({ model: 42 as never, usage: use(1e6) }, GRID)).toEqual({ missing: 'inconnu' });
  });
  it('une grille qui porte la clé « inconnu » ne chiffre pas une étape sans modèle', () => {
    expect(stepEuros({ usage: use(1e6) }, { inconnu: P })).toEqual({ missing: 'inconnu' });
  });
  it('local reste gratuit même avec un prix « local » dans la grille', () => {
    expect(stepEuros({ model: 'local', usage: use(1e6) }, { local: P })).toBe(0);
  });
  it('modèle sans prix mais sans aucun compteur : 0, pas « manquant »', () => {
    expect(stepEuros({ model: 'mystere' }, GRID)).toBe(0);
    expect(missingModels([{ model: 'mystere' }], GRID)).toEqual([]);
  });
  it('la casse compte : Fable n\'est pas fable', () => {
    expect(stepEuros({ model: 'Fable', usage: use(1e6) }, GRID)).toEqual({ missing: 'Fable' });
  });
  it('fable et un nom long sont chiffrés à leur prix', () => {
    expect(stepEuros({ model: 'fable', usage: use(1e6, 1e6) }, GRID)).toBeCloseTo(30);
    expect(stepEuros({ model: 'claude-opus-4-7', usage: use(1e6) }, GRID)).toBeCloseTo(15);
  });
  it('compteur seul (counted) chiffré au prix du modèle libre : 90 % entrée, 10 % sortie', () => {
    expect(stepEuros({ model: 'fable', counted: 1e6 }, GRID)).toBeCloseTo(0.9 * 10 + 0.1 * 20);
  });
  it('sumEuros : une étape sans prix parmi des chiffrées → null', () => {
    expect(sumEuros([{ model: 'fable', usage: use(1e6) }, { model: 'zz', usage: use(1) }], GRID)).toBeNull();
    expect(sumEuros([], GRID)).toBe(0);
  });
});

describe('L578 bornes — missingModels', () => {
  it('liste vide, doublons, ordre d\'apparition', () => {
    expect(missingModels([], GRID)).toEqual([]);
    const s = [{ model: 'b', usage: use(1) }, { model: 'a', usage: use(1) }, { model: 'b', usage: use(1) }, { model: 'fable', usage: use(1) }];
    expect(missingModels(s, GRID)).toEqual(['b', 'a']);
  });
});

describe('L578 bornes — euros et monnaie', () => {
  it('sans monnaie : aucun symbole ni espace de queue', () => {
    expect(euros(4.8)).toBe('4,80');
    expect(euros(4.8, undefined)).toBe('4,80');
    expect(euros(0)).toBe('0,00');
  });
  it('avec monnaie : montant, espace, monnaie', () => {
    expect(euros(4.8, '$')).toBe('4,80 $');
    expect(euros(1234.567, 'USD')).toBe('1234,57 USD');
  });
  it('monnaie vide : comme absente', () => {
    expect(euros(4.8, '')).toBe('4,80');
  });
});

describe('L578 bornes — readPerfSettings', () => {
  it('currency seule, sans prices : grille nulle, monnaie gardée', () => {
    expect(readPerfSettings(yaml('perf:\n  currency: $\n'))).toEqual({ prices: null, currency: '$' });
  });
  it('perf: vide (null) et fichier absent : pas de grille, pas d\'erreur', () => {
    expect(readPerfSettings(yaml('perf:\n'))).toEqual({ prices: null });
    expect(readPerfSettings(join(tempDir(), 'absent.yaml'))).toEqual({ prices: null });
  });
  it('currency: null explicite : comme absente', () => {
    expect(readPerfSettings(yaml('perf:\n  currency: null\n  prices: {}\n'))).toEqual({ prices: null });
  });
  it('currency non texte (nombre, liste, booléen) : refusée, nommée', () => {
    for (const v of ['5', '[a]', 'true', '{a: 1}']) {
      expect(() => readPerfSettings(yaml(`perf:\n  currency: ${v}\n`))).toThrow(/perf\.currency : texte non vide attendu/);
    }
  });
  it('currency d\'espaces seuls : refusée', () => {
    expect(() => readPerfSettings(yaml('perf:\n  currency: "   "\n'))).toThrow(/perf\.currency/);
  });
  it('perf sous forme de liste ou de texte : refusé', () => {
    expect(() => readPerfSettings(yaml('perf: []\n'))).toThrow(/perf doit être un objet/);
    expect(() => readPerfSettings(yaml('perf: oui\n'))).toThrow(/perf doit être un objet/);
  });
  it('clé inconnue sous perf (faute de frappe curency) : refusée, nommée', () => {
    expect(() => readPerfSettings(yaml('perf:\n  curency: $\n'))).toThrow(/perf\.curency inconnu/);
  });
  it('prices sous forme de liste : refusé', () => {
    expect(() => readPerfSettings(yaml('perf:\n  prices: [a]\n'))).toThrow(/perf\.prices doit être un objet/);
  });
  it('prix d\'un modèle : liste, null, texte → refusé et nommé', () => {
    for (const v of ['[1]', 'null', 'cher']) {
      expect(() => readPerfSettings(yaml(`perf:\n  prices:\n    fable: ${v}\n`))).toThrow(/perf\.prices\.fable doit être un objet/);
    }
  });
  it('compteur en texte, négatif, infini, NaN : refusé', () => {
    for (const v of ['"3"', '-1', '.inf', '.nan', 'null', 'true']) {
      expect(() => readPerfSettings(yaml(`perf:\n  prices:\n    fable: { input: ${v}, output: 1, cacheRead: 1 }\n`))).toThrow(/perf\.prices\.fable\.input : nombre ≥ 0 attendu/);
    }
  });
  it('prix à zéro accepté (modèle gratuit)', () => {
    expect(readPerfConfig(yaml('perf:\n  prices:\n    fable: { input: 0, output: 0, cacheRead: 0 }\n'))).toEqual({ fable: { input: 0, output: 0, cacheRead: 0 } });
  });
  it('clé de prix inconnue (cacheWrite) : refusée', () => {
    expect(() => readPerfSettings(yaml('perf:\n  prices:\n    fable: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }\n'))).toThrow(/perf\.prices\.fable\.cacheWrite inconnu/);
  });
  it('nom de modèle numérique ou avec @ / points : accepté, lu comme texte', () => {
    const g = readPerfConfig(yaml('perf:\n  prices:\n    4: { input: 1, output: 1, cacheRead: 1 }\n    "gpt-5.1@x": { input: 2, output: 2, cacheRead: 2 }\n'));
    expect(Object.keys(g ?? {}).sort()).toEqual(['4', 'gpt-5.1@x']);
  });
  it('nom de modèle « __proto__ » : une clé propre, sans toucher le prototype', () => {
    const g = readPerfConfig(yaml('perf:\n  prices:\n    "__proto__": { input: 1, output: 1, cacheRead: 1 }\n'));
    expect(g).not.toBeNull();
    expect(Object.hasOwn(g!, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).input).toBeUndefined();
  });
  it('modèle dupliqué dans le YAML : refusé (RafError ou erreur de parse), pas silencieux', () => {
    expect(() => readPerfSettings(yaml('perf:\n  prices:\n    fable: { input: 1, output: 1, cacheRead: 1 }\n    fable: { input: 9, output: 9, cacheRead: 9 }\n'))).toThrow();
  });
  it('validateConfig (cadence config set) refuse une monnaie invalide', () => {
    const f = yaml('perf:\n  currency: 5\n');
    expect(() => validateConfig(f, tempDir())).toThrow(/perf\.currency/);
  });
});

describe('L578 bornes — orchestrate cout', () => {
  it('launchCost : grille mal formée → warn « coût n/d », grille nulle, monnaie perdue', () => {
    const d = tempDir();
    writeFileSync(join(d, 'cadence.yaml'), 'perf:\n  currency: $\n  prices:\n    fable: { input: x }\n');
    const w: string[] = [];
    expect(launchCost(d, (l) => w.push(l))).toEqual({ prices: null });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^coût n\/d : /);
  });
  it('launchCost : pas de cadence.yaml → grille nulle sans avertissement', () => {
    const w: string[] = [];
    expect(launchCost(tempDir(), (l) => w.push(l))).toEqual({ prices: null });
    expect(w).toEqual([]);
  });
  it('costView sans monnaie : en-tête « coût », cellules sans symbole', () => {
    const v = costView([mk('L1', 'fable', [st('fable', use(1e6))])], GRID);
    expect(v.head).toEqual(['coût']);
    expect(v.cells).toEqual([['10,00']]);
    expect(v.total).toBe(' — 10,00');
  });
  it('costView avec monnaie $ : en-tête $ et montants suffixés', () => {
    const v = costView([mk('L1', 'fable', [st('fable', use(1e6))])], GRID, '$');
    expect(v.head).toEqual(['$']);
    expect(v.cells).toEqual([['10,00 $']]);
  });
  it('costView : le total nomme chaque modèle sans prix une seule fois, sur plusieurs lots', () => {
    const lots = [mk('L1', 'zz', [st('zz', use(1)), st('yy', use(1))]), mk('L2', 'zz', [st('zz', use(1))]), mk('L3', 'fable', [st('fable', use(1e6))])];
    const v = costView(lots, GRID);
    expect(v.cells.map((c) => c[0])).toEqual(['n/d', 'n/d', '10,00']);
    expect(v.total).toContain('n/d pour 2 lots, modèle sans prix : zz, yy');
    expect(v.total.match(/zz/g)).toHaveLength(1);
  });
  it('costView : un lot sans étape vaut 0 et ne nomme rien', () => {
    const v = costView([mk('L1', 'fable', [])], GRID);
    expect(v.cells).toEqual([['0,00']]);
    expect(v.total).not.toContain('n/d');
  });
  it('costView : étape sans modèle lisible → « inconnu » nommé', () => {
    const l = mk('L1', 'fable', [{ n: 1, kind: 'implement', status: 'ok', started: 'x', ended: 'y', tokens: use(1) }]);
    expect(costView([l], GRID).total).toContain('modèle sans prix : inconnu');
  });
  it('costView : une grille nulle donne une vue vide, monnaie ignorée', () => {
    expect(costView([mk('L1', 'fable')], null, '$')).toEqual({ head: [], cells: [[]], total: '' });
  });
  it('estimateLines : lot fable chiffré, monnaie derrière chaque montant, modèles sans prix nommés une fois', () => {
    const d = tempDir();
    writeFileSync(join(d, 'cadence.yaml'), 'perf:\n  currency: USD\n  prices:\n    fable: { input: 10, output: 20, cacheRead: 1 }\n');
    const lots = [mk('L1', 'fable', [], 1_000_000), mk('L2', 'zz', [], 10), mk('L3', 'zz', [], 10)];
    const out = estimateLines(lots, d, () => {});
    expect(out[0]).toMatch(/11,00 USD/);
    expect(out[1]).toContain('n/d (zz sans prix dans perf.prices)');
    const wave = out[out.length - 1]!;
    expect(wave).toContain('11,00 USD');
    expect(wave).toContain('n/d pour 2 lots, modèle sans prix : zz');
    expect(wave.match(/zz/g)).toHaveLength(1);
  });
  it('estimateLines : budget absent (0) et modèle de grille → 0,00', () => {
    const d = tempDir();
    writeFileSync(join(d, 'cadence.yaml'), 'perf:\n  prices:\n    fable: { input: 10, output: 20, cacheRead: 1 }\n');
    const out = estimateLines([mk('L1', 'fable')], d, () => {});
    expect(out[0]).toContain('0,00 (budget de 0 tokens');
    expect(out[0]).not.toContain('€');
  });
});

describe('L578 bornes — monnaie vide passée directement', () => {
  it('costView avec monnaie vide : l\'en-tête retombe sur « coût », pas une colonne sans titre', () => {
    const v = costView([mk('L1', 'fable', [st('fable', use(1e6))])], GRID, '');
    expect(v.head).toEqual(['coût']);
  });
});
