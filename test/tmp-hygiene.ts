import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Supprime un arbre même quand un test y a laissé un dossier sans droits (chmod 000/311) : on rend
 * les droits de haut en bas avant de lire un dossier, puis on supprime. Un lien n'est jamais suivi.
 */
export function removeTree(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) removeTree(join(path, name));
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
