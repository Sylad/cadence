import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deltaPlanOnly } from '../src/orchestrate/cycle/integration-porte.js';
import { planFileSet } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { git } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : bords de `deltaPlanOnly` — suppression, déplacement, noms à espaces, plan réel (planFileSet), delta rejoué deux fois.
afterEach(cleanupTempDirs);

function repoWith(files: string[]) {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), 'x\n');
  }
  writeFileSync(join(repo, 'base.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}
const head = (repo: string) => git(repo, 'rev-parse', 'HEAD');
const commit = (repo: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'delta');
  return head(repo);
};
const PLAN = new Set(['.cadence/raf.yaml', '.cadence/gantt.html']);

describe('L662 R4 — deltaPlanOnly aux bords', () => {
  it('R4 — main supprime un fichier de code : pas plan seul', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    rmSync(join(repo, 'src/a/x.ts'));
    expect(deltaPlanOnly(repo, from, commit(repo), PLAN)).toBe(false);
  });
  it('R4 — main déplace un fichier de code vers un autre dossier : pas plan seul (les deux noms comptent)', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    mkdirSync(join(repo, 'ailleurs'));
    renameSync(join(repo, 'src/a/x.ts'), join(repo, 'ailleurs/x.ts'));
    expect(deltaPlanOnly(repo, from, commit(repo), PLAN)).toBe(false);
  });
  it('R4 — une page dont le nom a des espaces et des accents : pas plan seul', () => {
    const f = 'docs/page é avec espace.md';
    const repo = repoWith([f]);
    const from = head(repo);
    writeFileSync(join(repo, f), 'y\n');
    expect(deltaPlanOnly(repo, from, commit(repo), PLAN)).toBe(false);
  });
  it('R4 — from égal à to (même sommet) : plan seul', () => {
    const repo = repoWith(['src/a/x.ts']);
    expect(deltaPlanOnly(repo, head(repo), head(repo), PLAN)).toBe(true);
  });
  it('R4 — un plan réel (planFileSet) : une note ajoutée au plan est plan seul, la même note plus un fichier de code ne l\'est pas', () => {
    const repo = repoWith([]);
    const plan = Plan.create(join(repo, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
    const from = commit(repo);
    const files = planFileSet(plan, repo);
    expect(files.has('.cadence/raf.yaml')).toBe(true);
    writeFileSync(join(repo, '.cadence/raf.yaml'), '# note\n', { flag: 'a' });
    const to = commit(repo);
    expect(deltaPlanOnly(repo, from, to, files)).toBe(true);
    writeFileSync(join(repo, 'src.ts'), 'x\n');
    expect(deltaPlanOnly(repo, from, commit(repo), files)).toBe(false);
    // rejoué deux fois : même réponse
    expect(deltaPlanOnly(repo, from, to, files)).toBe(true);
  });
  it('R4 — un fichier de plan sous un autre chemin (plan.path d\'un projet) : seul l\'ensemble donné compte', () => {
    const repo = repoWith([]);
    const from = head(repo);
    mkdirSync(join(repo, 'docs/plan'), { recursive: true });
    writeFileSync(join(repo, 'docs/plan/taches.yaml'), 'x\n');
    const to = commit(repo);
    expect(deltaPlanOnly(repo, from, to, PLAN)).toBe(false);
    expect(deltaPlanOnly(repo, from, to, new Set(['docs/plan/taches.yaml']))).toBe(true);
  });
});
