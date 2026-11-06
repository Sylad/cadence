import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOrchestrateConfig } from '../src/config.js';

const yaml = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence.yaml');

describe('L661 — la porte de cadence joue en local d\'abord, mini-blue en débordement (orchestrate.gate.overflow)', () => {
  it('R1 — cadence.yaml déclare gate.overflow sur l\'alias mini-blue-wsl, avec install et refs, sans host', () => {
    const gate = readOrchestrateConfig(yaml).gate;
    expect(gate?.overflow).toBe('mini-blue-wsl');
    expect(gate?.install).toBe('npm ci');
    expect(gate?.refs).toEqual(['main', 'origin/main']);
    expect(gate?.host).toBeUndefined();
  });

  it('R2 — les commandes de porte de main restent inchangées (test et build)', () => {
    const o = readOrchestrateConfig(yaml);
    expect(o.test).toBe('npx vitest run');
    expect(o.build).toBe('npx tsc --noEmit && node scripts/qualite.mjs --contre main');
  });
});
