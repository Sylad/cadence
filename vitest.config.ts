import { configDefaults, defineConfig } from 'vitest/config';

// L350 : la suite de cadence respecte la part de machine que la vague donne à chaque session (CADENCE_TEST_WORKERS) ; sans elle, le défaut de vitest (tous les cœurs).
const workers = Number(process.env.CADENCE_TEST_WORKERS);
const share = Number.isInteger(workers) && workers >= 1 ? workers : undefined;

export default defineConfig({
  test: {
    // minForks/minThreads à 1 : le minimum par défaut de tinypool (cœurs) dépasse la borne et vitest refuse de démarrer.
    poolOptions: share ? { forks: { minForks: 1, maxForks: share }, threads: { minThreads: 1, maxThreads: share } } : {},
    // L150 : 5 s (défaut) ne tient pas quand une autre suite ou une livraison occupe la machine (un test lance des dépôts git et des sessions simulées).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    // plugins/ : mods Claude Code, testés par `claude plugin test`, pas par vitest
    exclude: [...configDefaults.exclude, 'plugins/**'],
  },
});
