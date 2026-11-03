import { nextUp } from './audit.js';
import { type Lot, Plan, RafError } from './plan.js';

/** Estimation (jours) au plus de laquelle un lot prêt est un gain rapide sans drapeau `quickwin:` (L467) ; `raf quickwins --max` la change. */
const QUICKWIN_MAX = 0.25;

interface QuickwinGroup {
  /** La valeur du champ d'extension ; `undefined` : les lots qui n'en portent pas (et sans `--by`, l'unique groupe). */
  value?: string;
  lots: Lot[];
}

interface Quickwins {
  groups: QuickwinGroup[];
  /** Les lots prêts dont le plan ne donne aucune estimation : ni gains rapides ni gros, à estimer. */
  unestimated: Lot[];
}

/** `--max` lu : un nombre de jours strictement positif, ou l'erreur. */
export function readMax(text: string | undefined): number {
  if (text === undefined) return QUICKWIN_MAX;
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n) || n <= 0) throw new RafError(`--max invalide : ${text} (un nombre de jours supérieur à 0)`);
  return n;
}

/**
 * Les gains rapides du plan (L467) : les lots prêts (`nextUp` : à faire, `after` clos, condition de tirage tenue, ni récurrents ni en cours)
 * dont l'estimation tient dans `max` (`declared` : les champs d'extension déclarés, `by` doit en être un) ou qui portent `quickwin:`, groupés par le champ d'extension `by` (valeurs triées, les lots sans valeur à la fin),
 * et à part les prêts sans estimation. Sans `by`, un seul groupe.
 */
export function quickwins(plan: Plan, opts: { by?: string; max?: number; declared?: string[] } = {}): Quickwins {
  const { by, max = QUICKWIN_MAX, declared = [] } = opts;
  if (by !== undefined && !declared.includes(by)) {
    throw new RafError(declared.length === 0 ? `${by} : aucun champ d'extension déclaré (cadence.yaml : plan.extras)` : `${by} : champ d'extension non déclaré (${declared.join(', ')})`);
  }
  const { ready } = nextUp(plan.lots());
  const quick = ready.filter((l) => l.quickwin || (!l.unestimated && l.estimate <= max));
  const unestimated = ready.filter((l) => l.unestimated && !l.quickwin);
  if (by === undefined) return { groups: quick.length ? [{ lots: quick }] : [], unestimated };
  const byValue = new Map<string | undefined, Lot[]>();
  for (const l of quick) byValue.set(l.extras?.[by], [...(byValue.get(l.extras?.[by]) ?? []), l]);
  const values = [...byValue.keys()].filter((v): v is string => v !== undefined).sort();
  const groups = [...values, ...(byValue.has(undefined) ? [undefined] : [])].map((value) => ({ value, lots: byValue.get(value)! }));
  return { groups, unestimated };
}

const line = (l: Lot): string => `${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title}${l.unestimated ? '' : `  (${l.estimate} j)`}`;

/** Le rapport de `raf quickwins`, ligne à ligne. */
export function quickwinLines(r: Quickwins, by?: string): string[] {
  const lines: string[] = [];
  if (r.groups.length === 0) lines.push('aucun gain rapide prêt');
  for (const g of r.groups) {
    if (by !== undefined) lines.push(g.value === undefined ? `sans ${by}` : `${by} : ${g.value}`);
    for (const l of g.lots) lines.push(`  ${line(l)}`);
  }
  if (r.unestimated.length) {
    lines.push('Non estimés');
    for (const l of r.unestimated) lines.push(`  ${line(l)}`);
  }
  return lines;
}
