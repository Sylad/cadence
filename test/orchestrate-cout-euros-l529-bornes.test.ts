import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateLines, costView, launchPrices } from '../src/orchestrate/cout.js';
import { euros, stepEuros, sumEuros, waveEuros } from '../src/cost.js';
import { renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type StepState, type WaveState } from '../src/orchestrate/state.js';
import type { PriceGrid } from '../src/perf-config.js';
import { tempDir } from './helpers.js';

const GRID: PriceGrid = { sonnet: { input: 3, output: 15, cacheRead: 0.3 }, opus: { input: 15, output: 75, cacheRead: 1.5 } };
const wave: WaveState = { id: 'w1', created: '2026-11-02T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: [] };
const mk = (id: string, model: string, steps: unknown[] = [], budget?: number): LotState => {
  const l = newLot({ project: 'demo', repo: '/r', lot: id, title: 't', visible: false, small: false, model: model as never, readOnlyPlan: false });
  l.status = 'ready';
  l.steps = steps as StepState[];
  if (budget !== undefined) l.budget = budget;
  return l;
};
const st = (model: string, tokens?: unknown) => ({ n: 1, kind: 'implement', model, status: 'ok', started: '2026-11-02T10:00:00Z', ended: '2026-11-02T10:05:00Z', ...(tokens ? { tokens } : {}) });
const full = (input: number, output = 0) => ({ input, cacheWrite: 0, cacheRead: 0, output, counted: input + output });

describe('L529 bornes — estimation et coût', () => {
  it('zéro lot : l\'estimation donne 0,00 pour la vague, le tableau ne casse pas', () => {
    const lines = estimateLines([], tempDir(), () => {});
    // sans grille: vide ; avec grille: une ligne vague à 0
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    expect(lines).toEqual([]);
    expect(estimateLines([], dir, () => {})).toEqual([expect.stringContaining('estimation de la vague : 0,00')]);
    expect(renderTable(wave, [], { prices: GRID }).join('\n')).toContain('0,00');
  });

  it('deux lots sans prix : « n/d pour 2 lots » au pluriel', () => {
    const out = renderTable(wave, [mk('L1', 'haiku', [st('haiku', full(1e6))]), mk('L2', 'haiku', [st('haiku', full(1e6))])], { prices: GRID, lotCommits: () => [], isAncestor: () => false });
    expect(out.find((x) => x.startsWith('vague'))).toMatch(/n\/d pour 2 lots,/);
  });

  it('un lot dont la revue est sur un modèle sans prix : n/d pour tout le lot, pas un coût partiel', () => {
    const l = mk('L1', 'sonnet', [st('sonnet', full(1e6)), st('haiku', full(1e6))]);
    expect(costView([l], GRID).cells[0]).toEqual(['n/d']);
  });

  it('L578 — un lot fable chiffré au prix fable de la grille ; sans ce prix, n/d et le modèle est nommé au tableau et à l\'estimation', () => {
    const fable = { ...GRID, fable: { input: 5, output: 25, cacheRead: 0.5 } };
    const l = mk('L1', 'fable', [st('fable', full(1e6))]);
    expect(costView([l], fable).cells[0]).toEqual(['5,00']);
    const unpriced = costView([l, mk('L2', 'sonnet', [st('sonnet', full(1e6)), st('gpt', full(1))])], GRID);
    expect(unpriced.cells.map((c) => c[0])).toEqual(['n/d', 'n/d']);
    expect(unpriced.total).toContain('n/d pour 2 lots, modèle sans prix : fable, gpt');
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    const txt = estimateLines([mk('L1', 'fable', [], 1e6)], dir, () => {}).join('\n');
    expect(txt).toContain('n/d (fable sans prix dans perf.prices)');
    expect(txt).toContain('modèle sans prix : fable');
  });

  it('L578 — perf.currency : colonne, cellules, total et estimation portent la monnaie ; sans elle, en-tête « coût » et aucun symbole', () => {
    const l = mk('L1', 'sonnet', [st('sonnet', full(1e6))]);
    const usd = costView([l], GRID, '$');
    expect(usd.head).toEqual(['$']);
    expect(usd.cells[0]).toEqual(['3,00 $']);
    expect(usd.total).toBe(' — 3,00 $');
    expect(costView([l], GRID).head).toEqual(['coût']);
    expect(euros(3, 'USD')).toBe('3,00 USD');
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  currency: $\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    const txt = estimateLines([mk('L1', 'sonnet', [], 1e6)], dir, () => {}).join('\n');
    expect(txt).toMatch(/estimation du lot : 4,20 \$ /);
    expect(txt).toContain('estimation de la vague : 4,20 $');
    expect(launchPrices(dir, () => {})).toEqual({ sonnet: { input: 3, output: 15, cacheRead: 0.3 } });
  });

  it('estimation d\'un lot sans budget (absent) : pas de NaN ni d\'undefined', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    const txt = estimateLines([mk('L1', 'sonnet')], dir, () => {}).join('\n');
    expect(txt).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('estimation d\'un lot local : 0,00, pas « sans prix »', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    const txt = estimateLines([mk('L1', 'local', [], 500000)], dir, () => {}).join('\n');
    expect(txt).toContain('0,00');
    expect(txt).not.toContain('sans prix');
  });

  it('modèle absent de la grille : n/d nommé, pas d\'exception ; modèle illisible : « inconnu »', () => {
    expect(stepEuros({ model: 'gpt', counted: 10 }, GRID)).toEqual({ missing: 'gpt' });
    expect(sumEuros([{ model: 'gpt', counted: 10 }], GRID)).toBeNull();
    expect(stepEuros({ model: undefined as never, counted: 10 }, GRID)).toEqual({ missing: 'inconnu' });
    expect(stepEuros({ model: '' as never, counted: 10 }, GRID)).toEqual({ missing: 'inconnu' });
  });

  it('étape dont les jetons sont incomplets (cacheWrite absent, état ancien) : pas de NaN au tableau', () => {
    const l = mk('L1', 'sonnet', [st('sonnet', { input: 1e6, output: 0, counted: 1e6 })]);
    const out = renderTable(wave, [l], { prices: GRID, lotCommits: () => [], isAncestor: () => false }).join('\n');
    expect(out).not.toMatch(/NaN/);
  });

  it('jetons stockés en chaînes (état corrompu) : pas de concaténation absurde', () => {
    const l = mk('L1', 'sonnet', [st('sonnet', { input: '1000000', cacheWrite: '0', cacheRead: 0, output: 0, counted: 1e6 })]);
    const out = costView([l], GRID).cells[0]![0]!;
    expect(out).toBe('3,00');
  });

  it('une grille à prix nuls : 0,00 et non n/d', () => {
    const z: PriceGrid = { sonnet: { input: 0, output: 0, cacheRead: 0 } };
    expect(costView([mk('L1', 'sonnet', [st('sonnet', full(1e6))])], z).cells[0]).toEqual(['0,00']);
  });

  it('euros : arrondi et signe zéro', () => {
    expect(euros(0)).toBe('0,00');
    expect(euros(1234.5)).toBe('1234,50');
    expect(euros(-0)).toBe('0,00');
  });

  it('waveEuros : liste vide', () => {
    expect(waveEuros([])).toEqual({ total: 0, unknown: 0 });
  });

  it('la colonne de coût (monnaie « € ») est alignée avec un montant plus large que son en-tête', () => {
    const out = renderTable(wave, [mk('L1', 'sonnet', [st('sonnet', full(5e9))]), mk('L2', 'sonnet', [st('sonnet', full(1e6))])], { prices: GRID, lotCommits: () => [], isAncestor: () => false, currency: '€' });
    const col = out[0]!.indexOf('€');
    expect(col).toBeGreaterThan(0);
    // chaque ligne de lot a son montant se terminant avant la colonne « suites »
    const suites = out[0]!.indexOf('suites');
    for (const r of out.slice(1, 3)) expect(r.slice(0, suites)).toMatch(/\d €\s+$/);
  });
});

describe('L529 bornes — launchPrices', () => {
  const run = (yaml: string | null) => {
    const dir = tempDir();
    if (yaml !== null) writeFileSync(join(dir, 'cadence.yaml'), yaml);
    const w: string[] = [];
    return { grid: launchPrices(dir, (l) => w.push(l)), w };
  };
  it('fichier absent : null, sans avertissement', () => {
    expect(run(null)).toEqual({ grid: null, w: [] });
  });
  it('fichier vide : null, sans avertissement', () => {
    expect(run('')).toEqual({ grid: null, w: [] });
  });
  it('perf.prices vide : null, sans avertissement', () => {
    expect(run('perf:\n  prices: {}\n')).toEqual({ grid: null, w: [] });
  });
  it('YAML illisible : avertissement, pas d\'exception', () => {
    const r = run('perf: [unclosed\n  : :');
    expect(r.grid).toBeNull();
    expect(r.w).toHaveLength(1);
  });
  it('clé inconnue sous perf : avertissement', () => {
    const r = run('perf:\n  foo: 1\n');
    expect(r.grid).toBeNull();
    expect(r.w[0]).toMatch(/foo/);
  });
  it('cadence.yaml est un dossier : avertissement, pas d\'exception', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'cadence.yaml'));
    const w: string[] = [];
    expect(launchPrices(dir, (l) => w.push(l))).toBeNull();
    expect(w).toHaveLength(1);
  });
  it('prix en chaîne : avertissement', () => {
    const r = run('perf:\n  prices:\n    sonnet: { input: "3", output: 15, cacheRead: 0.3 }\n');
    expect(r.grid).toBeNull();
    expect(r.w).toHaveLength(1);
  });
});
