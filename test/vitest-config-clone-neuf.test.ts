import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFromFile, transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';

// L445 : plugins/cadence-hud/tsconfig.json étend .claude-plugin/types/tsconfig.json, écrit par Claude Code au chargement du mod
// et non versionné : absent d'un git clone neuf (CI publish.yml). Vite lit ce tsconfig pour chaque .ts qu'il transforme.
describe('L445 — la suite ne dépend pas des types générés du mod', () => {
  it('L445 — un .ts dont le tsconfig étend un fichier absent se transforme avec la config vitest du projet', async () => {
    const mod = tempDir();
    mkdirSync(join(mod, 'hooks'));
    writeFileSync(join(mod, 'tsconfig.json'), JSON.stringify({ extends: './.claude-plugin/types/tsconfig.json' }));
    writeFileSync(join(mod, 'hooks', 'a.ts'), 'export const a: number = 1');

    const chargée = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(process.cwd(), 'vitest.config.ts'));
    const out = await transformWithEsbuild('export const a: number = 1', join(mod, 'hooks', 'a.ts'), chargée?.config.esbuild || {});
    expect(out.code).toContain('const a = 1');
  });
});
