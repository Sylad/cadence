import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateRollout, readRollout, rolloutPrice } from '../src/cost-estimate.js';
import { run, type Io } from '../src/cli.js';
import { tempDir } from './helpers.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'cost-banc-2026-11-10');

// Grille calée sur les journaux du banc 2026-11-10-1551-b4bcc9ea9150 (docs/cost.md) : sortie, cache lu et cache écrit mesurés, entrée supposée (écriture / 2).
const GRID_YAML = 'perf:\n  prices:\n    claude-opus-5-5: { input: 4, output: 20, cacheRead: 0.2 }\n  currency: "$"\n';

/**
 * Coût réel de chaque bras, en dollars : le `totalCostUSD` du dernier `cost-state` du journal de chaque session (~/.claude/projects/…-aether-b68-court-<r>-<c>/<session>.jsonl).
 * Session neuve (c1) : trois sessions, la somme des trois. Session gardée (c2) : une seule session, son total final — pas la somme des `cout_usd` des étapes
 * de resultat.json (31,52 et 29,66 $), qui additionne des totaux cumulés (docs/cost.md, « Ce que le banc a compté »).
 */
const REAL = {
  'session-neuve-r1': 3.689 + 2.694 + 2.036,
  'session-neuve-r2': 5.561 + 1.813 + 1.767,
  'session-gardee-r1': 10.005,
  'session-gardee-r2': 9.076,
};

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { cwd, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-11T12:00:00Z') };
  return { io: value, out, err };
}

const rollout = (sessions: unknown[], extra: Record<string, unknown> = {}) => readRollout({ model: 'm', prices: { input: 10, output: 50, cacheRead: 1 }, sessions, ...extra });

describe('L693 — cadence cost retrouve à ±20 % les coûts réels du banc 2026-11-10-1551', () => {
  for (const [name, real] of Object.entries(REAL)) {
    it(`${name} : réel ${real.toFixed(2)} $`, () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'cadence.yaml'), GRID_YAML);
      const t = io(dir);
      expect(run(['cost', join(FIXTURES, `${name}.json`), '--json'], t.io)).toBe(0);
      const estimated = JSON.parse(t.out.join('\n')).total.cost as number;
      expect(Math.abs(estimated - real) / real).toBeLessThanOrEqual(0.2);
    });
  }
});

describe('L693 — le calcul', () => {
  it('chaque appel renvoie tout le contexte : E·C₀ + g·E(E−1)/2, kept lu, le reste écrit', () => {
    // 3 appels, contexte 1000 puis 1100 puis 1200 : 3300 renvoyés, 3000 lus, 300 écrits ; sortie 3 × 20.
    const c = estimateRollout(rollout([{ exchanges: 3, base: 1000, growth: 100, output: 20, kept: 10 / 11 }]), { input: 10, output: 50, cacheRead: 1 });
    expect(c.total.cacheRead).toBeCloseTo(3000);
    expect(c.total.cacheWrite).toBeCloseTo(300);
    expect(c.total.output).toBe(60);
    // écrit : 300 × 10 × 2 ; lu : 3000 × 1 ; sortie : 60 × 50 — par million.
    expect(c.total.cost).toBeCloseTo((300 * 20 + 3000 + 60 * 50) / 1e6, 12);
    expect(c.sessions[0].endContext).toBe(1300);
  });
  it('cacheWriteFactor change le prix de l\'écriture seule', () => {
    const r = rollout([{ exchanges: 1, base: 1e6, growth: 0, output: 0, kept: 0 }], { cacheWriteFactor: 1.25 });
    expect(estimateRollout(r, r.prices!).total.cost).toBeCloseTo(12.5);
  });
  it('continues reprend le contexte laissé par la session précédente, repeat rejoue la session', () => {
    const r = rollout([
      { exchanges: 2, base: 1000, growth: 500, output: 0, kept: 1 },
      { exchanges: 1, growth: 0, output: 0, kept: 1, continues: true, repeat: 2 },
    ]);
    const c = estimateRollout(r, r.prices!);
    expect(c.sessions[0].endContext).toBe(2000);
    expect(c.sessions[1].startContext).toBe(2000);
    expect(c.sessions[1].exchanges).toBe(2);
    expect(c.sessions[1].cacheRead).toBe(4000);
  });
  it('defaults complète chaque session', () => {
    const r = readRollout({ model: 'm', defaults: { base: 100, growth: 0, output: 1, kept: 1 }, sessions: [{ exchanges: 2 }, { exchanges: 3, base: 50 }] });
    expect(r.sessions.map((s) => s.base)).toEqual([100, 50]);
  });
  it('le prix vient du déroulé, sinon de la grille ; sans les deux, refus nommé', () => {
    const r = readRollout({ model: 'opus', sessions: [{ exchanges: 1, base: 1, growth: 0, output: 0, kept: 1 }] });
    expect(rolloutPrice(r, { opus: { input: 1, output: 2, cacheRead: 3 } })).toEqual({ input: 1, output: 2, cacheRead: 3 });
    expect(() => rolloutPrice(r, null)).toThrow(/modèle sans prix : opus/);
    expect(() => rolloutPrice(r, { constructor: { input: 1, output: 2, cacheRead: 3 } })).toThrow(/sans prix/);
  });
  it.each([
    [{ model: 'm', sessions: [] }, /liste non vide/],
    [{ model: '', sessions: [{}] }, /model/],
    [{ model: 'm', sessions: [{ exchanges: 0, base: 1, growth: 0, output: 0, kept: 1 }] }, /au moins 1 appel/],
    [{ model: 'm', sessions: [{ exchanges: 1.5, base: 1, growth: 0, output: 0, kept: 1 }] }, /entier/],
    [{ model: 'm', sessions: [{ exchanges: 1, base: 1, growth: 0, output: 0, kept: 1.2 }] }, /entre 0 et 1/],
    [{ model: 'm', sessions: [{ exchanges: 1, growth: 0, output: 0, kept: 1 }] }, /base manquant/],
    [{ model: 'm', sessions: [{ exchanges: 1, base: -1, growth: 0, output: 0, kept: 1 }] }, /≥ 0/],
    [{ model: 'm', sessions: [{ exchanges: 1, growth: 0, output: 0, kept: 1, continues: true }] }, /première session/],
    [{ model: 'm', sessions: [{ exchanges: 1, base: 1, growth: 0, output: 0, kept: 1, tours: 3 }] }, /tours inconnu/],
    [{ model: 'm', cache: 2, sessions: [{ exchanges: 1, base: 1, growth: 0, output: 0, kept: 1 }] }, /cache inconnu/],
  ])('refus : %j', (raw, msg) => {
    expect(() => readRollout(raw)).toThrow(msg);
  });
});

describe('L693 — la commande', () => {
  it('texte : une ligne par session puis le total, dans la monnaie de la grille', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), GRID_YAML);
    const t = io(dir);
    expect(run(['cost', join(FIXTURES, 'session-gardee-r1.json')], t.io)).toBe(0);
    expect(t.out[0]).toContain('claude-opus-5-5 : entrée 4, cache écrit 8 (×2), cache lu 0,2, sortie 20');
    expect(t.out.filter((l) => l.startsWith('  '))).toHaveLength(4);
    expect(t.out.at(-1)).toMatch(/^total : .* : \d+,\d\d \$ estimés$/);
  });
  it('--config nomme le cadence.yaml de la grille ; un YAML se lit comme un JSON', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'grille.yaml'), GRID_YAML);
    writeFileSync(join(dir, 'd.yaml'), 'model: claude-opus-5-5\nsessions:\n  - { exchanges: 1, base: 1000000, growth: 0, output: 0, kept: 1 }\n');
    const t = io(dir);
    expect(run(['cost', 'd.yaml', '--config', 'grille.yaml', '--json'], t.io)).toBe(0);
    expect(JSON.parse(t.out.join('\n')).total.cost).toBeCloseTo(0.2);
  });
  it('sans prix pour le modèle : code 1, la clé à déclarer nommée, rien sur la sortie', () => {
    const dir = tempDir();
    const t = io(dir);
    expect(run(['cost', join(FIXTURES, 'session-neuve-r1.json')], t.io)).toBe(1);
    expect(t.err.join('\n')).toContain('perf.prices.claude-opus-5-5');
    expect(t.out).toEqual([]);
  });
  it('fichier absent ou appel sans déroulé : code 1', () => {
    const dir = tempDir();
    expect(run(['cost', 'absent.json'], io(dir).io)).toBe(1);
    expect(run(['cost'], io(dir).io)).toBe(1);
  });
  it('les déroulés du banc sont lisibles tels quels', () => {
    for (const name of Object.keys(REAL)) expect(() => readRollout(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')))).not.toThrow();
  });
});
