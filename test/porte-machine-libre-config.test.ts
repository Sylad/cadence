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

describe('L639 — orchestrate.gate.overflow (lecture de la config)', () => {
  it('R12 — host et overflow ensemble : la lecture lève le message exact', () => {
    expect(cfg('    host: box\n    overflow: mini-blue\n')).toThrow(
      'cadence.yaml : orchestrate.gate.overflow et gate.host déclarés ensemble : garder host (la porte se joue sur l\'hôte) ou overflow (la porte joue en local, puis déborde sur l\'hôte)',
    );
  });

  it('R12 — overflow seul : la lecture réussit et rend overflow', () => {
    expect(cfg('    overflow: mini-blue\n')().gate?.overflow).toBe('mini-blue');
  });

  it('R12 — host seul : la lecture est inchangée', () => {
    expect(cfg('    host: box\n')().gate).toEqual({ host: 'box' });
  });

  it.each(['""', '"a b"', '"-oProxyCommand=x"', '12', '[a]'])('R13 — overflow %s refusé avec le message exact', (v) => {
    expect(cfg(`    overflow: ${v}\n`), v).toThrow('cadence.yaml : orchestrate.gate.overflow : destination ssh attendue (une chaîne sans espace, ne commençant pas par « - »)');
  });

  it('R13 — overflow seul : gate posée sans readsPlan', () => {
    expect(cfg('    overflow: mini-blue\n')().gate).toEqual({ overflow: 'mini-blue' });
  });

  it('R13 — la clé inconnue nomme overflow parmi les clés attendues', () => {
    expect(cfg('    overflow: m\n    dir: x\n')).toThrow('cadence.yaml : orchestrate.gate.dir inconnu (attendu : readsPlan, host, overflow, install, refs, maxParallel)');
  });

  it('R13 — install, refs et maxParallel se lisent à côté de overflow', () => {
    expect(cfg('    overflow: m\n    install: npm ci\n    maxParallel: 3\n    refs: [main]\n')().gate).toEqual({ overflow: 'm', install: 'npm ci', maxParallel: 3, refs: ['main'] });
  });
});
