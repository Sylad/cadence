// Comptes de `cadence perf` tirés des constats et des tests des lots rendus : tests instables sous charge (L354) et constats de revue écartés par L622 (L638).

import type { DecisionConstat } from './orchestrate/state.js';

/** Tests « instables sous charge » des lots rendus d'une fenêtre (L354) : lots qui en portent et tests distincts par lot, additionnés. */
export interface InstableCounts {
  lots: number;
  tests: number;
}

/** Les tests instables sous charge des lots donnés (L354). */
export function instableCounts(set: { j: { instables?: string[] } }[]): InstableCounts {
  const withTests = set.filter((d) => (d.j.instables?.length ?? 0) > 0);
  return { lots: withTests.length, tests: withTests.reduce((n, d) => n + d.j.instables!.length, 0) };
}

/** Constats de revue écartés par L622 (L638) : sur les lots rendus d'une fenêtre, ceux dont la décision a été gardée ; `taux` null sans constat gardé ; `vagues` : le même compte par vague. */
export interface EcarteCounts {
  constats: number;
  ecartes: number;
  taux: number | null;
  vagues: { wave: string; constats: number; ecartes: number; taux: number }[];
}

const DECISIONS: readonly unknown[] = ['compte', 'ecarte-inchange', 'ecarte-hors-regle', 'ecarte-deja-note'] satisfies DecisionConstat[];

/** Les décisions lisibles des `constatsRevue` des pas d'un journal (L638) ; une entrée sans décision connue est ignorée. */
export function decisionsOf(steps: { constatsRevue?: unknown }[]): DecisionConstat[] {
  const kept = steps.flatMap((s) => (Array.isArray(s.constatsRevue) ? (s.constatsRevue as ({ decision?: unknown } | null)[]) : []));
  return kept.map((k) => k?.decision).filter((d): d is DecisionConstat => DECISIONS.includes(d));
}

/** Les constats de revue gardés des lots donnés et la part que L622 écarte (`ecarte-inchange`), au total et par vague. */
export function ecarteCounts(set: { j: { wave: string; decisions?: DecisionConstat[] } }[]): EcarteCounts {
  const byWave = new Map<string, { constats: number; ecartes: number }>();
  for (const { j } of set) {
    if (!j.decisions?.length) continue;
    const w = byWave.get(j.wave) ?? { constats: 0, ecartes: 0 };
    w.constats += j.decisions.length;
    w.ecartes += j.decisions.filter((x) => x === 'ecarte-inchange').length;
    byWave.set(j.wave, w);
  }
  const vagues = [...byWave].sort(([a], [b]) => a.localeCompare(b)).map(([wave, w]) => ({ wave, ...w, taux: w.ecartes / w.constats }));
  const constats = vagues.reduce((n, v) => n + v.constats, 0);
  const ecartes = vagues.reduce((n, v) => n + v.ecartes, 0);
  return { constats, ecartes, taux: constats ? ecartes / constats : null, vagues };
}

/** Les lignes du rapport lisible : vide sans constat gardé. */
export function ecarteLines(cur: EcarteCounts, previous: EcarteCounts, pct: (v: number) => string): string[] {
  if (cur.constats === 0) return [];
  const before = previous.taux === null ? 'n/d' : pct(previous.taux);
  return ['', 'Revues : constats écartés', `  constats de revue écartés par L622 : ${cur.ecartes} sur ${cur.constats} (${pct(cur.taux!)} ; précédente ${before})`, ...cur.vagues.map((v) => `    ${v.wave} : ${v.ecartes} sur ${v.constats} (${pct(v.taux)})`)];
}
