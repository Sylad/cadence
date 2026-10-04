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

/** Ce qui décide qu'une racine est périmée ; injectable pour les tests. */
export interface StaleCheck {
  /** Le processus existe-t-il ? */
  alive?: (pid: number) => boolean;
  /** uid de l'utilisateur courant ; `undefined` (win32, pas de getuid) saute la vérification du propriétaire. */
  uid?: () => number | undefined;
}

/**
 * `dir` est-il une racine d'un run interrompu (Ctrl-C, kill, OOM) que nous pouvons prouver nôtre ? Un vrai dossier
 * (pas un lien) au bon préfixe, appartenant à l'utilisateur courant, portant NOTRE fichier pid (fichier ordinaire),
 * dont le pid désigne un processus mort. Au moindre doute (illisible, absent, autre propriétaire) : non.
 */
export function isStaleRoot(dir: string, check: StaleCheck = {}): boolean {
  const { alive = isProcessAlive, uid = () => process.getuid?.() } = check;
  if (!basename(dir).startsWith(ROOT_PREFIX)) return false;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return false; // un lien n'est pas un dossier pour lstat
    const me = uid();
    if (me !== undefined && st.uid !== me) return false;
    const pidFile = join(dir, PID_FILE);
    if (!lstatSync(pidFile).isFile()) return false;
    const text = readFileSync(pidFile, 'utf8').trim();
    if (!/^\d+$/.test(text)) return false;
    return !alive(Number(text));
  } catch {
    return false; // pas de fichier pid (ou illisible) : pas une racine que nous pouvons prouver nôtre
  }
}

/** Racines périmées (isStaleRoot) directement dans `realTmp`. */
export function findStaleRoots(realTmp: string, check: StaleCheck = {}): string[] {
  let names: string[];
  try {
    names = readdirSync(realTmp);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => join(realTmp, name))
    .filter((dir) => isStaleRoot(dir, check));
}

/**
 * Supprime les racines périmées de findStaleRoots et rend la liste de celles supprimées. Chaque racine est revérifiée
 * juste avant sa suppression, et n'est autorisée que pour elle-même (removeTree(dir, dir)).
 */
export function removeStaleRoots(realTmp: string, check: StaleCheck = {}): string[] {
  const removed: string[] = [];
  for (const dir of findStaleRoots(realTmp, check)) {
    if (!isStaleRoot(dir, check)) continue;
    removeTree(dir, dir);
    removed.push(dir);
  }
  return removed;
}

/** Ce qui reste dans la racine temporaire privée de la suite : doit être vide en fin de run (hors notre fichier pid). */
export function leftovers(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n !== PID_FILE).sort();
  } catch {
    return [];
  }
}
