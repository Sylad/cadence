import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const FICHIERS = [
  'ref/add', 'ref/analyse', 'ref/corpus-render', 'ref/coverage', 'ref/diff', 'ref/evaluate', 'ref/figures', 'ref/measure',
  'ref/pdf', 'ref/regard', 'ref/session', 'ref/store', 'ref/tools',
].map((f) => `src/${f}.ts`).concat([
  'accept-helpers', 'fake-app', 'orchestrate-harness', 'orchestrate-worktree-harness', 'path-hygiene', 'ref-fixture', 'spec-helpers', 'tmp-hygiene',
].map((f) => `test/${f}.ts`));

interface Probleme { file: string; exports?: unknown[]; types?: unknown[] }

describe('L484 — A2 : « export » retiré des symboles de src/ref/ et test/ jamais importés', () => {
  it('A2 — knip ne trouve plus aucun export ni type inutilisé dans les fichiers nettoyés', () => {
    const r = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--reporter', 'json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const issues = (JSON.parse(r.stdout) as { issues: Probleme[] }).issues;
    const restes = issues.filter((i) => FICHIERS.includes(i.file) && ((i.exports?.length ?? 0) + (i.types?.length ?? 0)) > 0);
    expect(restes.map((i) => i.file)).toEqual([]);
  }, 60_000);

  it('A2 — le type mort Exclusion n’est plus déclaré', () => {
    expect(readFileSync(`${REPO}src/ref/coverage.ts`, 'utf8')).not.toMatch(/\bExclusion\b/);
  });

  it('A2 — le cliquet ne garde plus aucune ligne knip exports/types pour ces fichiers (il a baissé)', () => {
    const base = JSON.parse(readFileSync(`${REPO}qualite-baseline.json`, 'utf8')) as Record<string, number>;
    const gardees = Object.keys(base).filter((k) => FICHIERS.some((f) => k.startsWith(`knip|${f}|`)));
    expect(gardees).toEqual([]);
  });
});
