import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookConfig, readMigrateConfig, readNewsConfig, readOrchestrateConfig, readReferencesConfig, readSessionConfig, readVerifyConfig, readDocsConfig, readPlanConfig } from '../src/config.js';
import { readPerfConfig } from '../src/perf-config.js';
import { findLeadDir, readDepth } from '../src/lead.js';
import { readPriority } from '../src/orchestrate/continue.js';
import { readResources } from '../src/resources.js';
import { RafError } from '../src/plan.js';
import { tempDir } from './helpers.js';

const yamlIn = (content?: string) => {
  const dir = tempDir();
  const file = join(dir, 'cadence.yaml');
  if (content !== undefined) writeFileSync(file, content);
  return { dir, file };
};

describe('L487 — bords des appelants de readYamlKey / readYamlFile', () => {
  const lecteurs: [string, (f: string) => unknown, unknown][] = [
    ['news', readNewsConfig, {}],
    ['hook', readHookConfig, {}],
    ['perf', readPerfConfig, null],
    ['session', readSessionConfig, {}],
    ['verify', readVerifyConfig, {}],
    ['references', readReferencesConfig, {}],
    ['migrate', readMigrateConfig, { keep: [] }],
    ['plan', (f) => readPlanConfig(f), null],
    ['priority', (f) => readPriority(join(f, '..')), []],
    ['depth', (f) => readDepth(join(f, '..')), 1],
  ];

  for (const [nom, lire, vide] of lecteurs) {
    it(`${nom} : fichier absent, vide, liste ou texte rendent la valeur par défaut`, () => {
      expect(lire(yamlIn().file)).toEqual(vide);
      expect(lire(yamlIn('').file)).toEqual(vide);
      expect(lire(yamlIn('- a\n- b\n').file)).toEqual(vide);
      expect(lire(yamlIn('juste du texte\n').file)).toEqual(vide);
      expect(lire(yamlIn(`${nom}:\n`).file)).toEqual(vide);
    });
    it(`${nom} : yaml illisible lève RafError « illisible »`, () => {
      const { file } = yamlIn('a: [oups\n');
      expect(() => lire(file)).toThrow(RafError);
      expect(() => lire(file)).toThrow(`${file} illisible :`);
    });
    it(`${nom} : appelé deux fois, même résultat`, () => {
      const { file } = yamlIn(`${nom}: 1\n`);
      const un = () => { try { return lire(file); } catch (e) { return (e as Error).message; } };
      expect(un()).toEqual(un());
    });
  }

  it('orchestrate : fichier absent, vide ou liste rend les défauts', () => {
    const a = readOrchestrateConfig(yamlIn().file);
    expect(readOrchestrateConfig(yamlIn('').file)).toEqual(a);
    expect(readOrchestrateConfig(yamlIn('- x\n').file)).toEqual(a);
    expect(a.timeouts.work).toBe(45 * 60_000);
  });

  it('docs : fichier absent/vide/liste → sync vide ; illisible → RafError', () => {
    expect(readDocsConfig(yamlIn().file).sync).toEqual([]);
    expect(readDocsConfig(yamlIn('').file).sync).toEqual([]);
    expect(readDocsConfig(yamlIn('- x\n').file).sync).toEqual([]);
    const { file } = yamlIn('a: [oups\n');
    expect(() => readDocsConfig(file)).toThrow(`${file} illisible :`);
  });

  it('docs : describedBy refusé avec le message L308', () => {
    expect(() => readDocsConfig(yamlIn('describedBy: x\n').file)).toThrow(/describedBy n'existe plus \(L308\)/);
  });

  it('mauvais type : news en liste, depth en texte, priority vide sont refusés avec le message d\'origine', () => {
    const n = yamlIn('news: [1]\n');
    expect(() => readNewsConfig(n.file)).toThrow(`${n.file} : news doit être un objet { publicTitleMax }`);
    const d = yamlIn('depth: abc\n');
    expect(() => readDepth(d.dir)).toThrow(`${d.file} : depth doit être un entier ≥ 1`);
    const p = yamlIn('priority: []\n');
    expect(() => readPriority(p.dir)).toThrow(`${p.file} : priority doit être une liste de noms de projets`);
  });

  it('un cadence.yaml qui est un dossier : RafError illisible (readYamlFile), pas de crash brut', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'cadence.yaml'));
    expect(() => readNewsConfig(join(dir, 'cadence.yaml'))).toThrow(RafError);
  });

  it('findLeadDir : yaml illisible ou liste est sauté, un lead/priority est trouvé', () => {
    const racine = tempDir();
    writeFileSync(join(racine, 'cadence.yaml'), 'priority: [a]\n');
    const mauvais = join(racine, 'p1');
    mkdirSync(mauvais);
    writeFileSync(join(mauvais, 'cadence.yaml'), 'a: [oups\n');
    const liste = join(mauvais, 'p2');
    mkdirSync(liste);
    writeFileSync(join(liste, 'cadence.yaml'), '- lead\n');
    expect(findLeadDir(liste)).toBe(racine);
  });

  it('findLeadDir : yaml vide ou texte n\'est pas un lead', () => {
    const racine = tempDir();
    writeFileSync(join(racine, 'cadence.yaml'), 'lead: {}\n');
    const sous = join(racine, 's');
    mkdirSync(sous);
    writeFileSync(join(sous, 'cadence.yaml'), '');
    const sous2 = join(sous, 't');
    mkdirSync(sous2);
    writeFileSync(join(sous2, 'cadence.yaml'), 'priority\n');
    expect(findLeadDir(sous2)).toBe(racine);
  });

  it('readResources : cadence.yaml illisible, vide, resources null, resources mal typé', () => {
    const base = tempDir();
    const root = join(base, 'projet', '.cadence');
    mkdirSync(root, { recursive: true });
    const f = join(base, 'cadence.yaml');
    writeFileSync(join(base, 'projet', 'cadence.yaml'), 'a: [oups\n');
    expect(() => readResources(root)).toThrow(`illisible :`);
    writeFileSync(join(base, 'projet', 'cadence.yaml'), 'resources:\n');
    expect(readResources(root).names).toEqual([]);
    writeFileSync(join(base, 'projet', 'cadence.yaml'), 'resources: bob\n');
    expect(() => readResources(root)).toThrow(RafError);
    writeFileSync(join(base, 'projet', 'cadence.yaml'), '- resources\n');
    expect(() => readResources(root)).not.toThrow();
    writeFileSync(f, 'resources: [gpu]\n');
    writeFileSync(join(base, 'projet', 'cadence.yaml'), '');
    expect(() => readResources(root)).not.toThrow();
  });
});
