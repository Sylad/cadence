import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { environnementVuParLaSuite, ecrireSonde, PLAYWRIGHT_SONDE, SONDE_VAR } from './sonde-environnement.js';
import { VARIABLES_SESSION } from './variables-session.js';

// L715 : la suite ne dépend pas des variables que la session qui la lance pose pour elle-même (setup-env.ts) ;
// les réglages de la suite (CADENCE_PLAYWRIGHT de la CI, CADENCE_TEST_*) arrivent aux tests.
const sonde = process.env[SONDE_VAR];
describe('L715 — environnement de la suite', () => {
  it.runIf(sonde)('sonde : écrit les CADENCE_* reçues', () => ecrireSonde(sonde!));

  it.skipIf(sonde)('les variables d\'une session sont retirées, CADENCE_PLAYWRIGHT arrive aux tests', () => {
    const vu = environnementVuParLaSuite(fileURLToPath(new URL('../vitest.config.ts', import.meta.url)), fileURLToPath(import.meta.url));
    expect(VARIABLES_SESSION.filter((k) => k in vu)).toEqual([]);
    expect(vu.CADENCE_PLAYWRIGHT).toBe(PLAYWRIGHT_SONDE);
  });
});
