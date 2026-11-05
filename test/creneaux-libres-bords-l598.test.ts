import { afterEach, describe, expect, it } from 'vitest';
import { both, dead, reap } from './creneaux-libres-commun-l598.js';

afterEach(reap);

describe('L598 — bords de la formule unique des créneaux libres', () => {
  it('lanes à 0 : la vague ne tient rien, malgré ses dépôts', () => {
    expect(both(3, [{ cap: 3, lanes: 0, repos: 2 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('vague sans dépôt ni lanes : ne tient rien', () => {
    expect(both(3, [{ cap: 3, repos: 0 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('plafond de vague supérieur à la machine : borné par le plafond de la machine', () => {
    expect(both(2, [{ cap: 9, lanes: 5, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
  it('plafond 0 (invalide) : ignoré comme inconnu', () => {
    expect(both(3, [{ cap: 0, lanes: 5, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
  it('une vague vivante à côté d\'une morte : seule la vivante compte', () => {
    expect(both(4, [{ cap: 4, lanes: 2, repos: 1 }, { cap: 4, lanes: 3, repos: 1, pid: dead() }])).toEqual({ registre: 2, bande: 2 });
  });
  it('deux vagues dont une sans plafond : la sans plafond compte pour le total', () => {
    expect(both(4, [{ cap: 2, lanes: 1, repos: 1 }, { lanes: 1, repos: 1 }])).toEqual({ registre: 2, bande: 2 });
  });
  it('deux vagues dont une sans plafond qui tient plus que le plafond commun : bornée par le total, pas par le plafond commun (le collecteur rend cap null)', () => {
    expect(both(4, [{ cap: 2, lanes: 1, repos: 1 }, { lanes: 3, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
    expect(both(5, [{ cap: 2, repos: 2 }, { repos: 3 }])).toEqual({ registre: 0, bande: 0 });
  });
  it('la même session du lead posée deux fois ne compte qu\'une fois', () => {
    const r = both(3, [], [{ label: 'qa', ttlMinutes: 30 }, { label: 'qa', ttlMinutes: 30 }]);
    expect(r).toEqual({ registre: 2, bande: 2 });
  });
  it('TTL négatif : échue, ne compte pas', () => {
    expect(both(3, [], [{ label: 'qa', ttlMinutes: -5 }])).toEqual({ registre: 3, bande: 3 });
  });
  it('plafond machine 1, deux vagues : 0', () => {
    expect(both(1, [{ cap: 1, lanes: 1, repos: 1 }, { cap: 1, lanes: 1, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });
});
