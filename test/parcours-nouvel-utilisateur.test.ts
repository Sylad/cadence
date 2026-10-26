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

  it('Rapport — A7 ne dit pas que la doc tait la session `claude -p` : elle ne dit pas qu\'il doit être connecté', () => {
    const a7 = lignesTable('Accrocs').find((l) => l.startsWith('| A7 '))!;
    expect(a7).not.toMatch(/ni le README ni/);
    expect(a7).toMatch(/connecté/);
  });

  it('Rapport — A8 oppose `raf now` et le tour à `raf commits`, pas le tour à `raf now`', () => {
    const a8 = lignesTable('Accrocs').find((l) => l.startsWith('| A8 '))!;
    expect(a8).not.toMatch(/le tour disait `0 commit` avant/);
    expect(a8).toMatch(/le tour/);
    expect(a8).toMatch(/`raf commits/);
  });

  it('Rapport — « Rejouer » ne promet pas une remise à zéro que la commande ne fait pas', () => {
    const rejouer = md().split(/^## /m).find((s) => s.startsWith('Rejouer'))!;
    expect(rejouer).toMatch(/\.npmrc/);
    expect(rejouer).toMatch(/Node/);
    expect(rejouer).not.toMatch(/&& npm uninstall -g/);
  });

  it('CHANGELOG — le nombre de lots annoncés est celui du rapport (A6 sans lot)', () => {
    const lots = lignesTable('Accrocs').filter((l) => !/\| lot : aucun/.test(l)).length;
    const mots = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const ligne = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n').find((l) => l.includes('(L357)'))!;
    expect(ligne).toContain(`${mots[lots]} of them turned into a lot`);
  });
});
