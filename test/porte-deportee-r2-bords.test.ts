import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** cadence.yaml dont la clé `orchestrate.gate` est le texte donné (YAML, indenté de 4 espaces). */
function cfg(gateYaml: string) {
  const file = join(tempDir(), 'cadence.yaml');
  writeFileSync(file, `orchestrate:\n  test: npx vitest run\n  gate:\n${gateYaml}`);
  return () => readOrchestrateConfig(file);
}

describe('L403 probe — R2/R14/R15/R11 : bords de la lecture de orchestrate.gate', () => {
  it('R2 — host avec une espace insécable ou un saut de ligne au milieu refusé', () => {
    for (const v of ['"a\\u00a0b"', '"a\\nb"', '"a\\tb"']) expect(cfg(`    host: ${v}\n`), v).toThrow(/orchestrate\.gate\.host : destination ssh attendue/);
  });

  it('R2 — host objet ou liste vide refusé, host null traité comme absent avec readsPlan', () => {
    for (const v of ['{a: b}', '[]', '0', 'false']) expect(cfg(`    host: ${v}\n`), v).toThrow(/orchestrate\.gate\.host : destination ssh attendue/);
    expect(cfg('    host: null\n    readsPlan: true\n')().gate).toEqual({ readsPlan: true });
  });

  it('R2 — host « - » seul ou « -- » refusé, un tiret au milieu accepté', () => {
    expect(cfg('    host: "-"\n')).toThrow(/destination ssh attendue/);
    expect(cfg('    host: build-box\n')().gate?.host).toBe('build-box');
  });

  it('R15 — install non chaîne (nombre, liste) refusé avec le message exact', () => {
    for (const v of ['12', '[a]', 'true', '"  "']) expect(cfg(`    host: m\n    install: ${v}\n`), v).toThrow('orchestrate.gate.install : commande non vide attendue');
  });

  it('R14 — gate.dir refusé avec le message des clés connues, même à côté de host', () => {
    expect(cfg('    host: m\n    dir: x\n')).toThrow('orchestrate.gate.dir inconnu (attendu : readsPlan, host, install, refs, maxParallel)');
  });

  it('R11 — gate: {install} seul : config.gate posé sans readsPlan ni host', () => {
    const g = cfg('    install: npm ci\n')().gate;
    expect(g).toEqual({ install: 'npm ci' });
    expect(g).not.toHaveProperty('readsPlan');
  });

  it('R11 — readsPlan: [] avec host reste refusé (liste vide)', () => {
    expect(cfg('    host: m\n    readsPlan: []\n')).toThrow(/gate\.readsPlan : true, false ou liste/);
  });

  it('R11 — readsPlan: false avec host : seul host est posé', () => {
    expect(cfg('    host: m\n    readsPlan: false\n')().gate).toEqual({ host: 'm' });
  });

  it('R11 — readsPlan chaîne avec host refusé (le message readsPlan, pas silencieux)', () => {
    expect(cfg('    host: m\n    readsPlan: yes-please\n')).toThrow(/gate\.readsPlan : true, false ou liste/);
  });
});
