import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { environnementVuParLaSuite, ecrireSonde, PLAYWRIGHT_SONDE, SONDE_VAR } from '../../test/sonde-environnement.js';
import { VARIABLES_SESSION } from '../../test/variables-session.js';

// L715 : la suite v2 ne dépend pas des variables que la session qui la lance pose pour elle-même (setup-home.ts) ;
// les réglages de la suite (CADENCE_PLAYWRIGHT, CADENCE_TEST_*) arrivent aux tests.
const sonde = process.env[SONDE_VAR];
describe('L715 — environnement de la suite v2', () => {
  it.runIf(sonde)('sonde : écrit les CADENCE_* reçues', () => ecrireSonde(sonde!));

  it.skipIf(sonde)('les variables d\'une session sont retirées, CADENCE_PLAYWRIGHT arrive aux tests', () => {
    const vu = environnementVuParLaSuite(fileURLToPath(new URL('../vitest.config.ts', import.meta.url)), fileURLToPath(import.meta.url));
    expect(VARIABLES_SESSION.filter((k) => k in vu)).toEqual([]);
    expect(vu.CADENCE_PLAYWRIGHT).toBe(PLAYWRIGHT_SONDE);
  });
});
