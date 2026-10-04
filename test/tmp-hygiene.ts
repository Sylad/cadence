import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Chemin RÉEL de `path` s'il est prouvé DANS `root` (strictement, sauf `allowRoot`) ; erreur levée sinon, rien de supprimé.
 * La preuve porte sur les chemins réels, pas sur le texte : le dossier parent de la cible est résolu (liens compris)
 * et doit être dans la racine résolue — un lien entre la racine et la cible ne peut donc pas faire sortir.
 * La cible elle-même n'est pas résolue : si c'est un lien, c'est le lien qu'on supprimera, jamais ce qu'il désigne.
 * Rend `null` quand le parent n'existe pas (rien à supprimer), après le même refus textuel.
 */
export function provenInside(path: string, root: string | undefined, allowRoot = false): string | null {
  if (!root) throw new Error(`Suppression refusée : pas de racine temporaire privée définie (${path}).`);
  const refuse = (): Error => new Error(`Suppression refusée : ${path} est hors de la racine temporaire privée ${root}.`);
  const inside = (r: string, p: string): boolean => {
    const rel = relative(r, p);
    return rel !== '' ? !rel.startsWith('..') && !isAbsolute(rel) : allowRoot;
  };
  const abs = resolve(path);
  if (!inside(resolve(root), abs)) throw refuse();
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = realpathSync(root);
    realParent = realpathSync(dirname(abs));
  } catch {
    return null; // la racine ou le parent n'existe pas : il n'y a rien à supprimer
  }
  const real = join(realParent, basename(abs));
  if (!inside(realRoot, real)) throw refuse();
  return real;
}

/** Refuse (erreur levée, rien de supprimé) tout chemin qui n'est pas prouvé DANS `root` (voir provenInside). */
export function assertInside(path: string, root: string | undefined, allowRoot = false): void {
  provenInside(path, root, allowRoot);
}

/**
 * Supprime un arbre prouvé dans `root`, même quand un test y a laissé un dossier sans droits (chmod 000/311) :
 * on rend les droits de haut en bas avant de lire un dossier, puis on supprime. Aucun lien n'est jamais suivi :
 * la cible est un chemin réel (provenInside), la descente ne lit que des dossiers vus par lstat (un lien n'est
 * pas un dossier pour lstat), et rmSync supprime un lien comme un lien, sans descendre dedans.
 */
export function removeTree(path: string, root: string | undefined = process.env.CADENCE_TEST_TMP_ROOT): void {
  const real = provenInside(path, root, true);
  if (real === null) return;
  restoreRights(real);
  rmSync(real, { recursive: true, force: true });
}

function restoreRights(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return; // fichier, ou lien : jamais suivi
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) restoreRights(join(dir, name));
  } catch {
    // Déjà disparu, ou illisible malgré tout : rmSync dit ce qu'il reste à dire.
  }
}

/** Préfixe des racines privées de la suite, et fichier qui y note le pid du run qui l'a créée. */
export const ROOT_PREFIX = 'cadence-tests-root-';
export const PID_FILE = '.cadence-tests.pid';

/** Le processus `pid` existe-t-il ? EPERM = il existe (à un autre utilisateur) ; ESRCH = mort. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Racines `cadence-tests-root-*` d'un run interrompu (Ctrl-C, kill, OOM) dans `realTmp` : un vrai dossier (pas un lien)
 * au bon préfixe, portant NOTRE fichier pid, dont le pid désigne un processus mort. Sans fichier pid lisible,
 * on n'y touche pas (pas à nous, ou en cours de création).
 */
export function findStaleRoots(realTmp: string, alive: (pid: number) => boolean = isProcessAlive): string[] {
  let names: string[];
  try {
    names = readdirSync(realTmp);
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const dir = join(realTmp, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      const text = readFileSync(join(dir, PID_FILE), 'utf8').trim();
      if (!/^\d+$/.test(text)) continue;
      if (!alive(Number(text))) stale.push(dir);
    } catch {
      // Pas de fichier pid (ou illisible) : ce n'est pas une racine que nous pouvons prouver nôtre.
    }
  }
  return stale;
}

/** Supprime les racines périmées de findStaleRoots et rend leur liste (chaque racine n'est autorisée que pour elle-même). */
export function removeStaleRoots(realTmp: string, alive: (pid: number) => boolean = isProcessAlive): string[] {
  const stale = findStaleRoots(realTmp, alive);
  for (const dir of stale) removeTree(dir, dir);
  return stale;
}

/** Ce qui reste dans la racine temporaire privée de la suite : doit être vide en fin de run (hors notre fichier pid). */
export function leftovers(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n !== PID_FILE).sort();
  } catch {
    return [];
  }
}
