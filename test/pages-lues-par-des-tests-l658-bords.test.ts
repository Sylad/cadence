import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { programChecks } from '../src/orchestrate/cycle/checks.js';
import { readersOf, readersText } from '../src/doc-readers.js';
import { commitFile, git, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L658 — bords : la liste des tests d'une page ne contient que ceux qui la lisent, et une page supprimée par le lot compte comme touchée.

afterEach(cleanupTempDirs);

describe('L658 bords — page lue', () => {
  it('R1 — le nom d’une autre page qui finit par le même nom (orchestrate-spec.md) ne fait pas de ce test un lecteur de spec.md', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'docs/spec.md'), '# spec\n');
    writeFileSync(join(root, 'docs/orchestrate-spec.md'), '# os\n');
    writeFileSync(join(root, 'test/lit-autre.test.ts'), "read('docs/orchestrate-spec.md')\n");
    expect(readersOf(root, ['docs/spec.md'])).toEqual([]);
    expect(readersText(root, 'vider docs/spec.md')).toBe('');
    expect(readersOf(root, ['docs/orchestrate-spec.md'])).toEqual(['test/lit-autre.test.ts']);
  });
});

describe('L658 bords — porte ciblée', () => {
  it('R4 — un lot qui supprime la page lue par le test d’un autre lot joue ce test', async () => {
    const log = join(tempDir(), 'portes.log');
    const h = harness();
    const config = { test: 'true', testRelated: `echo "REL {files}" >> ${log}; true` };
    const c = Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
    mkdirSync(join(h.repo, 'docs'));
    mkdirSync(join(h.repo, 'test'));
    writeFileSync(join(h.repo, 'test/lit.test.ts'), "read('docs/cycle.md')\n");
    commitFile(h.repo, 'docs/cycle.md', 'docs: cycle');
    git(h.repo, 'add', '--', 'test/lit.test.ts');
    git(h.repo, 'commit', '-q', '-m', 'test: lit', '--', 'test/lit.test.ts');
    commitFile(h.repo, 'a.txt', 'feat(L1): x');
    git(h.repo, 'rm', '-q', '--', 'docs/cycle.md');
    git(h.repo, 'commit', '-q', '-m', 'feat(L1): vider la page', '--', 'docs/cycle.md');
    await programChecks(c, [], []);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('test/lit.test.ts');
  });

  it('R4 — un lot qui déplace la page lue par le test d’un autre lot joue ce test (l’ancien nom compte)', async () => {
    const log = join(tempDir(), 'portes.log');
    const h = harness();
    const config = { test: 'true', testRelated: `echo "REL {files}" >> ${log}; true` };
    const c = Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
    mkdirSync(join(h.repo, 'docs'));
    mkdirSync(join(h.repo, 'test'));
    writeFileSync(join(h.repo, 'test/lit.test.ts'), "read('docs/ancienne.md')\n");
    commitFile(h.repo, 'docs/ancienne.md', 'docs: ancienne');
    git(h.repo, 'add', '--', 'test/lit.test.ts');
    git(h.repo, 'commit', '-q', '-m', 'test: lit', '--', 'test/lit.test.ts');
    commitFile(h.repo, 'a.txt', 'feat(L1): x');
    git(h.repo, 'mv', 'docs/ancienne.md', 'docs/nouvelle.md');
    git(h.repo, 'commit', '-q', '-m', 'feat(L1): déplacer la page', '--', 'docs/ancienne.md', 'docs/nouvelle.md');
    await programChecks(c, [], []);
    expect(readFileSync(log, 'utf8')).toContain('test/lit.test.ts');
  });
});
