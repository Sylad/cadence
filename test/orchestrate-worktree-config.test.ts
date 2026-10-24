import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

// L279 — orchestrate.worktrees : un worktree par lot dans une vague (activation par cadence.yaml).
const read = (yaml: string) => {
  const f = join(tempDir(), 'cadence.yaml');
  writeFileSync(f, yaml);
  return () => readOrchestrateConfig(f);
};

describe('R1 — orchestrate.worktrees', () => {
  it('R1 — absente, la clé vaut false : le comportement d\'avant (lots à la suite dans le dépôt)', () => {
    expect(read('orchestrate: {}\n')().worktrees).toBe(false);
    expect(readOrchestrateConfig('/nope').worktrees).toBe(false);
  });
  it('R1 — true et false sont lus', () => {
    expect(read('orchestrate:\n  worktrees: true\n')().worktrees).toBe(true);
    expect(read('orchestrate:\n  worktrees: false\n')().worktrees).toBe(false);
  });
  it('R1 — orchestrate.worktrees: oui (valeur non booléenne) est refusé à la lecture de la config', () => {
    expect(read('orchestrate:\n  worktrees: oui\n')).toThrow(/orchestrate\.worktrees doit être true ou false/);
    expect(read('orchestrate:\n  worktrees: 1\n')).toThrow(/orchestrate\.worktrees doit être true ou false/);
  });
});
