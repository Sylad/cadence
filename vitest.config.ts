import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // L150 : 5 s (défaut) ne tient pas quand une autre suite ou une livraison occupe la machine (un test lance des dépôts git et des sessions simulées).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    // plugins/ : mods Claude Code, testés par `claude plugin test`, pas par vitest
    exclude: [...configDefaults.exclude, 'plugins/**'],
  },
});
