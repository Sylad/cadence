import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { briefFor } from '../src/orchestrate/cycle/brief.js';
import { programChecks } from '../src/orchestrate/cycle/checks.js';
import { pagesCited, readersOf, readersText, testsReading } from '../src/doc-readers.js';
import { commitFile, git, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L658 : le brief d'un lot qui nomme une page reçoit les tests qui la lisent, et la porte ciblée les joue quand le lot touche la page.

afterEach(cleanupTempDirs);
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});
const briefed: Array<() => void> = [];
afterEach(() => {
  for (const f of briefed.splice(0)) f();
});

/** Un dépôt avec deux pages et des tests qui les lisent (un imbriqué, un qui n'en lit aucune). */
function repo(): string {
  const root = tempDir();
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'test/sub'), { recursive: true });
  writeFileSync(join(root, 'docs/cycle.md'), '# cycle\n');
  writeFileSync(join(root, 'docs/autre.md'), '# autre\n');
  writeFileSync(join(root, 'test/lit-cycle.test.ts'), "read('docs/cycle.md')\n");
  writeFileSync(join(root, 'test/sub/lit-cycle-aussi.test.ts'), "join('docs', 'cycle.md')\n");
  writeFileSync(join(root, 'test/rien.test.ts'), 'expect(1)\n');
  writeFileSync(join(root, 'test/cycle.md.helper.ts'), "'cycle.md'\n"); // pas un test
  return root;
}

describe('L658 — les tests qui lisent une page', () => {
  it('R1 — un test qui cite le nom de la page la lit, imbriqué compris ; un fichier qui n’est pas un test, non', () => {
    const root = repo();
    expect(testsReading(root, ['docs/cycle.md']).get('docs/cycle.md')?.sort()).toEqual(['test/lit-cycle.test.ts', 'test/sub/lit-cycle-aussi.test.ts']);
  });
  it('R1 — page sans lecteur, sans page, sans dossier test : rien', () => {
    const root = repo();
    expect(readersOf(root, ['docs/autre.md'])).toEqual([]);
    expect(readersOf(root, [])).toEqual([]);
    expect(readersOf(tempDir(), ['docs/cycle.md'])).toEqual([]);
  });
  it('R2 — les pages citées par le texte du lot : existantes seulement, nom seul résolu sous docs/, sans doublon', () => {
    const root = repo();
    expect(pagesCited(root, 'vider docs/cycle.md puis cycle.md et ./docs/autre.md ; absente.md')).toEqual(['docs/cycle.md', 'docs/autre.md']);
    expect(pagesCited(root, 'aucune page')).toEqual([]);
  });
  it('R2 — la consigne liste page et tests ; vide quand aucune page citée n’a de lecteur', () => {
    const root = repo();
    expect(readersText(root, 'déplacer une section de docs/cycle.md')).toContain('- `docs/cycle.md`: `test/lit-cycle.test.ts`, `test/sub/lit-cycle-aussi.test.ts`');
    expect(readersText(root, 'docs/autre.md')).toBe('');
  });
});

function lot(goal: string) {
  const log = join(tempDir(), 'portes.log');
  const h = harness();
  const config = { test: 'true', testRelated: `echo "REL {files}" >> ${log}; true` };
  const c = Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  c.lot.goal = goal;
  briefed.push(() => h.store.removeTmpDir(c.lot.project, c.lot.lot));
  mkdirSync(join(h.repo, 'docs'));
  mkdirSync(join(h.repo, 'test'));
  writeFileSync(join(h.repo, 'test/lit.test.ts'), "read('docs/cycle.md')\n");
  git(h.repo, 'add', '--', 'test/lit.test.ts');
  git(h.repo, 'commit', '-q', '-m', 'test: lit', '--', 'test/lit.test.ts');
  return { h, c, log };
}

describe('L658 — brief et porte', () => {
  it('R3 — implement et fix reçoivent les tests de la page que le lot nomme ; la revue non', () => {
    const { c } = lot('vider docs/cycle.md');
    commitFile(c.tree!.dir, 'docs/cycle.md', 'docs: cycle');
    for (const kind of ['implement', 'fix'] as const) expect(briefFor(c, kind), kind).toContain('`test/lit.test.ts`');
    expect(briefFor(c, 'review')).not.toContain('test/lit.test.ts');
  });
  it('R3 — un lot qui ne nomme aucune page : pas de consigne', () => {
    const { c } = lot('corriger un message');
    expect(briefFor(c, 'implement')).not.toContain('Tests that read a page');
  });
  it('R4 — la porte ciblée joue le test d’un autre lot qui lit la page que le lot touche', async () => {
    const { h, c, log } = lot('x');
    for (const f of ['a.txt', 'docs/cycle.md']) commitFile(h.repo, f, 'feat(L1): x');
    await programChecks(c, [], []);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n').at(-1)).toContain('test/lit.test.ts');
  });
  it('R4 — un lot qui ne touche aucune page .md ne rejoue pas ce test', async () => {
    const { h, c, log } = lot('x');
    commitFile(h.repo, 'a.txt', 'feat(L1): x');
    await programChecks(c, [], []);
    expect(readFileSync(log, 'utf8')).not.toContain('test/lit.test.ts');
  });
});
