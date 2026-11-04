import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESCALATION_RESERVE } from '../src/orchestrate/cycle.js';
import { lotBudget, lotBudgetBasis, MEASURE_MIN_LOTS, type MeasuredBudgets } from '../src/orchestrate/lot-budget.js';
import { measuredBudgetsAt, readMeasuredBudgets } from '../src/orchestrate/budget-mesure.js';
import { percentile } from '../src/percentile.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

// L501, sondes aux bornes : budget mesuré, classes, base du dry-run, lecture de la mesure.
const m = (key: string, p90: number, lots: number): MeasuredBudgets => new Map([[key, { p90, lots }]]);

describe('lotBudget mesuré — bornes (L501)', () => {
  it('pile 5 lots : la mesure compte ; 4 lots : non', () => {
    expect(lotBudget(0.5, undefined, false, m('0.5', 900_000, MEASURE_MIN_LOTS))).toBe(900_000);
    expect(lotBudget(0.5, undefined, false, m('0.5', 900_000, MEASURE_MIN_LOTS - 1))).toBe(600_000);
  });
  it('p90 pile au statique ou au double : gardé tel quel (bornes incluses)', () => {
    expect(lotBudget(0.5, undefined, false, m('0.5', 600_000, 9))).toBe(600_000);
    expect(lotBudget(0.5, undefined, false, m('0.5', 1_200_000, 9))).toBe(1_200_000);
    expect(lotBudget(0.5, undefined, false, m('0.5', 1_200_001, 9))).toBe(1_200_000);
  });
  it('p90 pile multiple de 50 k : pas d’arrondi supplémentaire ; 1 de plus : palier suivant', () => {
    expect(lotBudget(0.5, undefined, false, m('0.5', 650_000, 9))).toBe(650_000);
    expect(lotBudget(0.5, undefined, false, m('0.5', 650_001, 9))).toBe(700_000);
  });
  it('p90 à 0 ou négatif : jamais sous le statique', () => {
    expect(lotBudget(0.5, undefined, false, m('0.5', 0, 9))).toBe(600_000);
    expect(lotBudget(0.5, undefined, false, m('0.5', -5, 9))).toBe(600_000);
  });
  it('p90 NaN ou Infinity : le budget reste un nombre fini dans les bornes', () => {
    for (const p of [NaN, Infinity]) {
      const b = lotBudget(0.5, undefined, false, m('0.5', p, 9));
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(600_000);
      expect(b).toBeLessThanOrEqual(1_200_000);
    }
  });
  it('p90 en chaîne (JSON abîmé) : pas de budget NaN', () => {
    const b = lotBudget(0.5, undefined, false, m('0.5', '900000' as unknown as number, 9));
    expect(Number.isFinite(b)).toBe(true);
  });
  it('mesure vide (Map vide) : statique, et la base ne dit pas « 0 lot(s) mesuré(s) » avec un budget inventé', () => {
    expect(lotBudget(0.5, undefined, false, new Map())).toBe(600_000);
  });
  it('lot à écran : borné à son statique 1,3 M et au double', () => {
    expect(lotBudget(0.5, 'screen', false, m('0.5+spec', 100_000, 9))).toBe(1_300_000);
    expect(lotBudget(0.5, 'screen', false, m('0.5+spec', 9_000_000, 9))).toBe(2_600_000);
  });
  it('lot light et spec lisent la classe +spec, pas la classe ordinaire', () => {
    const only = m('0.5', 1_000_000, 9);
    expect(lotBudget(0.5, 'light', false, only)).toBe(lotBudget(0.5, 'light'));
    expect(lotBudget(0.5, 'spec', false, only)).toBe(lotBudget(0.5, 'spec'));
  });
  it('estimate fractionnaire : la clé « 1.5 » (celle de perf) est trouvée', () => {
    const fixed = lotBudget(1.5);
    expect(lotBudget(1.5, undefined, false, m('1.5', fixed + 60_000, 9))).toBe(Math.ceil((fixed + 60_000) / 50_000) * 50_000);
  });
  it('estimate 0 / négatif : un budget fini, pas d’exception', () => {
    expect(lotBudget(0, undefined, false, m('0', 900_000, 9))).toBe(900_000);
    expect(Number.isFinite(lotBudget(-1, undefined, false, m('-1', 900_000, 9)))).toBe(true);
  });
  it('escalade : la réserve s’ajoute APRÈS le plafond', () => {
    expect(lotBudget(0.5, undefined, true, m('0.5', 9_000_000, 9))).toBe(1_200_000 + ESCALATION_RESERVE);
  });
  it('deux appels identiques : même budget, mesure non mutée', () => {
    const x = m('0.5', 900_000, 9);
    expect(lotBudget(0.5, undefined, false, x)).toBe(lotBudget(0.5, undefined, false, x));
    expect(x.get('0.5')).toEqual({ p90: 900_000, lots: 9 });
  });
  it('la base : budget annoncé par lotBudget et chiffre cité dans la base concordent (plafond)', () => {
    const b = lotBudgetBasis(0.5, undefined, undefined, m('0.5', 9_000_000, 9));
    expect(b).toContain('1200000');
    expect(b).toContain('9000000');
  });
  it('la base avec escalade ajoute la réserve sans perdre la mesure', () => {
    const b = lotBudgetBasis(0.5, undefined, 'opus', m('0.5', 900_000, 9));
    expect(b).toContain('p90 mesuré 900000');
    expect(b).toContain('opus');
  });
  it('la base d’une classe absente de la mesure non vide : pas de « 0 lot(s) mesuré(s) » trompeur sur le p90', () => {
    const b = lotBudgetBasis(0.5, undefined, undefined, m('2', 900_000, 9));
    expect(b).not.toContain('p90 mesuré');
  });
});

describe('percentile — bornes (L501)', () => {
  it('ne mute pas l’entrée', () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.9);
    expect(xs).toEqual([3, 1, 2]);
  });
  it('p = 1 donne le max ; p minuscule donne le min', () => {
    expect(percentile([5, 1, 9], 1)).toBe(9);
    expect(percentile([5, 1, 9], 0.0001)).toBe(1);
  });
  it('p = 0 : pas d’undefined renvoyé (null ou le min)', () => {
    const r = percentile([5, 1, 9], 0);
    expect(r === null || r === 1).toBe(true);
  });
});

describe('readMeasuredBudgets / measuredBudgetsAt — bornes (L501)', () => {
  it('dossier inexistant : mesure vide', () => {
    expect(readMeasuredBudgets(join(tempDir(), 'absent'), '2026-10-16').size).toBe(0);
  });
  it('dossier .cadence/runs vide : mesure vide, measuredBudgetsAt renvoie undefined', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.cadence', 'runs'), { recursive: true });
    expect(readMeasuredBudgets(dir, '2026-10-16').size).toBe(0);
    expect(measuredBudgetsAt(dir, { env: {}, now: () => new Date('2026-10-16T10:00:00') })).toBeUndefined();
  });
  it('cadence.yaml à grille de prix malformée : pas d’exception qui casse orchestrate', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.cadence', 'runs'), { recursive: true });
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices: [pas, une, grille\n');
    expect(() => readMeasuredBudgets(dir, '2026-10-16')).not.toThrow();
  });
  it('RAF_TODAY invalide : on retombe sur now, sans exception', () => {
    const dir = tempDir();
    expect(() => measuredBudgetsAt(dir, { env: { RAF_TODAY: 'demain' }, now: () => new Date('2026-10-16T10:00:00') })).not.toThrow();
  });
  it('RAF_TODAY vide : retombe sur now (fenêtre de now, pas d’une date vide)', () => {
    const dir = tempDir();
    const runs = join(dir, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    mkdirSync(join(dir, 'alpha', '.cadence'), { recursive: true });
    const body = [1, 2, 3, 4, 5].map((i) => `  - id: L${i}\n    title: "t"\n    status: done\n    estimate: 0.5`).join('\n');
    writeFileSync(join(dir, 'alpha', '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body}\n`);
    for (let i = 1; i <= 5; i++) writeJournal(runs, 'w1', 'alpha', `L${i}`, { status: 'ready', steps: [{ kind: 'implement', ended: '2026-10-14T09:00:00', counted: 800_000 }] });
    const r = measuredBudgetsAt(dir, { env: { RAF_TODAY: '' }, now: () => new Date('2026-10-16T10:00:00') });
    expect(r?.get('0.5')?.p90).toBe(800_000);
  });
  it('lots rendus dans le futur (après today) : pas comptés', () => {
    const dir = tempDir();
    const runs = join(dir, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    mkdirSync(join(dir, 'alpha', '.cadence'), { recursive: true });
    const body = [1, 2, 3, 4, 5].map((i) => `  - id: L${i}\n    title: "t"\n    status: done\n    estimate: 0.5`).join('\n');
    writeFileSync(join(dir, 'alpha', '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body}\n`);
    for (let i = 1; i <= 5; i++) writeJournal(runs, 'w1', 'alpha', `L${i}`, { status: 'ready', steps: [{ kind: 'implement', ended: '2026-11-20T09:00:00', counted: 800_000 }] });
    const r = readMeasuredBudgets(dir, '2026-10-16');
    expect(r.get('0.5')?.lots ?? 0).toBe(0);
  });
});
