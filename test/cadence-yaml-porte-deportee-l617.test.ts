import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOrchestrateConfig } from '../src/config.js';

const yaml = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence.yaml');

describe('L617 — la porte de cadence se joue sur mini-blue', () => {
  it('R1 — cadence.yaml déclare orchestrate.gate.host sur l\'alias ssh du WSL de mini-blue, et le lit sans refus', () => {
    expect(readOrchestrateConfig(yaml).gate?.host).toBe('mini-blue-wsl');
  });

  it('R3 — gate.install remplit le cache de dépendances sur l\'hôte (sans lui, le lockfile local d\'un autre sha oblige au repli local)', () => {
    expect(readOrchestrateConfig(yaml).gate?.install).toBe('npm ci');
  });

  it('R2 — la porte déclarée garde les commandes de main (la déportation ne change que le lieu)', () => {
    const o = readOrchestrateConfig(yaml);
    expect(o.test).toBe('npx vitest run');
    expect(o.build).toBe('npx tsc --noEmit && node scripts/qualite.mjs --contre main');
  });
});
