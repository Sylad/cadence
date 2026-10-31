import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** cadence.yaml dont la clé `orchestrate.gate` est le texte donné (YAML, indenté de 4 espaces). */
function cfg(gateYaml: string) {
  const dir = tempDir();
  const file = join(dir, 'cadence.yaml');
  writeFileSync(file, `orchestrate:\n  test: npx vitest run\n  gate:\n${gateYaml}`);
  return () => readOrchestrateConfig(file);
}

describe('L403 — orchestrate.gate.host et gate.install (C3)', () => {
  it.each([['-oProxyCommand=x'], ['--help']])('R2 — host « %s » refusé', (host) => {
    expect(cfg(`    host: ${host}\n`)).toThrow('orchestrate.gate.host : destination ssh attendue (une chaîne sans espace, ne commençant pas par « - »)');
  });

  it('R2 — host vide ou avec espace refusé', () => {
    for (const v of ['""', '"a b"', '"  "', '12', 'true', '[a]']) expect(cfg(`    host: ${v}\n`), v).toThrow(/orchestrate\.gate\.host : destination ssh attendue/);
  });

  it('R2 — host « machine » ou « user@machine » accepté', () => {
    expect(cfg('    host: machine\n')().gate?.host).toBe('machine');
    expect(cfg('    host: user@machine\n')().gate?.host).toBe('user@machine');
  });

  it('R14 — gate: {dir: x} refusé comme clé inconnue, les clés acceptées sont readsPlan, host et install', () => {
    expect(cfg('    dir: x\n')).toThrow(/gate\.dir inconnu \(attendu : readsPlan, host, install\)/);
    expect(cfg('    host: m\n    install: npm ci\n    readsPlan: true\n')().gate).toEqual({ host: 'm', install: 'npm ci', readsPlan: true });
  });

  it('R15 — gate.install vide refusé', () => {
    for (const v of ['""', '"  "', '3']) expect(cfg(`    host: m\n    install: ${v}\n`), v).toThrow('cadence.yaml : orchestrate.gate.install : commande non vide attendue');
  });

  it('R11 — gate: {} ou gate sans clé connue reste refusé comme avant', () => {
    expect(cfg('    {}\n')).toThrow(/gate\.readsPlan : true, false ou liste/);
    expect(cfg('    install: npm ci\n')().gate).toEqual({ install: 'npm ci' });
  });

  it('R11 — gate: {host} seul : config.gate est posé sans readsPlan ; gate: {readsPlan: false} ne pose toujours pas config.gate', () => {
    expect(cfg('    host: m\n')().gate).toEqual({ host: 'm' });
    expect(cfg('    readsPlan: false\n')().gate).toBeUndefined();
    expect(cfg('    host: m\n    readsPlan: false\n')().gate).toEqual({ host: 'm' });
  });
});
