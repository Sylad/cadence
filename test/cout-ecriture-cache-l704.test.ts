import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Io } from '../src/cli.js';
import { stepEuros } from '../src/cost.js';
import { readPerfSettings } from '../src/perf-config.js';
import { costView, launchCost } from '../src/orchestrate/cout.js';
import type { LotState } from '../src/orchestrate/state.js';
import { tempDir } from './helpers.js';

// L704 : cadence perf et orchestrate chiffrent un relevé avec la grille de cadence cost (L693) : sortie, entrée, cache lu, cache écrit.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'cost-banc-2026-11-10');
const MODEL = 'claude-opus-5-5';
const WITH_WRITE = `perf:\n  prices:\n    ${MODEL}: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }\n`;
const WITHOUT_WRITE = `perf:\n  prices:\n    ${MODEL}: { input: 4, output: 20, cacheRead: 0.2 }\n`;

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { cwd, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-11T12:00:00Z') };
  return { io: value, out, err };
}

/** Les tokens et le coût que `cadence cost` donne pour un déroulé du banc, avec la grille donnée. */
function costOf(grid: string, rollout: string) {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), grid);
  const t = io(dir);
  expect(run(['cost', join(FIXTURES, `${rollout}.json`), '--json'], t.io)).toBe(0);
  const total = JSON.parse(t.out.join('\n')).total as { cacheRead: number; cacheWrite: number; output: number; cost: number };
  return { dir, total, err: t.err };
}

describe('L704 — un relevé avec écritures de cache est chiffré comme par cadence cost', () => {
  for (const [label, grid] of [['grille avec cacheWrite', WITH_WRITE], ['grille sans cacheWrite (défaut entrée × 2)', WITHOUT_WRITE]] as const) {
    for (const rollout of ['session-neuve-r1', 'session-gardee-r1']) {
      it(`${label}, ${rollout} : stepEuros = cadence cost`, () => {
        const { dir, total } = costOf(grid, rollout);
        expect(total.cacheWrite).toBeGreaterThan(0);
        const prices = readPerfSettings(join(dir, 'cadence.yaml')).prices!;
        const step = { model: MODEL, usage: { input: 0, cacheWrite: total.cacheWrite, cacheRead: total.cacheRead, output: total.output } };
        expect(stepEuros(step, prices)).toBeCloseTo(total.cost, 9);
        // La table de la vague (orchestrate) somme les mêmes étapes au même prix.
        const lot = { project: 'p', lot: 'L1', model: MODEL, steps: [{ model: MODEL, tokens: step.usage }] } as unknown as LotState;
        const view = costView([lot], prices);
        expect(view.cells[0][0]).toBe(total.cost.toFixed(2).replace('.', ','));
      });
    }
  }

  it('les écritures pèsent leur prix : 1 M écrits à 8 coûtent 8, pas les 4 de l\'entrée', () => {
    const prices = { [MODEL]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 } };
    expect(stepEuros({ model: MODEL, usage: { input: 0, cacheWrite: 1e6, cacheRead: 0, output: 0 } }, prices)).toBeCloseTo(8, 12);
    expect(stepEuros({ model: MODEL, usage: { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 } }, prices)).toBeCloseTo(4, 12);
  });

  it('une grille sans cacheWrite avertit : cadence cost, orchestrate et la grille nomment le modèle', () => {
    const { dir, err } = costOf(WITHOUT_WRITE, 'session-neuve-r1');
    expect(err.join('\n')).toMatch(new RegExp(`sans cacheWrite pour ${MODEL} : écriture de cache chiffrée à l'entrée × 2`));
    expect(readPerfSettings(join(dir, 'cadence.yaml')).defaultCacheWrite).toEqual([MODEL]);
    const warned: string[] = [];
    launchCost(dir, (w) => warned.push(w));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`sans cacheWrite pour ${MODEL}`);
  });

  it('une grille complète n\'avertit pas', () => {
    const { dir, err } = costOf(WITH_WRITE, 'session-neuve-r1');
    expect(err).toEqual([]);
    const warned: string[] = [];
    launchCost(dir, (w) => warned.push(w));
    expect(warned).toEqual([]);
  });
});
