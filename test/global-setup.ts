import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PID_FILE, ROOT_PREFIX, leftovers, removeStaleRoots, removeTree } from './tmp-hygiene.js';

/**
 * Toute la suite travaille dans une racine temporaire PRIVÉE (TMPDIR hérité par les workers et par les
 * processus enfants) : on mesure ainsi ce que CE run laisse, sans être trompé par un autre processus qui
 * écrit dans /tmp au même moment, et sans toucher aux dossiers laissés par les runs précédents.
 * En fin de run, tout ce qui reste est supprimé ET fait échouer la suite, bruyamment : un test qui crée
 * un dossier temporaire sans le nettoyer ne passe plus inaperçu.
 */
export default function setup(): () => void {
  const realTmp = tmpdir();
  // Un run précédent interrompu (Ctrl-C, kill, OOM) a laissé sa racine : on le dit, une ligne, puis on la supprime.
  const stale = removeStaleRoots(realTmp);
  if (stale.length) {
    console.warn(`[tests] ${stale.length} racine(s) temporaire(s) d'un run interrompu supprimée(s) : ${stale.join(', ')}`);
  }
  const root = mkdtempSync(join(realTmp, ROOT_PREFIX));
  writeFileSync(join(root, PID_FILE), String(process.pid));
  // os.tmpdir() lit TMPDIR sous POSIX mais TEMP puis TMP sous win32 : on pose les trois.
  const names = ['TMPDIR', 'TEMP', 'TMP'] as const;
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = root;
  process.env.CADENCE_TEST_TMP_ROOT = root;
  process.env.CADENCE_TEST_REAL_TMP = realTmp;
  return () => {
    for (const n of names) {
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
    }
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
