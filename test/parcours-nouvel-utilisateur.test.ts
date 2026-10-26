import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// L357 — le rapport du parcours mesuré d'un nouvel utilisateur sur une machine vierge de cadence.
const root = join(import.meta.dirname, '..');
const md = () => readFileSync(join(root, 'docs/mesures/parcours-nouvel-utilisateur-2026-10-26.md'), 'utf8');
const lignesTable = (titre: string) => {
  const part = md().split(/^## /m).find((s) => s.startsWith(titre));
  expect(part, `section « ${titre} » absente`).toBeDefined();
  return part!.split('\n').filter((l) => /^\| (A|S)\d+ /.test(l));
};

describe('parcours mesuré d\'un nouvel utilisateur (L357)', () => {
  it('Rapport — le document nomme L357, la machine vierge et les versions installées', () => {
    expect(md()).toContain('L357');
    expect(md()).toMatch(/Ubuntu 24\.04/);
    expect(md()).toMatch(/@sylad\/cadence 1\.13\.0/);
  });

  it('Rapport — chaque étape jouée porte sa commande et un temps mesuré en secondes', () => {
    const etapes = lignesTable('Parcours');
    expect(etapes.length).toBeGreaterThanOrEqual(8);
    for (const l of etapes) {
      const cells = l.split('|').map((c) => c.trim());
      expect(cells[3], l).toMatch(/`.+`/);
      expect(cells[4], l).toMatch(/^(\d+(,\d)? s|non joué)/);
    }
  });

  it('Rapport — chaque accroc cite la commande, le message reçu, le temps perdu et le lot proposé', () => {
    const accrocs = lignesTable('Accrocs');
    expect(accrocs.length).toBeGreaterThanOrEqual(5);
    for (const l of accrocs) {
      const cells = l.split('|').map((c) => c.trim());
      expect(cells[2], l).toMatch(/`.+`/);
      expect(cells[3].length, l).toBeGreaterThan(5);
      expect(cells[4], l).toMatch(/^(\d+(,\d)? s|non mesuré)/);
      expect(cells[5], l).toMatch(/^lot : /);
    }
  });

  it('Rapport — rien de propre à notre dossier : aucun chemin ni nom de nos projets', () => {
    expect(md()).not.toMatch(/sylvain_ladoire|developpeur\/|maritime|aetherwx|mini-blue|sylva@/i);
  });

  it('Rapport — ce qui n\'a pas pu être joué est dit, pas inventé', () => {
    expect(md()).toMatch(/## Non joué/);
    expect(md()).toMatch(/Not logged in/);
  });
});
