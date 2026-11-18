import { tempDir } from './helpers.js';

const NOMS = ['TMPDIR', 'TEMP', 'TMP'] as const;

/**
 * L778 (correctif de publication) : joue `lancer` avec un dossier `tempDir()` pour dossier temporaire, et rend ce dossier avec le résultat.
 * Playwright crée `playwright-artifacts-*` et `playwright_chromiumdev_profile-*` dans `os.tmpdir()` au lancement de Chromium, et
 * `lancerNavigateur` y crée son `cadence-sondes-*` : lancés ainsi, ces dossiers vivent sous un dossier que la fin du fichier de test retire
 * (cleanupTempDirs), même si la fermeture du navigateur n'a pas fini — la suite ne laisse rien dans sa racine temporaire (global-setup.ts).
 */
export async function sousTempDir<T>(lancer: () => Promise<T>): Promise<{ rendu: T; dossier: string }> {
  const dossier = tempDir();
  const avant = Object.fromEntries(NOMS.map((n) => [n, process.env[n]]));
  for (const n of NOMS) process.env[n] = dossier;
  try {
    return { rendu: await lancer(), dossier };
  } finally {
    for (const n of NOMS) {
      if (avant[n] === undefined) delete process.env[n];
      else process.env[n] = avant[n];
    }
  }
}
