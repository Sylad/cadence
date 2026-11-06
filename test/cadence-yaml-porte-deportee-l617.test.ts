import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOrchestrateConfig } from '../src/config.js';

const yaml = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence.yaml');

describe('L640 — la porte de cadence revient en local (orchestrate.gate absent de cadence.yaml)', () => {
  it('R1 — cadence.yaml ne déclare pas orchestrate.gate, et la configuration se lit sans refus', () => {
    expect(readOrchestrateConfig(yaml).gate).toBeUndefined();
  });

  it('R2 — les commandes de porte de main restent inchangées (test et build)', () => {
    const o = readOrchestrateConfig(yaml);
    expect(o.test).toBe('npx vitest run');
    expect(o.build).toBe('npx tsc --noEmit && node scripts/qualite.mjs --contre main');
  });
});
