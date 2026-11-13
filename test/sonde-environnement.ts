import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIABLES_SESSION } from './variables-session.js';

// L715 : la sonde relance vitest sur un fichier de test, dans un processus fils, avec la config de la suite (setupFiles compris, sans globalSetup :
// la suite qui joue la sonde a déjà sa racine temporaire) et avec les variables qu'elle pose elle-même. Le fichier, joué en fils (SONDE_VAR posée),
// écrit les CADENCE_* qu'il reçoit. La preuve ne dépend donc pas des variables du shell qui lance la suite.
export const SONDE_VAR = 'CADENCE_TEST_SONDE_L715';
export const PLAYWRIGHT_SONDE = '/sonde-l715/playwright';
const VITEST = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

export function ecrireSonde(fichier: string): void {
  writeFileSync(fichier, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CADENCE_')))));
}

/** Variables CADENCE_* vues par `test` quand la suite décrite par `config` est lancée avec toutes les VARIABLES_SESSION et CADENCE_PLAYWRIGHT posées. */
export function environnementVuParLaSuite(config: string, test: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'sonde-l715-'));
  try {
    const sortie = join(dir, 'env.json'), conf = join(dir, 'vitest.sonde.config.ts');
    writeFileSync(conf, [
      `import base from ${JSON.stringify(config)};`,
      'const { globalSetup: _g, include: _i, exclude: _e, poolOptions: _p, ...test } = base.test;',
      `export default { esbuild: base.esbuild, test: { ...test, root: ${JSON.stringify(join(config, '..'))}, include: [${JSON.stringify(test)}] } };`,
    ].join('\n'));
    const herite = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
    const env = { ...herite, ...Object.fromEntries(VARIABLES_SESSION.map((k) => [k, `herite-${k}`])), CADENCE_PLAYWRIGHT: PLAYWRIGHT_SONDE, [SONDE_VAR]: sortie };
    const r = spawnSync(process.execPath, [VITEST, 'run', '--config', conf, test], { cwd: join(config, '..'), env, encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(`la sonde a échoué (${r.status}) :\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(readFileSync(sortie, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
