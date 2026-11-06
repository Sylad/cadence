import { describe, expect, it } from 'vitest';
import { measureWave, parseJournal } from '../src/inspect.js';

// L644 (sonde) — bords de l'attente de ressource : doublons, sous-tâches, lots entrelacés, minutes actives.

const at = (min: number, text: string) => `2026-11-06T09:${String(min).padStart(2, '0')}:00.000Z ${text}`;
const D = (lot: string, holder: string, resource = 'cycle-ts') => `${lot} intégration différée : ${holder} touche la ressource « ${resource} » (src/x)`;
const measure = (...lines: string[]) => measureWave(parseJournal(`${lines.join('\n')}\n`));
const waits = (m: ReturnType<typeof measure>) => m.losses.filter((l) => l.category === 'attente de ressource');

describe('inspect (L644, sonde) — attente de ressource', () => {
  it('la même ligne répétée à chaque sondage reste une seule attente et un seul porteur', () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(1, D('cadence:L1', 'cadence:L2')), at(2, D('cadence:L1', 'cadence:L2')), at(3, D('cadence:L1', 'cadence:L2')), at(10, 'cadence:L1 intégré : a..b'));
    expect(waits(m)).toHaveLength(1);
    expect(waits(m)[0]).toMatchObject({ minutes: 9, holders: ['cadence:L2'] });
  });

  it("l'id d'une sous-tâche avec « / » (lot et porteur) est lu", () => {
    const l = 'maritime-atlas:Q4/accueil-4';
    const m = measure(at(0, `${l} → reviewing`), at(2, D(l, 'maritime-atlas:Q4/accueil-3')), at(12, `${l} intégré : a..b`));
    expect(waits(m)).toHaveLength(1);
    expect(waits(m)[0]).toMatchObject({ lot: l, minutes: 10, holders: ['maritime-atlas:Q4/accueil-3'] });
    expect(m.lots.find((x) => x.lot === l)!.states.reviewing).toBe(2);
  });

  it("l'intégration d'un autre lot ne ferme pas l'attente de ce lot", () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(1, D('cadence:L1', 'cadence:L2')), at(5, 'cadence:L2 intégré : a..b'), at(5, 'cadence:L2 → ready'), at(20, 'cadence:L1 intégré : c..d'));
    expect(waits(m).map((w) => [w.lot, w.minutes])).toEqual([['cadence:L1', 19]]);
  });

  it('une attente de plus de 10 min a sa ligne, même sans « intégré » ni reprise', () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(1, D('cadence:L1', 'cadence:L2')), at(30, 'cadence:L2 → implementing'));
    expect(waits(m).reduce((s, w) => s + w.minutes, 0)).toBe(29);
  });

  it("la revue ne garde aucune minute d'attente, l'attente ne dépasse pas la revue", () => {
    const m = measure(at(0, 'cadence:L1 → implementing'), at(4, 'cadence:L1 → reviewing'), at(6, D('cadence:L1', 'cadence:L2')), at(26, 'cadence:L1 intégré : a..b'), at(27, 'cadence:L1 → ready'));
    const s = m.lots[0]!.states;
    expect(s.implementing).toBe(4);
    expect(s.reviewing).toBe(3);
    expect(s['attente de ressource']).toBe(20);
  });
});
