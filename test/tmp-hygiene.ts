import { chmodSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Refuse (erreur levée, rien de supprimé) tout chemin qui n'est pas DANS `root` (strictement, sauf `allowRoot`).
 * Garde-fou de dernier recours : un chemin mal lu ne doit jamais faire supprimer autre chose que la racine privée.
 */
export function assertInside(path: string, root: string | undefined, allowRoot = false): void {
  if (!root) throw new Error(`Suppression refusée : pas de racine temporaire privée définie (${path}).`);
  const rel = relative(resolve(root), resolve(path));
  const dedans = rel !== '' ? !rel.startsWith('..') && !isAbsolute(rel) : allowRoot;
  if (!dedans) throw new Error(`Suppression refusée : ${path} est hors de la racine temporaire privée ${root}.`);
}

/**
 * Supprime un arbre même quand un test y a laissé un dossier sans droits (chmod 000/311) : on rend
 * les droits de haut en bas avant de lire un dossier, puis on supprime. Un lien n'est jamais suivi.
 */
export function removeTree(path: string, root: string | undefined = process.env.CADENCE_TEST_TMP_ROOT): void {
  assertInside(path, root, true);
  try {
    if (lstatSync(path).isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) removeTree(join(path, name), root);
    }
  } catch {
    // Déjà disparu, ou illisible malgré tout : rmSync ci-dessous dit ce qu'il reste à dire.
  }
  rmSync(path, { recursive: true, force: true });
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
