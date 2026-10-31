import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Les fichiers de src/ (hors ref/ et spec.ts) dont L483 a retiré « export » des symboles jamais importés. */
const FICHIERS = [
  'articles', 'audit', 'check', 'clean', 'config-set', 'config', 'corrections', 'dates', 'deliver', 'gantt',
  'gate-record', 'git', 'hud-context', 'lead', 'link', 'migrate', 'news', 'perf', 'plan-commit', 'plan',
  'priority', 'proc', 'release', 'resources', 'skills', 'stale-notes', 'state', 'verify-gate', 'verify',
].map((f) => `src/${f}.ts`);

interface Probleme { file: string; exports?: unknown[]; types?: unknown[] }

describe('L483 — A1 : « export » retiré des symboles de src/ jamais importés', () => {
  it('A1 — knip ne trouve plus aucun export ni type inutilisé dans les fichiers nettoyés', () => {
    const r = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--reporter', 'json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const issues = (JSON.parse(r.stdout) as { issues: Probleme[] }).issues;
    const restes = issues.filter((i) => FICHIERS.includes(i.file) && ((i.exports?.length ?? 0) + (i.types?.length ?? 0)) > 0);
    expect(restes.map((i) => i.file)).toEqual([]);
  }, 60_000);

  it('A1 — le cliquet ne garde plus aucune ligne knip exports/types pour ces fichiers (il a baissé)', () => {
    const base = JSON.parse(readFileSync(`${REPO}qualite-baseline.json`, 'utf8')) as Record<string, number>;
    const gardees = Object.keys(base).filter((k) => FICHIERS.some((f) => k.startsWith(`knip|${f}|`)));
    expect(gardees).toEqual([]);
  });
});
