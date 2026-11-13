import { describe, expect, it } from 'vitest';

// L715 : la suite ne dépend pas des CADENCE_* de la session qui la lance (setup-env.ts) ; seules restent CADENCE_HOME, posée par le setup, et les CADENCE_TEST_* (réglages de la suite).
describe('L715 — environnement de la suite', () => {
  it('aucune variable CADENCE_* héritée de l\'appelant', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('CADENCE_') && !k.startsWith('CADENCE_TEST_'))).toEqual(['CADENCE_HOME']);
  });
});
