import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L541 — bords de la recomposition de la base fusionnée sans conflit (R8).
const BASE = 'qualite-baseline.json';
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((f) => `eslint|src/${f}.ts|r`);
type Mesure = Record<string, number>;
const bl = (m: Mesure) => `${JSON.stringify(Object.fromEntries(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : 1))), null, 2)}\n`;
type Files = Record<string, string | null>;
const put = (dir: string, files: Files, message: string) => {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) { git(dir, 'rm', '-q', '--', f); continue; }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    git(dir, 'add', '--', f);
  }
  git(dir, 'commit', '-q', '-m', message);
};
const f = (v: Mesure | string) => ({ [BASE]: typeof v === 'string' ? v : bl(v) });

function scene(o: { start: Mesure | string; main: Files[]; lot: Files[] }) {
  const repo = gitRepo();
  put(repo, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n', ...f(o.start) }, 'init');
  const store = new RunStore(tempDir(), 'w1');
  const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
  expect(prepareTree(t).ok).toBe(true);
  o.lot.forEach((v, i) => put(t.dir, v, `feat(L1): commit ${i + 1}`));
  o.main.forEach((v, i) => put(repo, v, `feat(L2): main ${i + 1}`));
  return { t, read: () => readFileSync(join(t.dir, BASE), 'utf8'), log: () => git(t.dir, 'log', '--format=%s', 'main..HEAD').split('\n') };
}

describe('L541 R8 — bords', () => {
  it('lot à plusieurs commits (A puis B), main baisse A pareil : une seule recomposition', () => {
    const s = scene({ start: { [A]: 3, [B]: 4, [C]: 3 }, main: [f({ [A]: 1, [B]: 4, [C]: 3 })], lot: [f({ [A]: 1, [B]: 4, [C]: 3 }), f({ [A]: 1, [B]: 2, [C]: 3 })] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: true });
    expect(JSON.parse(s.read())).toEqual({ [B]: 2, [C]: 3 });
    expect(s.log().filter((x) => x.startsWith('fix(base)'))).toHaveLength(1);
  });
  it('rejouer le rebase une seconde fois : aucun commit de plus (idempotent)', () => {
    const s = scene({ start: { [A]: 3, [B]: 4, [C]: 3 }, main: [f({ [A]: 1, [B]: 4, [C]: 3 })], lot: [f({ [A]: 1, [B]: 4, [C]: 3 }), { 'x.txt': 'x\n' }] });
    rebaseOnto(s.t.dir, 'main');
    const n = s.log().length;
    const r = rebaseOnto(s.t.dir, 'main');
    expect(r.kind).toBe('forwarded');
    expect(s.log()).toHaveLength(n);
  });
  it('un commit résolu par L538 puis un commit propre : pas de commit fix(base) superflu', () => {
    const s = scene({ start: { [A]: 5, [B]: 4, [C]: 3 }, main: [f({ [A]: 5, [B]: 6, [C]: 3 })], lot: [f({ [A]: 2, [B]: 4, [C]: 3 }), { 'x.txt': 'x\n' }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1, silent: false });
    expect(JSON.parse(s.read())).toEqual({ [A]: 2, [B]: 6, [C]: 3 });
    expect(s.log().some((x) => x.startsWith('fix(base)'))).toBe(false);
  });
  it('le lot réécrit la base sans changer les valeurs (mise en forme seule) : rien à recomposer', () => {
    const s = scene({ start: { [A]: 3, [B]: 4 }, main: [{ 'y.txt': 'y\n' }], lot: [f(`{"${A}":3,"${B}":4}\n`)] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: false });
    expect(s.log()).toEqual(['feat(L1): commit 1']);
  });
  it('le lot ajoute une clé d\'un fichier nouveau, main baisse une autre : base = fusion, pas de commit de plus', () => {
    const s = scene({ start: { [A]: 3, [B]: 4 }, main: [f({ [A]: 3, [B]: 1 })], lot: [{ 'src/d.ts': 'd\n', ...f({ [A]: 3, [B]: 4, [D]: 2 }) }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: false });
    expect(JSON.parse(s.read())).toEqual({ [A]: 3, [B]: 1, [D]: 2 });
  });
  it('main retire une clé que le lot ne touche pas, le lot baisse une autre : la clé de main reste retirée', () => {
    const s = scene({ start: { [A]: 3, [B]: 4, [C]: 3 }, main: [f({ [A]: 3, [C]: 3 })], lot: [f({ [A]: 3, [B]: 4, [C]: 1 })] });
    rebaseOnto(s.t.dir, 'main');
    expect(JSON.parse(s.read())).toEqual({ [A]: 3, [C]: 1 });
  });
  it('le lot vide la base ({}) et main ne la touche pas : fichier {} , pas d\'erreur', () => {
    const s = scene({ start: { [A]: 3 }, main: [{ 'y.txt': 'y\n' }], lot: [f({})] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: false });
    expect(JSON.parse(s.read())).toEqual({});
  });
  it('base de main illisible (JSON invalide) alors que le lot la baisse sans conflit : pas d\'exception, rebase réussi', () => {
    const s = scene({ start: { [A]: 3, [B]: 4 }, main: [{ 'y.txt': 'y\n' }, f('pas du json\n')], lot: [f({ [A]: 1, [B]: 4 })] });
    const r = rebaseOnto(s.t.dir, 'main');
    expect(r.kind === 'rebased' || r.kind === 'conflict').toBe(true);
    expect(git(s.t.dir, 'status', '--porcelain')).toBe('');
  });
  it('valeur de type chaîne dans la base du lot : rien n\'est recomposé, pas d\'exception', () => {
    const s = scene({ start: { [A]: 3, [B]: 4 }, main: [{ 'y.txt': 'y\n' }], lot: [f('{"' + A + '":"1"}\n')] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: false });
  });
  it('la base est un tableau chez le lot : rien n\'est recomposé', () => {
    const s = scene({ start: { [A]: 3 }, main: [{ 'y.txt': 'y\n' }], lot: [f('[1,2]\n')] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', silent: false });
    expect(s.read()).toBe('[1,2]\n');
  });
});
