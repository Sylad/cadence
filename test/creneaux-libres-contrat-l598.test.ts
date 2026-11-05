import { afterEach, describe, expect, it } from 'vitest';
import { both, dead, reap } from './creneaux-libres-commun-l598.js';

// L598 (E1) : un seul calcul des créneaux libres. Le registre (`freeSlots`, lu par `orchestrate --status` et `lead tour`) et la bande
// (`freeSlots` de format.ts, nourrie par le collecteur Python) sont deux implémentations ; ce contrat les joue sur le MÊME registre :
// la prochaine divergence est une porte rouge, pas un constat du lead. Le montage (`both`) est dans creneaux-libres-commun-l598.ts.

afterEach(reap);

describe('L598 — le même chiffre de créneaux libres, du registre et de la bande', () => {
  it('R1 — aucune vague : les deux disent le plafond', () => {
    expect(both(3, [])).toEqual({ registre: 3, bande: 3 });
  });

  it('R2 — `lanes` prime sur les dépôts (un dépôt, trois lots en worktrees) : 0 sur 3 des deux côtés', () => {
    expect(both(3, [{ cap: 3, lanes: 3, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });

  it('R3 — sans `lanes` (hors worktree), un créneau par dépôt tenu', () => {
    expect(both(4, [{ cap: 4, repos: 2 }])).toEqual({ registre: 2, bande: 2 });
  });

  it('R4 — le plafond commun fait loi : une vague à 4 à côté d\'une vague à 3 compte au plus 3 chacune', () => {
    expect(both(4, [{ cap: 4, lanes: 4, repos: 1 }, { cap: 3, lanes: 1, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
    // Sur 5, la vague à 4 tient 4 et celle à 3 tient 1 : 5-(4+1) = 0 au plafond propre de chaque vague, 5-(3+1) = 1 au plafond commun (le plus petit, 3).
    expect(both(5, [{ cap: 4, lanes: 4, repos: 1 }, { cap: 3, lanes: 1, repos: 1 }])).toEqual({ registre: 1, bande: 1 });
  });

  it('R5 — une vague sans plafond connu compte pour le plafond de la machine', () => {
    expect(both(3, [{ lanes: 5, repos: 1 }])).toEqual({ registre: 0, bande: 0 });
  });

  it('R6 — une vague au pid mort ne tient aucun créneau, des deux côtés', () => {
    expect(both(3, [{ cap: 3, lanes: 2, repos: 1, pid: dead() }])).toEqual({ registre: 3, bande: 3 });
  });

  it('R6b — un pid repris (vivant, mais d\'une autre heure de démarrage que celle inscrite) est un porteur mort, des deux côtés', () => {
    expect(both(3, [{ cap: 3, lanes: 2, repos: 1, start: '1' }])).toEqual({ registre: 3, bande: 3 });
  });

  it('R7 — une session du lead prend un créneau, sauf échue : à l\'échéance elle le rend', () => {
    expect(both(3, [{ cap: 3, lanes: 1, repos: 1 }], [{ label: 'qa', ttlMinutes: 30 }])).toEqual({ registre: 1, bande: 1 });
    expect(both(3, [{ cap: 3, lanes: 1, repos: 1 }], [{ label: 'qa', ttlMinutes: 0 }])).toEqual({ registre: 2, bande: 2 });
  });

  it('R8 — jamais négatif : des vagues qui tiennent plus que le plafond et une session du lead donnent 0', () => {
    expect(both(2, [{ cap: 2, lanes: 2, repos: 1 }, { cap: 2, lanes: 2, repos: 1 }], [{ label: 'qa', ttlMinutes: 30 }])).toEqual({ registre: 0, bande: 0 });
  });
});
