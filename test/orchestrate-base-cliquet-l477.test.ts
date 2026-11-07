import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const DEPART = { [cle('src/a.ts')]: 10, [cle('src/b.ts')]: 5 };
/** Un lot parti d'un départ où src/a.ts (10 lignes, mesure 10) et src/b.ts (mesure 5) existent ; main a baissé b depuis et peut aussi changer des fichiers (`main`). */
function scene(lot: Files, main: Files = {}) {
  const repo = gitRepo();
  put(repo, { 'src/a.ts': lignes(10), 'src/b.ts': 'b\n', [BASE]: bl(DEPART) }, 'init');
  const store = new RunStore(tempDir(), 'w1');
  const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
  expect(prepareTree(t).ok).toBe(true);
  put(t.dir, lot, 'feat(L1): commit du lot');
  put(repo, { ...main, [BASE]: bl({ ...DEPART, [cle('src/b.ts')]: 4 }) }, 'feat(L2): main');
  return { repo, t, shas: () => [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', t.branch)] };
}
const baseDe = (dir: string) => JSON.parse(readFileSync(join(dir, BASE), 'utf8'));

describe('L477 — le contrôle du rebase d\'intégration par le lien de contenu', () => {
  it('R13 — commit qui coupe un fichier en deux : base recomposée à l\'intégration', () => {
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': lignes(4, 6), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(baseDe(s.t.dir)).toEqual({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 4, [cle('src/n.ts')]: 4 });
  });

  it('R13 — commit qui ajoute un défaut neuf payé par une correction : rebase abandonné', () => {
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': lignes(4, 5000), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    expect(s.shas()).toEqual(shas);
  });

  it('R13 — lien illisible dans git : rebase abandonné, rien n\'est écrit', () => {
    // n.ts tient 3 lignes sur 4 de a.ts : a.ts ne couvre pas tout, la lecture continue vers b.ts, dont le blob du départ est perdu (ls-tree le voit, git show échoue)
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': `${lignes(3, 6)}y += 1;\n`, [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    const blob = git(s.repo, 'hash-object', 'src/b.ts');
    rmSync(join(s.repo, git(s.repo, 'rev-parse', '--git-path', 'objects'), blob.slice(0, 2), blob.slice(2)));
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    expect(s.shas()).toEqual(shas);
    expect(git(s.t.dir, 'status', '--porcelain')).toBe('');
  });

  it('R13 — clé d\'un fichier neuf absent du commit : aucun lien, le total monte, rebase abandonné (L538)', () => {
    const s = scene({ 'src/a.ts': lignes(6), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    expect(s.shas()).toEqual(shas);
  });

  it('R14 — à l\'intégration, le lien se calcule sur le commit contrôlé sans arbre de travail', () => {
    // main remet en tête de a.ts les lignes 6 à 9 que le lot a déplacées dans n.ts : l'arbre rebasé les porte de nouveau (fusion propre), le commit du lot non
    const s = scene({ 'src/a.ts': lignes(6), 'src/n.ts': lignes(4, 6), [BASE]: bl({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 5, [cle('src/n.ts')]: 4 }) }, { 'src/a.ts': `${lignes(4, 6)}${lignes(10)}` });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    // lu dans l'arbre, a.ts n'aurait rien perdu et n.ts n'aurait aucune source
    expect(readFileSync(join(s.t.dir, 'src/a.ts'), 'utf8')).toBe(`${lignes(4, 6)}${lignes(6)}`);
    expect(baseDe(s.t.dir)).toEqual({ [cle('src/a.ts')]: 6, [cle('src/b.ts')]: 4, [cle('src/n.ts')]: 4 });
  });
});
