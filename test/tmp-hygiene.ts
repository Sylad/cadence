import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
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

/** Ce qui reste dans la racine temporaire privée de la suite : doit être vide en fin de run. */
export function leftovers(root: string): string[] {
  try {
    return readdirSync(root).sort();
  } catch {
    return [];
  }
}
