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

/** `gate.host` : une destination ssh, sans espace ; une qui commencerait par « - » serait lue par ssh comme une option (-oProxyCommand=…). */
function hostOf(v: unknown, bad: Bad): string {
  const h = typeof v === 'string' ? v.trim() : '';
  if (!h || /\s/.test(h) || h.startsWith('-')) throw bad('gate.host : destination ssh attendue (une chaîne sans espace, ne commençant pas par « - »)');
  return h;
}

/** `gate.install` : une commande non vide. */
function installOf(v: unknown, bad: Bad): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('gate.install : commande non vide attendue');
  return v.trim();
}

/**
 * Clé `orchestrate.gate` de cadence.yaml : `readsPlan` (L450), `host` et `install` (L403). Rend undefined quand elle ne déclare rien d'actif (`readsPlan: false` seul) ;
 * `host` ou `install` seuls posent la clé sans `readsPlan` : déclarer l'hôte ne vaut pas déclarer que des tests lisent le plan (R11).
 * `bad` fabrique l'erreur de config préfixée (`cadence.yaml : orchestrate.<what>`).
 */
export function readGate(raw: unknown, bad: Bad): Gate | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('gate : objet attendu (gate: { readsPlan: true })');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['readsPlan', 'host', 'install'].includes(k)) throw bad(`gate.${k} inconnu (attendu : readsPlan, host, install)`);
  const readsPlan = readsPlanOf(o.readsPlan, bad, o.host != null || o.install != null);
  const gate: Gate = {
    ...(readsPlan ? { readsPlan } : {}),
    ...(o.host != null ? { host: hostOf(o.host, bad) } : {}),
    ...(o.install != null ? { install: installOf(o.install, bad) } : {}),
  };
  return Object.keys(gate).length ? gate : undefined;
}
