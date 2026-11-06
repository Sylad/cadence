import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { briefFor } from '../src/orchestrate/cycle/brief.js';
import { commitFile, git, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L648 : le brief fix liste les lignes de doc et d'aide qui citent les identifiants que le travail du lot change.

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

/** Un dépôt avec une doc qui cite `oldName` et une option `--block`, puis un commit du lot L1 qui renomme `oldName` ; `docTouched` : le lot met aussi la doc à jour. */
function lot(docTouched: boolean) {
  const h = harness();
  const c = Object.assign(h.lot('L1', {}, { test: 'true' }), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  briefed.push(() => h.store.removeTmpDir(c.lot.project, c.lot.lot));
  mkdirSync(join(h.repo, 'src'));
  mkdirSync(join(h.repo, 'docs'));
  writeFileSync(join(h.repo, 'src/lib.ts'), 'export function oldName(): number {\n  return 1;\n}\n');
  writeFileSync(join(h.repo, 'docs/page.md'), 'Voir `oldName` pour le détail.\nUne autre ligne.\n');
  git(h.repo, 'add', '--', 'src/lib.ts', 'docs/page.md');
  git(h.repo, 'commit', '-q', '-m', 'chore: base', '--', 'src/lib.ts', 'docs/page.md');
  writeFileSync(join(h.repo, 'src/lib.ts'), 'export function newName(): number {\n  return 1;\n}\n');
  const paths = ['src/lib.ts'];
  if (docTouched) {
    writeFileSync(join(h.repo, 'docs/page.md'), 'Voir `newName` pour le détail.\nUne autre ligne.\n');
    paths.push('docs/page.md');
  }
  git(h.repo, 'add', '--', ...paths);
  git(h.repo, 'commit', '-q', '-m', 'feat(L1): renomme', '--', ...paths);
  return { h, c };
}

describe('L648 — le brief fix liste la doc qui cite les identifiants changés', () => {
  it('R10 — fix : la ligne de doc qui cite l’identifiant retiré est listée avec son fichier et sa ligne', () => {
    const { c } = lot(false);
    const brief = briefFor(c, 'fix');
    expect(brief).toContain('`docs/page.md:1` cites `oldName`');
    expect(brief).toContain('hook.docs');
    expect(brief).not.toContain('docs/page.md:2');
  });
  it('R10 — une doc que le lot a déjà mise à jour n’est pas listée', () => {
    const { c } = lot(true);
    expect(briefFor(c, 'fix')).not.toContain('cites `');
  });
  it('R10 — implement et review ne reçoivent pas la liste', () => {
    const { c } = lot(false);
    expect(briefFor(c, 'implement')).not.toContain('cites `oldName`');
    expect(briefFor(c, 'review')).not.toContain('cites `oldName`');
  });
  it('R10 — un lot sans commit : pas de liste, pas d’erreur', () => {
    const h = harness();
    const c = Object.assign(h.lot('L1', {}, { test: 'true' }), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
    briefed.push(() => h.store.removeTmpDir(c.lot.project, c.lot.lot));
    commitFile(h.repo, 'a.txt', 'chore: autre');
    expect(briefFor(c, 'fix')).not.toContain('cites `');
  });
});
