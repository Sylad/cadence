import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, removeDryRunBriefs, tempDir } from './helpers.js';
import { leftovers, removeTree } from './tmp-hygiene.js';

describe('dossiers temporaires de la suite (L45)', () => {
  it('la suite travaille dans une racine temporaire privée (globalSetup) que sa fin de run vérifie vide', () => {
    const root = process.env.CADENCE_TEST_TMP_ROOT;
    expect(root).toBeTruthy();
    expect(tmpdir()).toBe(root);
    expect(tempDir().startsWith(`${root}/`)).toBe(true);
  });

  it('cleanupTempDirs supprime les dossiers de tempDir(), même sans droits', () => {
    const a = tempDir();
    const b = tempDir();
    mkdirSync(join(a, 'ferme/dedans'), { recursive: true });
    writeFileSync(join(a, 'ferme/dedans/x'), 'x');
    chmodSync(join(a, 'ferme'), 0o000);
    cleanupTempDirs();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('leftovers voit ce qui reste ; removeTree le supprime', () => {
    const root = mkdtempSync(join(tempDir(), 'racine-'));
    expect(leftovers(root)).toEqual([]);
    mkdirSync(join(root, 'cadence-oublie'));
    expect(leftovers(root)).toEqual(['cadence-oublie']);
    removeTree(join(root, 'cadence-oublie'));
    expect(leftovers(root)).toEqual([]);
    expect(leftovers(join(root, 'inexistant'))).toEqual([]);
  });

  it('removeDryRunBriefs supprime le dossier des briefs nommés dans la sortie de --dry-run', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a--L1--implement.md'), 'x');
    removeDryRunBriefs(`  implement : claude -p\n    brief : ${join(dir, 'a--L1--implement.md')}\n`);
    expect(existsSync(dir)).toBe(false);
  });
});
