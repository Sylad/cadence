import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { tsconfigRaw: '{}' },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup-home.ts'], testTimeout: 30_000 },
});
