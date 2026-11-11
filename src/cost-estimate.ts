// `cadence cost` (L693) : le coût d'un déroulé estimé sans modèle ni banc, d'après les règles connues de la facturation d'une session Claude.
import { isObject } from './yaml-keys.js';
import { RafError } from './plan.js';
import type { ModelPrice, PriceGrid } from './perf-config.js';
import { euros } from './cost.js';

/**
 * Prix d'une écriture de cache, en multiple du prix d'entrée : 2 pour le cache d'une heure que les sessions Claude Code écrivent
 * (`ephemeral_1h_input_tokens` de leurs journaux), 1,25 pour celui de cinq minutes. Le banc 2026-11-10-1551 facture l'écriture 8 $/M, 2 × 4 $/M.
 */
const DEFAULT_CACHE_WRITE_FACTOR = 2;

/** Une session du déroulé : `exchanges` appels au modèle, chacun renvoyant tout le contexte. */
interface CostSession {
  label?: string;
  /** Appels au modèle (un tour d'outil = un appel). */
  exchanges: number;
  /** Contexte envoyé au premier appel : le socle chargé (prompt système, CLAUDE.md, outils, demande). Ignoré par `continues`. */
  base: number;
  /** Tokens ajoutés au contexte à chaque appel : sortie du modèle plus résultats d'outils. */
  growth: number;
  /** Tokens produits par appel (sortie facturée, réflexion comprise). */
  output: number;
  /** Part du contexte renvoyé qui est lue dans le cache (le reste y est écrit). */
  kept: number;
  /** La session reprend le contexte où la précédente l'a laissé (session gardée) au lieu de partir du socle. */
  continues: boolean;
  /** Nombre de fois que la session est jouée. */
  repeat: number;
}

/** Ce que décrit le fichier passé à `cadence cost`. */
interface Rollout {
  model: string;
  prices?: ModelPrice;
  cacheWriteFactor: number;
  sessions: CostSession[];
}

/** Les tokens et le coût d'une session (toutes ses répétitions) ou du déroulé. */
interface CostTally {
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
}

interface SessionCost extends CostTally {
  label: string;
  exchanges: number;
  startContext: number;
  endContext: number;
}

interface RolloutCost {
  model: string;
  price: ModelPrice;
  cacheWriteFactor: number;
  sessions: SessionCost[];
  total: CostTally;
}

const SESSION_KEYS = ['label', 'exchanges', 'base', 'growth', 'output', 'kept', 'continues', 'repeat'] as const;
const ROLLOUT_KEYS = ['model', 'prices', 'cacheWriteFactor', 'defaults', 'sessions'] as const;
const PRICE_KEYS = ['input', 'output', 'cacheRead'] as const;

function refuseUnknown(where: string, o: Record<string, unknown>, known: readonly string[]): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) throw new RafError(`${where}.${k} inconnu (attendu : ${known.join(', ')})`);
}

function nonNegative(where: string, v: unknown, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) throw new RafError(`${where} : ${integer ? 'entier' : 'nombre'} ≥ 0 attendu`);
  return v;
}

function readSession(where: string, raw: unknown, defaults: Record<string, unknown>, first: boolean): CostSession {
  if (!isObject(raw)) throw new RafError(`${where} : objet attendu { ${SESSION_KEYS.join(', ')} }`);
  refuseUnknown(where, raw, SESSION_KEYS);
  const s = { ...defaults, ...raw };
  const continues = s.continues === undefined ? false : s.continues;
  if (typeof continues !== 'boolean') throw new RafError(`${where}.continues : true ou false attendu`);
  if (continues && first) throw new RafError(`${where}.continues : la première session n'a pas de contexte à reprendre`);
  const need = (k: (typeof SESSION_KEYS)[number], integer = false): number => {
    if (s[k] === undefined) throw new RafError(`${where}.${k} manquant`);
    return nonNegative(`${where}.${k}`, s[k], integer);
  };
  const exchanges = need('exchanges', true);
  if (exchanges < 1) throw new RafError(`${where}.exchanges : au moins 1 appel`);
  const kept = need('kept');
  if (kept > 1) throw new RafError(`${where}.kept : une part entre 0 et 1`);
  const repeat = s.repeat === undefined ? 1 : nonNegative(`${where}.repeat`, s.repeat, true);
  if (repeat < 1) throw new RafError(`${where}.repeat : au moins 1`);
  if (s.label !== undefined && typeof s.label !== 'string') throw new RafError(`${where}.label : texte attendu`);
  return {
    ...(s.label !== undefined ? { label: s.label } : {}),
    exchanges,
    base: continues && s.base === undefined ? 0 : need('base'),
    growth: need('growth'),
    output: need('output'),
    kept,
    continues,
    repeat,
  };
}

/** Lit et valide un déroulé (objet issu d'un JSON ou d'un YAML) ; une clé inconnue ou une valeur hors bornes refuse tout le fichier. */
export function readRollout(raw: unknown): Rollout {
  if (!isObject(raw)) throw new RafError(`déroulé : objet attendu { ${ROLLOUT_KEYS.join(', ')} }`);
  refuseUnknown('déroulé', raw, ROLLOUT_KEYS);
  if (typeof raw.model !== 'string' || raw.model.trim() === '') throw new RafError('déroulé.model : nom du modèle attendu (celui de perf.prices)');
  let prices: ModelPrice | undefined;
  if (raw.prices !== undefined) {
    if (!isObject(raw.prices)) throw new RafError(`déroulé.prices : objet attendu { ${PRICE_KEYS.join(', ')} }`);
    refuseUnknown('déroulé.prices', raw.prices, PRICE_KEYS);
    const p = raw.prices;
    prices = { input: nonNegative('déroulé.prices.input', p.input), output: nonNegative('déroulé.prices.output', p.output), cacheRead: nonNegative('déroulé.prices.cacheRead', p.cacheRead) };
  }
  const cacheWriteFactor = raw.cacheWriteFactor === undefined ? DEFAULT_CACHE_WRITE_FACTOR : nonNegative('déroulé.cacheWriteFactor', raw.cacheWriteFactor);
  const defaults = raw.defaults === undefined ? {} : raw.defaults;
  if (!isObject(defaults)) throw new RafError('déroulé.defaults : objet attendu (les clés d\'une session)');
  refuseUnknown('déroulé.defaults', defaults, SESSION_KEYS);
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) throw new RafError('déroulé.sessions : liste non vide attendue');
  const sessions = raw.sessions.map((s, i) => readSession(`déroulé.sessions[${i}]`, s, defaults, i === 0));
  return { model: raw.model.trim(), ...(prices ? { prices } : {}), cacheWriteFactor, sessions };
}

/** Le prix du déroulé : le sien s'il en déclare un, sinon celui de son modèle dans la grille `perf.prices`. */
export function rolloutPrice(r: Rollout, grid: PriceGrid | null): ModelPrice {
  if (r.prices) return r.prices;
  if (grid && Object.hasOwn(grid, r.model)) return grid[r.model];
  throw new RafError(`modèle sans prix : ${r.model} (déclarer perf.prices.${r.model} dans cadence.yaml, ou prices dans le déroulé)`);
}

/**
 * Le coût d'un déroulé. Pour une session de E appels qui part d'un contexte C₀ et grossit de g par appel, l'appel i renvoie C₀ + (i−1)·g :
 * le total renvoyé est E·C₀ + g·E(E−1)/2, dont `kept` lu dans le cache (prix cacheRead) et le reste écrit (prix d'entrée × cacheWriteFactor) ;
 * la sortie est E × output. Le contexte laissé est C₀ + E·g, celui que reprend une session `continues`. L'entrée hors cache (une centaine de tokens
 * par session dans les journaux du banc) est négligée.
 */
export function estimateRollout(r: Rollout, price: ModelPrice): RolloutCost {
  const sessions: SessionCost[] = [];
  let previousEnd = 0;
  r.sessions.forEach((s, i) => {
    const tally = { cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
    let start = 0;
    for (let k = 0; k < s.repeat; k++) {
      const c0 = s.continues ? previousEnd : s.base;
      if (k === 0) start = c0;
      const sent = s.exchanges * c0 + (s.growth * s.exchanges * (s.exchanges - 1)) / 2;
      tally.cacheRead += s.kept * sent;
      tally.cacheWrite += (1 - s.kept) * sent;
      tally.output += s.exchanges * s.output;
      previousEnd = c0 + s.exchanges * s.growth;
    }
    tally.cost = (tally.cacheWrite * price.input * r.cacheWriteFactor + tally.cacheRead * price.cacheRead + tally.output * price.output) / 1_000_000;
    sessions.push({ label: s.label ?? `session ${i + 1}`, exchanges: s.exchanges * s.repeat, startContext: start, endContext: previousEnd, ...tally });
  });
  const total = sessions.reduce((t, s) => ({ cacheRead: t.cacheRead + s.cacheRead, cacheWrite: t.cacheWrite + s.cacheWrite, output: t.output + s.output, cost: t.cost + s.cost }), { cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });
  return { model: r.model, price, cacheWriteFactor: r.cacheWriteFactor, sessions, total };
}

const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2).replace('.', ',')} M` : `${Math.round(n / 1000)} k`);

/** Les lignes de `cadence cost` : une par session, puis le total. */
export function renderRolloutCost(c: RolloutCost, currency?: string): string[] {
  const p = c.price;
  const num = (v: number): string => String(v).replace('.', ',');
  const head = `${c.model} : entrée ${num(p.input)}, cache écrit ${num(p.input * c.cacheWriteFactor)} (×${num(c.cacheWriteFactor)}), cache lu ${num(p.cacheRead)}, sortie ${num(p.output)} par million de tokens`;
  const lines = c.sessions.map((s) => `  ${s.label} : ${s.exchanges} appel${s.exchanges > 1 ? 's' : ''}, contexte ${tokens(s.startContext)} → ${tokens(s.endContext)} ; lus ${tokens(s.cacheRead)}, écrits ${tokens(s.cacheWrite)}, sortie ${tokens(s.output)} : ${euros(s.cost, currency)}`);
  const t = c.total;
  return [head, ...lines, `total : ${tokens(t.cacheRead + t.cacheWrite + t.output)} (lus ${tokens(t.cacheRead)}, écrits ${tokens(t.cacheWrite)}, sortie ${tokens(t.output)}) : ${euros(t.cost, currency)} estimés`];
}
