import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const racine = join(import.meta.dirname, '..');
const budget = JSON.parse(readFileSync(join(racine, 'budget.json'), 'utf8')) as { total: number; modules: Record<string, number> };

function lignes(chemin: string): number {
  if (statSync(chemin).isDirectory()) return readdirSync(chemin).reduce((n, e) => n + lignes(join(chemin, e)), 0);
  return chemin.endsWith('.ts') ? readFileSync(chemin, 'utf8').split('\n').length : 0;
}

describe('budget de lignes de v2/src (cause C4 de l\'échec du 07-11)', () => {
  const src = join(racine, 'src');
  it(`le total tient dans ${budget.total} lignes`, () => expect(lignes(src)).toBeLessThanOrEqual(budget.total));
  for (const e of readdirSync(src).filter((e) => statSync(join(src, e)).isDirectory())) {
    it(`le module ${e} a un budget et le tient`, () => {
      expect(budget.modules[e], `module ${e} sans budget : un module neuf demande un rapport de banc où il gagne`).toBeDefined();
      expect(lignes(join(src, e))).toBeLessThanOrEqual(budget.modules[e]);
    });
  }
  it('la somme des budgets ne dépasse pas le total', () =>
    expect(Object.values(budget.modules).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget.total));
});
