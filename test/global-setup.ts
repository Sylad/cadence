import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leftovers, removeTree } from './tmp-hygiene.js';

/**
 * Toute la suite travaille dans une racine temporaire PRIVÉE (TMPDIR hérité par les workers et par les
 * processus enfants) : on mesure ainsi ce que CE run laisse, sans être trompé par un autre processus qui
 * écrit dans /tmp au même moment, et sans toucher aux dossiers laissés par les runs précédents.
 * En fin de run, tout ce qui reste est supprimé ET fait échouer la suite, bruyamment : un test qui crée
 * un dossier temporaire sans le nettoyer ne passe plus inaperçu.
 */
export default function setup(): () => void {
  const realTmp = tmpdir();
  const root = mkdtempSync(join(realTmp, 'cadence-tests-root-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  process.env.CADENCE_TEST_TMP_ROOT = root;
  process.env.CADENCE_TEST_REAL_TMP = realTmp;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    const left = leftovers(root);
    removeTree(root);
    if (left.length) {
      throw new Error(
        `La suite laisse ${left.length} dossier(s)/fichier(s) temporaire(s) (supprimés par cette vérification) :\n  ${left.join('\n  ')}\n` +
          'Un test doit créer ses dossiers avec tempDir() (test/helpers.ts) et nettoyer ce que le produit crée ailleurs.',
      );
    }
  };
}
