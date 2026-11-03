import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L568 — sans `merge=union`, un commit du lot qui touche à la fois CHANGELOG.md et qualite-baseline.json entre en conflit sur les deux : chacun est résolu.
const BASE = 'qualite-baseline.json';
const CL = 'CHANGELOG.md';
const K = 'eslint|src/a.ts|r';
const bl = (n: number) => `${JSON.stringify({ [K]: n, 'eslint|src/b.ts|r': 4 }, null, 2)}\n`;
const changelog = (...fixed: string[]) => `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n${fixed.map((l) => `- ${l}\n`).join('')}\n## [1.0.0] - 2026-01-01\n\n- première\n`;
const put = (dir: string, files: Record<string, string>, message: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    git(dir, 'add', '--', f);
  }
  git(dir, 'commit', '-q', '-m', message);
};

describe('R1 — CHANGELOG.md et base en conflit dans le même commit', () => {
  it('R1 — le commit du lot ajoute son entrée et baisse une clé pendant que main fait de même : rebase réussi, entrées des deux lots une fois, base main + baisse du lot', () => {
    const repo = gitRepo();
    put(repo, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', [CL]: changelog('base'), [BASE]: bl(5) }, 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    put(t.dir, { [CL]: changelog('base', 'entrée du lot L1'), [BASE]: bl(3) }, 'fix(L1): lot');
    put(repo, { [CL]: changelog('base', 'entrée de main L2'), [BASE]: `${JSON.stringify({ [K]: 5, 'eslint|src/b.ts|r': 2 }, null, 2)}\n` }, 'fix(L2): main');
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'rebased', changelog: 1, baseline: 1 });
    const text = readFileSync(join(t.dir, CL), 'utf8');
    expect(text.match(/### Fixed/g)).toHaveLength(1);
    expect(text.match(/entrée du lot L1/g)).toHaveLength(1);
    expect(text.match(/entrée de main L2/g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(t.dir, BASE), 'utf8'))).toEqual({ [K]: 3, 'eslint|src/b.ts|r': 2 });
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});
