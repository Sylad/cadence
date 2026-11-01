// Les passes lancées sur des tests rouges et terminées sans changement de code (L510) : la part des corrections que la porte a demandées pour rien.

import type { FixPass } from './corrections.js';

/** Passes lancées sur des tests rouges (sans constat de revue) et, parmi elles, celles terminées sans commit : la session a rendu sa passe sans changer le code. */
interface TestsSansCode {
  passes: number;
  sansCode: number;
}

export function testsSansCode(passes: FixPass[]): TestsSansCode {
  const onTests = passes.filter((p) => p.findings.length === 0);
  return { passes: onTests.length, sansCode: onTests.filter((p) => p.commits.length === 0).length };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** La ligne du rapport lisible, vide sans passe de ce genre. À part de `renderReport` : le relevé de référence du 10-10 reproduit ce rapport mot pour mot. */
export function renderTestsSansCode(t: TestsSansCode): string[] {
  if (t.passes === 0) return [];
  return [`${plural(t.passes, 'passe lancée', 'passes lancées')} sur des tests, ${plural(t.sansCode, 'terminée', 'terminées')} sans changement de code (${Math.round((100 * t.sansCode) / t.passes)} %) (passes sans commit).`, ''];
}
