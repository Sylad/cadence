import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// R29 : deux budgets distincts. Le noyau (le produit) reste petit ; la mesure (banc, séquence) a le sien.
// Les fichiers à la racine de src/ (cli.ts) comptent dans le noyau.
type Groupe = { total: number; modules: Record<string, number> };
const racine = join(import.meta.dirname, '..');
const budget = JSON.parse(readFileSync(join(racine, 'budget.json'), 'utf8')) as Record<'noyau' | 'mesure', Groupe>;
const src = join(racine, 'src');

function lignes(chemin: string): number {
  if (statSync(chemin).isDirectory()) return readdirSync(chemin).reduce((n, e) => n + lignes(join(chemin, e)), 0);
  return chemin.endsWith('.ts') ? readFileSync(chemin, 'utf8').split('\n').length : 0;
}
const entrees = readdirSync(src);
const dossiers = entrees.filter((e) => statSync(join(src, e)).isDirectory());
const fichiersRacine = entrees.filter((e) => !dossiers.includes(e));

describe('budget de lignes de v2/src (cause C4 de l\'échec du 07-11, R29)', () => {
  it('les totaux sont ceux de R29 : noyau 3000, mesure 1500', () => {
    expect(Object.keys(budget).sort()).toEqual(['mesure', 'noyau']);
    expect([budget.noyau.total, budget.mesure.total]).toEqual([3000, 1500]);
  });
  for (const [nom, g] of Object.entries(budget)) {
    it(`groupe ${nom} : la somme des budgets ne dépasse pas ${g.total}`, () =>
      expect(Object.values(g.modules).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(g.total));
    it(`groupe ${nom} : ses lignes tiennent dans ${g.total}`, () => {
      const n = dossiers.filter((d) => d in g.modules).reduce((a, d) => a + lignes(join(src, d)), 0)
        + (nom === 'noyau' ? fichiersRacine.reduce((a, f) => a + lignes(join(src, f)), 0) : 0);
      expect(n).toBeLessThanOrEqual(g.total);
    });
  }
  for (const e of dossiers) {
    it(`le module ${e} appartient à un seul groupe et tient son budget`, () => {
      const groupes = Object.values(budget).filter((g) => e in g.modules);
      expect(groupes.length, `module ${e} sans budget (ou dans deux groupes) : un module neuf demande un rapport de banc où il gagne`).toBe(1);
      expect(lignes(join(src, e))).toBeLessThanOrEqual(groupes[0].modules[e]);
    });
  }
});
