import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateRollout, readRollout, rolloutPrice } from '../src/cost-estimate.js';

// L694 — les gains des coupes du socle (docs/mesures/socle-session-2026-11-11.md) sont ceux que donne cadence cost : socle médian moins les jetons de la coupe.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'socle-2026-11-11');
const cout = (fichier: string, coupe: number) => {
  const r = readRollout(JSON.parse(readFileSync(join(FIXTURES, fichier), 'utf8')));
  const coupee = { ...r, sessions: r.sessions.map((s) => ({ ...s, base: s.base! - coupe })) };
  return estimateRollout(coupee, rolloutPrice(coupee, {})).total.cost;
};

/** Jetons retirés du socle par chaque coupe : somme des postes du tableau de la page. */
const COUPES = {
  C1: 5509,
  C2: 1591 + 1658 + 1341 + 1160 + 95 + 85 + 49 + 477 + 119,
  C3: 1313 + 129 + 432 + 885 + 45 + 47 + 24,
  C4: 988,
  U1: 4093,
  U2: 1741,
  U3: 1312,
};
/** Gain par session (dollars), tels qu'écrits dans la page : [cadence run, banc] ; null quand la coupe ne touche pas ces sessions. */
const GAINS: Record<keyof typeof COUPES, [number, number | null]> = {
  C1: [0.09, null],
  C2: [0.11, 0.1],
  C3: [0.05, 0.05],
  C4: [0.02, 0.02],
  U1: [0.07, 0.06],
  U2: [0.03, 0.03],
  U3: [0.02, 0.02],
};

describe('L694 — gains des coupes du socle, recalculés par cadence cost', () => {
  it('socle médian : 2,31 $ par session cadence run, 2,05 $ par session de banc', () => {
    expect(cout('run.json', 0)).toBeCloseTo(2.31, 2);
    expect(cout('banc.json', 0)).toBeCloseTo(2.05, 2);
  });
  for (const [c, n] of Object.entries(COUPES) as [keyof typeof COUPES, number][]) {
    it(`${c} : −${n} jetons`, () => {
      const [run, banc] = GAINS[c];
      expect(cout('run.json', 0) - cout('run.json', n)).toBeCloseTo(run, 2);
      if (banc !== null) expect(cout('banc.json', 0) - cout('banc.json', n)).toBeCloseTo(banc, 2);
    });
  }
});
