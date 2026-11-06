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

  it('R14 — gate: {dir: x} refusé comme clé inconnue, les clés acceptées sont readsPlan, host, install et refs', () => {
    expect(cfg('    dir: x\n')).toThrow(/gate\.dir inconnu \(attendu : readsPlan, host, overflow, install, refs, maxParallel\)/);
    expect(cfg('    host: m\n    install: npm ci\n    readsPlan: true\n    refs: [main]\n')().gate).toEqual({ host: 'm', install: 'npm ci', readsPlan: true, refs: ['main'] });
  });

  it('L617 R4 — gate.refs : une liste non vide de noms de référence sans espace ni « - » initial, sinon refusée', () => {
    for (const v of ['[]', '""', '[""]', '["a b"]', '["-x"]', '[1]', 'main']) expect(cfg(`    host: m\n    refs: ${v}\n`), v).toThrow(/orchestrate\.gate\.refs : liste de références git attendue/);
    expect(cfg('    host: m\n    refs: [main, origin/main]\n')().gate?.refs).toEqual(['main', 'origin/main']);
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
