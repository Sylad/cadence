import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deltaCrossable } from '../src/orchestrate/cycle/integration-porte.js';
import { Plan } from '../src/plan.js';
import { git } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : bords de `deltaCrossable` — suppression, déplacement, fusion, plan réel (Plan.create), chaîne longue, delta rejoué deux fois.
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
const commit = (repo: string, msg = 'delta') => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return head(repo);
};
const PLAN = '.cadence/raf.yaml';
const note = (repo: string) => writeFileSync(join(repo, PLAN), '# note\n', { flag: 'a' });

describe('L662 R4 — deltaCrossable aux bords', () => {
  it('R4 — main supprime un fichier de code : non traversable', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    rmSync(join(repo, 'src/a/x.ts'));
    expect(deltaCrossable(repo, from, commit(repo), PLAN, undefined)).toBe(false);
  });
  it('R4 — main déplace un fichier de code : non traversable', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    mkdirSync(join(repo, 'ailleurs'));
    renameSync(join(repo, 'src/a/x.ts'), join(repo, 'ailleurs/x.ts'));
    expect(deltaCrossable(repo, from, commit(repo), PLAN, undefined)).toBe(false);
  });
  it('R4 — main supprime le fichier du plan : traversable par la règle de planChain (le seul fichier changé est le plan)', () => {
    const repo = repoWith([PLAN]);
    const from = head(repo);
    rmSync(join(repo, PLAN));
    expect(deltaCrossable(repo, from, commit(repo), PLAN, undefined)).toBe(true);
  });
  it('R4 — from égal à to (même sommet) : traversable', () => {
    const repo = repoWith(['src/a/x.ts']);
    expect(deltaCrossable(repo, head(repo), head(repo), PLAN, undefined)).toBe(true);
  });
  it('R4 — un plan réel (Plan.create) : une note ajoutée est traversable ; la même note plus un fichier de code ne l\'est pas ; rejoué deux fois, même réponse', () => {
    const repo = repoWith([]);
    Plan.create(join(repo, PLAN), 'a', 'L', '2026-09-01');
    const from = commit(repo, 'plan');
    note(repo);
    const to = commit(repo);
    expect(deltaCrossable(repo, from, to, PLAN, undefined)).toBe(true);
    writeFileSync(join(repo, 'src.ts'), 'x\n');
    expect(deltaCrossable(repo, from, commit(repo), PLAN, undefined)).toBe(false);
    expect(deltaCrossable(repo, from, to, PLAN, undefined)).toBe(true);
  });
  it('R4 — une fusion dont le résultat ne change que le plan : non traversable (planChain s\'arrête à deux parents)', () => {
    const repo = repoWith([PLAN]);
    const from = head(repo);
    git(repo, 'checkout', '-q', '-b', 'side');
    note(repo);
    commit(repo, 'side');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'side');
    expect(deltaCrossable(repo, from, head(repo), PLAN, undefined)).toBe(false);
  });
  it('R4 — plus de 50 commits de plan seul : la chaîne s\'arrête avant from, non traversable (le doute rejoue la porte)', () => {
    const repo = repoWith([PLAN]);
    const from = head(repo);
    for (let i = 0; i < 51; i++) {
      note(repo);
      commit(repo, `plan ${i}`);
    }
    expect(deltaCrossable(repo, from, head(repo), PLAN, undefined)).toBe(false);
  });
  it('R4 — le lecteur du plan est jugé au sommet to : un lecteur ajouté par le delta lui-même compte (le delta n\'est alors plus de plan seul de toute façon)', () => {
    const repo = repoWith([PLAN]);
    const from = head(repo);
    writeFileSync(join(repo, 'check.sh'), 'cat .cadence/raf.yaml\n');
    expect(deltaCrossable(repo, from, commit(repo), PLAN, undefined)).toBe(false);
  });
});
