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

/** Un dépôt avec une doc qui cite `oldName` et une option `--block` (lue par src/cli.ts), puis un commit du lot L1 qui renomme `oldName` ; `docTouched` : le lot met aussi la doc à jour ; `commentOnly` : le lot ajoute seulement un commentaire citant `--block` ; `noDoc` : aucune doc ne cite `oldName`. */
function lot(docTouched: boolean, commentOnly = false, noDoc = false) {
  const h = harness();
  const c = Object.assign(h.lot('L1', {}, { test: 'true' }), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  briefed.push(() => h.store.removeTmpDir(c.lot.project, c.lot.lot));
  mkdirSync(join(h.repo, 'src'));
  mkdirSync(join(h.repo, 'docs'));
  writeFileSync(join(h.repo, 'src/lib.ts'), 'export function oldName(): number {\n  return 1;\n}\n');
  writeFileSync(join(h.repo, 'src/cli.ts'), 'const block = process.argv.includes("--block");\nexport const main = (): boolean => block;\n');
  writeFileSync(join(h.repo, 'docs/page.md'), noDoc ? 'Une autre ligne.\n' : 'Voir `oldName` pour le détail.\nUne autre ligne.\nL’option --block bloque.\n');
  git(h.repo, 'add', '--', 'src/lib.ts', 'src/cli.ts', 'docs/page.md');
  git(h.repo, 'commit', '-q', '-m', 'chore: base', '--', 'src/lib.ts', 'src/cli.ts', 'docs/page.md');
  writeFileSync(join(h.repo, 'src/lib.ts'), commentOnly ? 'export function oldName(): number {\n  // L1 : voir --block dans cli.ts\n  return 1;\n}\n' : 'export function newName(): number {\n  return 1;\n}\n');
  const paths = ['src/lib.ts'];
  if (docTouched) {
    writeFileSync(join(h.repo, 'docs/page.md'), 'Voir `newName` pour le détail.\nUne autre ligne.\nL’option --block bloque.\n');
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
    expect(brief).toContain('cites `oldName` — not touched by the lot');
    expect(brief).toContain('hook.docs');
    expect(brief).not.toContain('docs/page.md:2');
    expect(brief).not.toContain('docs/page.md:3');
  });
  it('R10 — une doc que le lot a déjà mise à jour est listée comme à jour, avec les identifiants changés et la consigne de relister sur son propre diff', () => {
    const { c } = lot(true);
    const brief = briefFor(c, 'fix');
    expect(brief).toContain('`docs/page.md:1` cites `newName` — updated by the lot');
    expect(brief).toContain('removes or adds (L648): `newName`, `oldName`');
    expect(brief).toContain('git grep');
    expect(brief).toContain('same commit');
    expect(brief).not.toContain('not touched by the lot');
  });
  it('R10 — un lot qui change un identifiant qu’aucune doc ne cite reçoit quand même les identifiants et la consigne', () => {
    const { c } = lot(false, false, true);
    const brief = briefFor(c, 'fix');
    expect(brief).toContain('removes or adds (L648): `newName`, `oldName`');
    expect(brief).toContain('cites them yet');
    expect(brief).not.toContain('cites `');
  });
  it('R10 — un lot dont le diff ne cite une option que dans un commentaire (présente dans src/ avant et après) ne la liste pas', () => {
    const { c } = lot(false, true);
    const brief = briefFor(c, 'fix');
    expect(brief).not.toContain('cites `--block`');
    expect(brief).not.toContain('L648');
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
