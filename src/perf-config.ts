import { RafError } from './plan.js';
import { isObject, readYamlKey } from './yaml-keys.js';

/** Prix d'un modèle, par million de tokens, dans la monnaie de la grille (R7 de L226, L578). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}
/** La grille : un prix par nom de modèle, les noms que l'escalade, `@<modèle>` et le journal d'une étape emploient (L578). */
export type PriceGrid = Record<string, ModelPrice>;

/** `perf` de cadence.yaml : la grille (null sans grille) et la monnaie à écrire derrière un montant (absente : aucun symbole). */
export interface PerfConfig {
  prices: PriceGrid | null;
  currency?: string;
}

const PRICE_KEYS = ['input', 'output', 'cacheRead'] as const;

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
  return { prices: Object.keys(grid).length === 0 ? null : grid, ...(currency ? { currency } : {}) };
}

function readGrid(file: string, prices: Record<string, unknown>): PriceGrid {
  const grid: PriceGrid = Object.create(null) as PriceGrid;
  for (const [model, price] of Object.entries(prices)) grid[model] = readModelPrice(file, model, price);
  return grid;
}

function readModelPrice(file: string, model: string, price: unknown): ModelPrice {
  if (!isObject(price)) throw new RafError(`${file} : perf.prices.${model} doit être un objet { ${PRICE_KEYS.join(', ')} }`);
  for (const k of Object.keys(price)) if (!(PRICE_KEYS as readonly string[]).includes(k)) throw new RafError(`${file} : perf.prices.${model}.${k} inconnu (attendu : ${PRICE_KEYS.join(', ')})`);
  const entry = {} as ModelPrice;
  for (const k of PRICE_KEYS) {
    const v = price[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RafError(`${file} : perf.prices.${model}.${k} : nombre ≥ 0 attendu (par million de tokens)`);
    entry[k] = v;
  }
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
