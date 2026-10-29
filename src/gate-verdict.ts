import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedStateDir } from './state.js';

/** Le verdict de la porte du projet pour un sha (L426) : 0 vert, 1 rouge. */
export interface GateVerdict {
  code: 0 | 1;
  /** Quand la porte a rendu ce verdict (ISO). */
  at: string;
}

const FILE = 'gate-verdicts.json';
/** Verdicts gardés : les plus récents ; un push ne porte que des shas récents. */
const KEEP = 200;

const file = (repo: string): string => join(sharedStateDir(repo), FILE);

/** Tout le fichier ; absent ou illisible (écriture coupée, édition à la main), il vaut « aucun verdict ». */
function readAll(repo: string): Record<string, GateVerdict> {
  const path = file(repo);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const all: Record<string, GateVerdict> = {};
    for (const [sha, v] of Object.entries(raw)) {
      const { code, at } = v as Partial<GateVerdict>;
      if ((code === 0 || code === 1) && typeof at === 'string') all[sha] = { code, at };
    }
    return all;
  } catch {
    return {};
  }
}

/**
 * Note le verdict de `cadence verify --gate` pour `sha` (L426), dans l'état partagé du dépôt (`.git/cadence/gate-verdicts.json`, commun à tous les worktrees).
 * Le dernier verdict d'un sha remplace le précédent ; au-delà de `KEEP` shas, les plus anciens partent. Écriture atomique (fichier voisin renommé).
 */
export function recordVerdict(repo: string, sha: string, code: 0 | 1, at: Date): void {
  const all = readAll(repo);
  delete all[sha]; // réinséré en dernier : l'ordre des clés est celui des écritures
  all[sha] = { code, at: at.toISOString() };
  const kept = Object.fromEntries(Object.entries(all).slice(-KEEP));
  const path = file(repo);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Le dernier verdict noté pour `sha` ; null si la porte n'a jamais rendu de verdict pour ce sha. */
export function verdictFor(repo: string, sha: string): GateVerdict | null {
  return readAll(repo)[sha] ?? null;
}
