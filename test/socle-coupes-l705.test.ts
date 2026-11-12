import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateRollout, readRollout, rolloutPrice } from '../src/cost-estimate.js';

// L705 — les coupes appliquées à cadence run, mesurées sur de vraies sessions le 12-11 (docs/mesures/socle-session-2026-11-11.md, « Coupes appliquées ») :
// les écarts écrits dans la page sont ceux des premiers tours mesurés, et leurs gains ceux que donne cadence cost sur le déroulé médian de L694.
const PAGE = readFileSync(join(import.meta.dirname, '..', 'docs', 'mesures', 'socle-session-2026-11-11.md'), 'utf8');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'socle-2026-11-11');
const cout = (coupe: number) => {
  const r = readRollout(JSON.parse(readFileSync(join(FIXTURES, 'run.json'), 'utf8')));
  const coupee = { ...r, sessions: r.sessions.map((s) => ({ ...s, base: s.base! - coupe })) };
  return estimateRollout(coupee, rolloutPrice(coupee, {})).total.cost;
};
const fr = (n: number) => n.toLocaleString('fr-FR').replace(/ /g, ' ');

/** Premiers tours mesurés : [sans coupe, avec]. */
const MESURES: Record<string, [number, number]> = {
  'C1 seule': [64763, 59464],
  'C2 seule': [64763, 61570],
  'C3 seule': [64763, 61474],
  'C4 seule': [64763, 64064],
  'code de L705, C2 + C3 + C4': [64844, 57653],
  'code de L705, C1 + C2 + C3 + C4': [64844, 52278],
};

describe('L705 — coupes du socle de cadence run, mesurées', () => {
  for (const [ligne, [avant, apres]] of Object.entries(MESURES)) {
    it(`${ligne} : ${avant} → ${apres}, l'écart écrit dans la page`, () => {
      const l = PAGE.split('\n').find((x) => x.includes(ligne) && x.includes(fr(apres)));
      expect(l, ligne).toBeDefined();
      expect(l).toContain(`−${fr(avant - apres)}`);
    });
  }
  it('défaut (C2 + C3 + C4) : 0,12 $ par lot (−5,0 %) ; avec C1 : 0,20 $ (−8,7 %)', () => {
    const base = cout(0), [d, c1] = [64844 - 57653, 64844 - 52278].map((n) => base - cout(n));
    expect(d).toBeCloseTo(0.12, 2);
    expect((d / base) * 100).toBeCloseTo(5.0, 1);
    expect(c1).toBeCloseTo(0.2, 2);
    expect((c1 / base) * 100).toBeCloseTo(8.7, 1);
    expect(PAGE).toMatch(/0,12 \$ par lot\s+\(−5,0 %\)\*\* par défaut, 0,20 \$ \(−8,7 %\)/);
  });
});
