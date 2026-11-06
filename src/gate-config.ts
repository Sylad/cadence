import { isAbsolute } from 'node:path';
import type { OrchestrateConfig } from './config.js';

type Gate = NonNullable<OrchestrateConfig['gate']>;

/** Un chemin de test relatif au dépôt, sans « .. » (`gate.readsPlan`). */
const relativeTest = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && !isAbsolute(x) && !x.split(/[\\/]/).includes('..');

type Bad = (what: string) => Error;

/** `gate.readsPlan` : true, une liste de chemins de tests, false ou absent (rien d'actif). */
function readsPlanOf(r: unknown, bad: Bad, others: boolean): Gate['readsPlan'] {
  if (r === true) return true;
  if (Array.isArray(r) && r.length && r.every(relativeTest)) return r.map((x: string) => x.trim());
  // Sans `host` ni `install`, `gate: {}` ne déclare rien : refusé comme avant.
  if (r === false || (r == null && others)) return undefined;
  throw bad('gate.readsPlan : true, false ou liste de chemins de tests relatifs au dépôt, sans « .. »');
}

/** `gate.host` et `gate.overflow` (`key`) : une destination ssh, sans espace ; une qui commencerait par « - » serait lue par ssh comme une option (-oProxyCommand=…). */
function hostOf(v: unknown, bad: Bad, key: 'host' | 'overflow' = 'host'): string {
  const h = typeof v === 'string' ? v.trim() : '';
  if (!h || /\s/.test(h) || h.startsWith('-')) throw bad(`gate.${key} : destination ssh attendue (une chaîne sans espace, ne commençant pas par « - »)`);
  return h;
}

/** `gate.install` : une commande non vide. */
function installOf(v: unknown, bad: Bad): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('gate.install : commande non vide attendue');
  return v.trim();
}

/** `gate.refs` (L617) : une liste non vide de noms de référence git, chacun sans espace ni « - » initial (git push l'y lirait comme une option). */
function refsOf(v: unknown, bad: Bad): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && !!x.trim() && !/\s/.test(x.trim()) && !x.trim().startsWith('-'))) throw bad('gate.refs : liste de références git attendue (des noms sans espace, ne commençant pas par « - », comme main ou origin/main)');
  return v.map((x: string) => x.trim());
}

/** `gate.maxParallel` (L624) : un entier positif. */
function maxParallelOf(v: unknown, bad: Bad): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad('gate.maxParallel : entier positif attendu (portes simultanées au plus sur l\'hôte)');
  return v;
}

/** Les clés de `gate` autres que `readsPlan`, avec leur lecture. */
const READERS: Record<string, (v: unknown, bad: Bad) => unknown> = {
  host: (v, bad) => hostOf(v, bad),
  overflow: (v, bad) => hostOf(v, bad, 'overflow'),
  install: installOf,
  refs: refsOf,
  maxParallel: maxParallelOf,
};

/**
 * Clé `orchestrate.gate` de cadence.yaml : `readsPlan` (L450), `host`, `overflow` (L639), `install` (L403), `refs` (L617) et `maxParallel` (L624). Rend undefined quand elle ne déclare rien d'actif (`readsPlan: false` seul) ;
 * `host`, `overflow` ou `install` seuls posent la clé sans `readsPlan` : déclarer l'hôte ne vaut pas déclarer que des tests lisent le plan (R11).
 * `bad` fabrique l'erreur de config préfixée (`cadence.yaml : orchestrate.<what>`).
 */
export function readGate(raw: unknown, bad: Bad): Gate | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('gate : objet attendu (gate: { readsPlan: true })');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['readsPlan', 'host', 'overflow', 'install', 'refs', 'maxParallel'].includes(k)) throw bad(`gate.${k} inconnu (attendu : readsPlan, host, overflow, install, refs, maxParallel)`);
  if (o.host != null && o.overflow != null) throw bad('gate.overflow et gate.host déclarés ensemble : garder host (la porte se joue sur l\'hôte) ou overflow (la porte joue en local, puis déborde sur l\'hôte)');
  const readsPlan = readsPlanOf(o.readsPlan, bad, Object.keys(READERS).some((k) => o[k] != null));
  const gate: Gate = readsPlan ? { readsPlan } : {};
  for (const [k, read] of Object.entries(READERS)) if (o[k] != null) Object.assign(gate, { [k]: read(o[k], bad) });
  return Object.keys(gate).length ? gate : undefined;
}
