import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { cleanupTempDirs, removeDryRunBriefs, tempDir } from './helpers.js';
import { PID_FILE, ROOT_PREFIX, findStaleRoots, leftovers, removeStaleRoots, removeTree } from './tmp-hygiene.js';

describe('dossiers temporaires de la suite (L45)', () => {
  it('la suite travaille dans une racine temporaire privée (globalSetup) que sa fin de run vérifie vide', () => {
    const root = process.env.CADENCE_TEST_TMP_ROOT;
    expect(root).toBeTruthy();
    expect(tmpdir()).toBe(root);
    // os.tmpdir() lit TEMP/TMP sous win32 : les trois variables pointent la racine privée (L45/t3).
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) expect(process.env[name]).toBe(root);
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

  it('findStaleRoots ne désigne que les racines à nous (préfixe + fichier pid) dont le processus est mort (L45/t2)', () => {
    const tmp = tempDir();
    const make = (name: string, pid: string | null): string => {
      const dir = join(tmp, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'reste'), 'x');
      if (pid !== null) writeFileSync(join(dir, PID_FILE), pid);
      return dir;
    };
    const morte = make(`${ROOT_PREFIX}morte`, '111');
    const vivante = make(`${ROOT_PREFIX}vivante`, '222');
    const sansPid = make(`${ROOT_PREFIX}sanspid`, null);
    const pidIllisible = make(`${ROOT_PREFIX}illisible`, 'abc');
    const autrePrefixe = make('autre-morte', '111');
    writeFileSync(join(tmp, `${ROOT_PREFIX}fichier`), 'x'); // un fichier, pas un dossier
    const alive = (pid: number): boolean => pid === 222;
    expect(findStaleRoots(tmp, alive)).toEqual([morte]);
    expect(removeStaleRoots(tmp, alive)).toEqual([morte]);
    expect(existsSync(morte)).toBe(false);
    for (const d of [vivante, sansPid, pidIllisible, autrePrefixe]) expect(existsSync(d)).toBe(true);
    expect(removeStaleRoots(join(tmp, 'inexistant'), alive)).toEqual([]);
  });

  it('globalSetup a écrit le pid de ce processus dans la racine privée, que leftovers ignore', () => {
    const root = process.env.CADENCE_TEST_TMP_ROOT!;
    expect(existsSync(join(root, PID_FILE))).toBe(true);
    expect(leftovers(root)).not.toContain(PID_FILE);
  });

  it('un lien sous la racine vers un dossier extérieur ne fait rien supprimer dehors (L45/t4)', () => {
    const dehors = mkdtempSync(join(realTmpOutsideRoot(), 'cadence-l45-dehors-'));
    try {
      mkdirSync(join(dehors, 'cadence-orchestrate-x'));
      writeFileSync(join(dehors, 'cadence-orchestrate-x', 'b.md'), 'x');
      mkdirSync(join(dehors, 'victime'));
      writeFileSync(join(dehors, 'victime', 'v'), 'x');
      chmodSync(dehors, 0o750);
      const sous = tempDir();
      symlinkSync(dehors, join(sous, 'lien'));
      // Entrée 1 : removeDryRunBriefs, le chemin lu passe par le lien.
      expect(() => removeDryRunBriefs(`    brief : ${join(sous, 'lien', 'cadence-orchestrate-x', 'b.md')}\n`)).toThrow(/hors de la racine/);
      expect(existsSync(join(dehors, 'cadence-orchestrate-x', 'b.md'))).toBe(true);
      // Entrée 2 : removeTree, racine par défaut puis racine explicite (cas d'une racine périmée).
      expect(() => removeTree(join(sous, 'lien', 'victime'))).toThrow(/hors de la racine/);
      expect(() => removeTree(join(sous, 'lien', 'victime'), sous)).toThrow(/hors de la racine/);
      expect(existsSync(join(dehors, 'victime', 'v'))).toBe(true);
      // Le lien lui-même est supprimé comme un lien ; ce qu'il désigne reste intact (droits compris).
      removeTree(sous);
      expect(existsSync(sous)).toBe(false);
      expect(existsSync(join(dehors, 'victime', 'v'))).toBe(true);
      expect(statSync(dehors).mode & 0o777).toBe(0o750);
    } finally {
      rmSync(dehors, { recursive: true, force: true });
    }
  });

  it('removeTree sur un lien de la racine ne supprime que le lien (L45/t4)', () => {
    const dehors = mkdtempSync(join(realTmpOutsideRoot(), 'cadence-l45-dehors-'));
    try {
      writeFileSync(join(dehors, 'v'), 'x');
      const lien = join(tempDir(), 'cadence-orchestrate-lien');
      symlinkSync(dehors, lien);
      removeDryRunBriefs(`    brief : ${join(lien, 'b.md')}\n`);
      expect(existsSync(lien)).toBe(false);
      expect(existsSync(join(dehors, 'v'))).toBe(true);
    } finally {
      rmSync(dehors, { recursive: true, force: true });
    }
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
