import { RafError } from './plan.js';
import { isObject, readYamlKey } from './yaml-keys.js';

/** Prix d'un modèle, par million de tokens, dans la monnaie de la grille (R7 de L226, L578) ; `cacheWrite` absent vaut `input` × `DEFAULT_CACHE_WRITE_FACTOR` (L704). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

/**
 * Prix d'une écriture de cache par défaut, en multiple du prix d'entrée (L693, L704) : 2 pour le cache d'une heure que les sessions Claude Code écrivent
 * (`ephemeral_1h_input_tokens` de leurs journaux), 1,25 pour celui de cinq minutes. Le banc 2026-11-10-1551 facture l'écriture 8 $/M, 2 × 4 $/M.
 */
const DEFAULT_CACHE_WRITE_FACTOR = 2;

/** Le prix d'une écriture de cache d'un modèle : le sien, sinon l'entrée × `DEFAULT_CACHE_WRITE_FACTOR` (L704). */
export const cacheWritePrice = (p: ModelPrice): number => p.cacheWrite ?? p.input * DEFAULT_CACHE_WRITE_FACTOR;
/** La grille : un prix par nom de modèle, les noms que l'escalade, `@<modèle>` et le journal d'une étape emploient (L578). */
export type PriceGrid = Record<string, ModelPrice>;

/** `perf` de cadence.yaml : la grille (null sans grille) et la monnaie à écrire derrière un montant (absente : aucun symbole). */
export interface PerfConfig {
  prices: PriceGrid | null;
  currency?: string;
  /** Les modèles de la grille sans `cacheWrite`, chiffrés au prix par défaut (L704) : de quoi avertir. */
  defaultCacheWrite?: string[];
}

const PRICE_KEYS = ['input', 'output', 'cacheRead'] as const;
const OPTIONAL_PRICE_KEYS = ['cacheWrite'] as const;
const ALL_PRICE_KEYS: readonly string[] = [...PRICE_KEYS, ...OPTIONAL_PRICE_KEYS];

/** L'avertissement d'une grille dont des modèles n'ont pas de prix d'écriture de cache (L704). */
export const cacheWriteWarning = (models: string[]): string =>
  `perf.prices sans cacheWrite pour ${models.join(', ')} : écriture de cache chiffrée à l'entrée × ${DEFAULT_CACHE_WRITE_FACTOR} (cache d'une heure de Claude Code), déclarer cacheWrite pour la fixer`;

/** Clé `perf` de cadence.yaml : la grille de prix du coût par lot livré et sa monnaie (L578). */
export function readPerfSettings(file: string): PerfConfig {
  const perf = readYamlKey(file, 'perf');
  if (perf == null) return { prices: null };
  if (!isObject(perf)) throw new RafError(`${file} : perf doit être un objet { prices, currency }`);
  for (const k of Object.keys(perf)) if (k !== 'prices' && k !== 'currency') throw new RafError(`${file} : perf.${k} inconnu (attendu : prices, currency)`);
  const currency = readCurrency(file, perf.currency);
  const prices = perf.prices;
  if (prices == null) return { prices: null, ...(currency ? { currency } : {}) };
  if (!isObject(prices)) throw new RafError(`${file} : perf.prices doit être un objet { <modèle>: { ${PRICE_KEYS.join(', ')} } }`);
  const grid = readGrid(file, prices);
  if (Object.keys(grid).length === 0) return { prices: null, ...(currency ? { currency } : {}) };
  const defaulted = Object.keys(prices).filter((m) => !isObject(prices[m]) || (prices[m] as Record<string, unknown>).cacheWrite === undefined);
  return { prices: grid, ...(currency ? { currency } : {}), ...(defaulted.length ? { defaultCacheWrite: defaulted } : {}) };
}

function readGrid(file: string, prices: Record<string, unknown>): PriceGrid {
  const grid: PriceGrid = Object.create(null) as PriceGrid;
  for (const [model, price] of Object.entries(prices)) grid[model] = readModelPrice(file, model, price);
  return grid;
}

function readModelPrice(file: string, model: string, price: unknown): ModelPrice {
  if (!isObject(price)) throw new RafError(`${file} : perf.prices.${model} doit être un objet { ${ALL_PRICE_KEYS.join(', ')} }`);
  for (const k of Object.keys(price)) if (!ALL_PRICE_KEYS.includes(k)) throw new RafError(`${file} : perf.prices.${model}.${k} inconnu (attendu : ${ALL_PRICE_KEYS.join(', ')})`);
  const num = (k: string): number => {
    const v = price[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RafError(`${file} : perf.prices.${model}.${k} : nombre ≥ 0 attendu (par million de tokens)`);
    return v;
  };
  const entry: ModelPrice = { input: num('input'), output: num('output'), cacheRead: num('cacheRead') };
  if (price.cacheWrite !== undefined) entry.cacheWrite = num('cacheWrite');
  return entry;
}

function readCurrency(file: string, v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw new RafError(`${file} : perf.currency : texte non vide attendu (€, $, USD…)`);
  return v.trim();
}

/** La grille seule de `perf.prices` ; null sans grille (clé absente ou vide). */
export function readPerfConfig(file: string): PriceGrid | null {
  return readPerfSettings(file).prices;
}
