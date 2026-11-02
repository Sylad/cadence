import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readYamlFile, readYamlKey } from '../src/yaml-keys.js';
import { RafError } from '../src/plan.js';
import { tempDir } from './helpers.js';

describe('L487 — lecture commune du cadence.yaml', () => {
  it('fichier absent : undefined, pour le document comme pour la clé', () => {
    const file = join(tempDir(), 'cadence.yaml');
    expect(readYamlFile(file)).toBeUndefined();
    expect(readYamlKey(file, 'perf')).toBeUndefined();
  });

  it('fichier vide : le document vaut null et la clé undefined', () => {
    const file = join(tempDir(), 'cadence.yaml');
    writeFileSync(file, '');
    expect(readYamlFile(file)).toBeNull();
    expect(readYamlKey(file, 'perf')).toBeUndefined();
  });

  it('document qui n\'est pas une table (liste, texte) : la clé est undefined', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'liste.yaml'), '- a\n- b\n');
    writeFileSync(join(dir, 'texte.yaml'), 'seulement du texte\n');
    expect(readYamlKey(join(dir, 'liste.yaml'), 'perf')).toBeUndefined();
    expect(readYamlKey(join(dir, 'texte.yaml'), 'perf')).toBeUndefined();
  });

  it('la clé présente rend sa valeur, la clé à null reste null', () => {
    const file = join(tempDir(), 'cadence.yaml');
    writeFileSync(file, 'depth: 3\nperf:\nautre: [1]\n');
    expect(readYamlKey(file, 'depth')).toBe(3);
    expect(readYamlKey(file, 'perf')).toBeNull();
    expect(readYamlKey(file, 'absente')).toBeUndefined();
  });

  it('yaml illisible : RafError « <fichier> illisible : <première ligne> »', () => {
    const file = join(tempDir(), 'cadence.yaml');
    writeFileSync(file, 'a: [oups\n');
    expect(() => readYamlFile(file)).toThrow(RafError);
    expect(() => readYamlKey(file, 'a')).toThrow(new RegExp(`^${file.replace(/[/.]/g, '\\$&')} illisible : [^\\n]+$`));
  });

  it('un dossier nommé comme le fichier : RafError « illisible », pas undefined', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'cadence.yaml'));
    expect(() => readYamlFile(join(dir, 'cadence.yaml'))).toThrow(RafError);
  });
});
