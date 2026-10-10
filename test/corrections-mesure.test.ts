import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measure, readCache, readRuns, renderReport, sampleKeys } from '../src/corrections.js';

const root = resolve(import.meta.dirname, '..');
const runs = join(root, '..', '.cadence', 'runs');
const doc = readFileSync(join(root, 'docs', 'mesures', 'corrections-2026-10-10.md'), 'utf8');

describe('relevé de référence des corrections (L165)', () => {
  it.skipIf(!existsSync(runs))('la commande de reproduction du document en donne la section « Résultats » mot pour mot', () => {
    const until = /^Reproduction : .*--until (\S+?)`? /m.exec(doc)?.[1];
    expect(until).toBeDefined();
    const m = measure(readRuns(runs, until), readCache(join(root, 'docs', 'mesures', 'corrections-classement.json')));
    expect(doc.split('## Résultats\n\n')[1]!.trim()).toBe(renderReport(m).trim());
  });

  it.skipIf(!existsSync(runs))('le cache versionné ne garde aucune cause modèle pour une passe sans revue', () => {
    const until = /^Reproduction : .*--until (\S+?)`? /m.exec(doc)?.[1];
    const cache = readCache(join(root, 'docs', 'mesures', 'corrections-classement.json'));
    const sansRevue = readRuns(runs, until).passes.filter((p) => p.findings.length === 0).map((p) => p.key);
    expect(sansRevue.length).toBeGreaterThan(0);
    expect(sansRevue.filter((k) => cache.has(k))).toEqual([]);
  });

  it.skipIf(!existsSync(runs))("l'échantillon de --sample 24 a été relu en entier et son taux d'accord est celui du document", () => {
    const until = /^Reproduction : .*--until (\S+?)`? /m.exec(doc)?.[1];
    const cache = readCache(join(root, 'docs', 'mesures', 'corrections-classement.json'));
    const keys = sampleKeys(readRuns(runs, until).passes.filter((p) => p.findings.length > 0).map((p) => p.key), 24);
    expect(keys.filter((k) => !cache.get(k)?.manual)).toEqual([]);
    const accord = keys.filter((k) => cache.get(k)!.manual === cache.get(k)!.cause).length;
    expect(doc).toContain(`le modèle est d'accord avec la relecture sur ${accord} passes sur 24 (${Math.round((accord / 24) * 100)} %)`);
  });

  it('le README cite le nombre de lots et le taux à deux corrections du relevé publié', () => {
    const lots = /\*\*(\d+) lots\*\*/.exec(doc)?.[1];
    const un = /(\d+) % des lots ont eu/.exec(doc)?.[1];
    const deux = /(\d+) % au moins deux/.exec(doc)?.[1];
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain(`\`${un} %\` and \`${deux} %\` of ${lots} lots in the 10-10 baseline`);
  });
});
