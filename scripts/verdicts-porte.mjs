// Les verdicts de la porte par sha (L426), dans l'état partagé du dépôt : `.git/cadence/gate-verdicts.json`, commun à tous les worktrees.
// Écrits par `cadence verify --gate` (src/verify-gate.ts) et, depuis L786, par la porte complète de `cadence run` (v2/src/run/run.ts) ; lus par le
// hook pre-push (src/push-guard.ts). Un seul code pour les trois : un verdict qu'une porte écrit, le hook le lit (le 19-11, le sha qu'un run venait
// d'intégrer, porte verte jouée, était refusé au push « aucun verdict de la porte pour ce sha »).
// JavaScript sans dépendance, comme scripts/regeneration.mjs : src et v2 l'importent hors de leur rootDir.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FICHIER = 'gate-verdicts.json';
/** Verdicts gardés : les plus récents ; un push ne porte que des shas récents. */
const GARDES = 200;

/** Le dossier partagé de cadence dans le dépôt (`<git-common-dir>/cadence`), créé au besoin. */
function dossierPartage(depot) {
  const commun = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: depot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const d = join(resolve(depot, commun), 'cadence');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Tout le fichier ; absent ou illisible (écriture coupée, édition à la main), il vaut « aucun verdict ». */
function lireTout(depot) {
  const f = join(dossierPartage(depot), FICHIER);
  if (!existsSync(f)) return {};
  try {
    const brut = JSON.parse(readFileSync(f, 'utf8'));
    if (brut === null || typeof brut !== 'object' || Array.isArray(brut)) return {};
    const tout = {};
    for (const [sha, v] of Object.entries(brut)) {
      const { code, at } = v ?? {};
      if ((code === 0 || code === 1) && typeof at === 'string') tout[sha] = { code, at };
    }
    return tout;
  } catch {
    return {};
  }
}

/**
 * Note le verdict de la porte pour `sha` (0 vert, 1 rouge) à l'instant `at` (Date). Le dernier verdict d'un sha remplace le précédent ; au-delà de
 * `GARDES` shas, les plus anciens partent. Écriture atomique (fichier voisin renommé).
 */
export function noterVerdict(depot, sha, code, at) {
  const tout = lireTout(depot);
  delete tout[sha]; // réinséré en dernier : l'ordre des clés est celui des écritures
  tout[sha] = { code, at: at.toISOString() };
  const garde = Object.fromEntries(Object.entries(tout).slice(-GARDES));
  const f = join(dossierPartage(depot), FICHIER);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(garde, null, 2)}\n`);
  renameSync(tmp, f);
}

/** Le dernier verdict noté pour `sha` ({ code, at }) ; null si aucune porte n'en a rendu pour ce sha. */
export function verdictPour(depot, sha) {
  return lireTout(depot)[sha] ?? null;
}
