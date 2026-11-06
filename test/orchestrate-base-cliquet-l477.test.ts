import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L477 (R13) — le contrôle du rebase d'intégration relie les fichiers neufs à leurs sources par le contenu des commits (git show), sans arbre de travail.
const BASE = 'qualite-baseline.json';
const cle = (f: string) => `eslint|${f}|max-lines|total`;
const bl = (m: Record<string, number>) => `${JSON.stringify(Object.fromEntries(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : 1))), null, 2)}\n`;
const lignes = (n: number, depart = 0) => `${Array.from({ length: n }, (_, i) => `x += ${depart + i};`).join('\n')}\n`;
type Files = Record<string, string>;
const put = (dir: string, files: Files, message: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    git(dir, 'add', '--', f);
  }
  git(dir, 'commit', '-q', '-m', message);
};

/** Un lot parti d'un départ où src/a.ts (10 lignes, mesure 10) et src/b.ts (mesure 5) existent ; main a baissé b depuis. */
function scene(lot: Files) {
  const repo = gitRepo();
  put(repo, { 'src/a.ts': lignes(10), 'src/b.ts': 'b\n', [BASE]: bl({ [cle('src/a.ts')]: 10, [cle('src/b.ts')]: 5 }) }, 'init');
  const store = new RunStore(tempDir(), 'w1');
  const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
  expect(prepareTree(t).ok).toBe(true);
  put(t.dir, lot, 'feat(L1): commit du lot');
  put(repo, { [BASE]: bl({ [cle('src/a.ts')]: 10, [cle('src/b.ts')]: 4 }) }, 'feat(L2): main');
  return { repo, t, shas: () => [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', t.branch)] };
}

describe('L477 — le contrôle du rebase d\'intégration par le lien de contenu', () => {
  it('R13 — commit qui coupe un fichier en deux : base recomposée à l\'intégration', () => {
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': lignes(4, 6), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(JSON.parse(readFileSync(join(s.t.dir, BASE), 'utf8'))).toEqual({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 4, [cle('src/n.ts')]: 4 });
  });

  it('R13 — commit qui ajoute un défaut neuf payé par une correction : rebase abandonné', () => {
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': lignes(4, 5000), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    expect(s.shas()).toEqual(shas);
  });

  it('R13 — lien illisible dans git : rebase abandonné, rien n\'est écrit', () => {
    // le fichier neuf déclaré dans la base n'existe pas dans le commit : git show ne rend rien, aucun lien
    const s = scene({ 'src/a.ts': lignes(6), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    expect(s.shas()).toEqual(shas);
    expect(git(s.t.dir, 'status', '--porcelain')).toBe('');
  });
});
