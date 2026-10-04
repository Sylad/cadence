import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { cleanupTempDirs, removeDryRunBriefs, tempDir } from './helpers.js';
import { leftovers, removeTree } from './tmp-hygiene.js';

describe('dossiers temporaires de la suite (L45)', () => {
  it('la suite travaille dans une racine temporaire privée (globalSetup) que sa fin de run vérifie vide', () => {
    const root = process.env.CADENCE_TEST_TMP_ROOT;
    expect(root).toBeTruthy();
    expect(tmpdir()).toBe(root);
    expect(tempDir().startsWith(`${root}${sep}`)).toBe(true);
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
    const dir = mkdtempSync(join(tempDir(), 'cadence-orchestrate-'));
    writeFileSync(join(dir, 'a--L1--implement.md'), 'x');
    removeDryRunBriefs(`  implement : claude -p\n    brief : ${join(dir, 'a--L1--implement.md')}\n`);
    expect(existsSync(dir)).toBe(false);
  });

  it('removeDryRunBriefs : un chemin temporaire avec espace ne fait supprimer que le dossier des briefs (L45/t1)', () => {
    const base = join(tempDir(), 'Dossier avec espace');
    const briefs = join(base, 'cadence-orchestrate-abc');
    mkdirSync(briefs, { recursive: true });
    writeFileSync(join(briefs, 'a--L1--implement.md'), 'x');
    const canary = join(tempDir(), 'canari');
    writeFileSync(canary, 'vivant');
    const voisin = join(base, 'voisin');
    writeFileSync(voisin, 'vivant');
    removeDryRunBriefs(`  implement : claude -p\n    brief : ${join(briefs, 'a--L1--implement.md')}\n`);
    expect(existsSync(briefs)).toBe(false);
    expect(existsSync(voisin)).toBe(true);
    expect(existsSync(canary)).toBe(true);
  });

  it('removeDryRunBriefs refuse une sortie qui désigne un dossier hors de la racine privée, sans rien supprimer', () => {
    const dehors = mkdtempSync(join(realTmpOutsideRoot(), 'cadence-orchestrate-'));
    try {
      writeFileSync(join(dehors, 'b.md'), 'x');
      expect(() => removeDryRunBriefs(`    brief : ${join(dehors, 'b.md')}\n`)).toThrow(/hors de la racine/);
      expect(existsSync(join(dehors, 'b.md'))).toBe(true);
    } finally {
      rmSync(dehors, { recursive: true, force: true });
    }
  });

  it('removeDryRunBriefs refuse un dossier de la racine qui n\'est pas cadence-orchestrate-*, et la racine elle-même', () => {
    const autre = tempDir();
    writeFileSync(join(autre, 'c.md'), 'x');
    expect(() => removeDryRunBriefs(`    brief : ${join(autre, 'c.md')}\n`)).toThrow(/cadence-orchestrate-/);
    expect(existsSync(autre)).toBe(true);
    const root = process.env.CADENCE_TEST_TMP_ROOT!;
    expect(() => removeDryRunBriefs(`    brief : ${join(root, 'x.md')}\n`)).toThrow();
    expect(existsSync(root)).toBe(true);
  });

  it('removeTree refuse tout chemin hors de la racine privée', () => {
    const dehors = mkdtempSync(join(realTmpOutsideRoot(), 'cadence-hors-'));
    try {
      expect(() => removeTree(dehors)).toThrow(/hors de la racine/);
      expect(existsSync(dehors)).toBe(true);
      expect(() => removeTree(join(tempDir(), '..', '..'))).toThrow();
    } finally {
      rmSync(dehors, { recursive: true, force: true });
    }
  });
});

/** Dossier réel hors de la racine privée (le TMPDIR d'origine, conservé par le globalSetup). */
function realTmpOutsideRoot(): string {
  const real = process.env.CADENCE_TEST_REAL_TMP;
  expect(real).toBeTruthy();
  return real!;
}
