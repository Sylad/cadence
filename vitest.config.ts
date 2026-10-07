import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    // plugins/ : mods Claude Code, testés par `claude plugin test`, pas par vitest
    exclude: [...configDefaults.exclude, 'plugins/**'],
  },
});
