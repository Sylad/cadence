import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';
import { fake, run, setup } from './orchestrate-worktree-harness.js';

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

// Statut expérimental (décision du lead, 24-10) : orchestrate.worktrees: true est refusé tant que L299–L301 ne sont pas faits, sauf CADENCE_EXPERIMENTAL_WORKTREES=1.
describe('garde d\'activation — mode worktree expérimental', () => {
  const NO_VAR = { CADENCE_EXPERIMENTAL_WORKTREES: undefined };

  it('sans la variable, orchestrate.worktrees: true est refusé (code 2) avant d\'agir, en nommant L299, L300, L301', async () => {
    const { parent, repo } = setup();
    const f = fake();
    const r = await run(parent, ['a:L1', 'a:L2'], f, {}, NO_VAR);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/orchestrate\.worktrees: true est refusé.*EXPÉRIMENTAL.*L299, L300 et L301.*CADENCE_EXPERIMENTAL_WORKTREES=1/);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(repo, '.cadence'))).toBe(false);
  });

  it('--dry-run dit la même chose', async () => {
    const { parent } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--dry-run'], fake(), {}, NO_VAR);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/EXPÉRIMENTAL.*L299, L300 et L301/);
  });

  it('une valeur autre que 1 ne lève pas le refus', async () => {
    const { parent } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--dry-run'], fake(), {}, { CADENCE_EXPERIMENTAL_WORKTREES: 'true' });
    expect(r.code).toBe(2);
  });

  it('avec CADENCE_EXPERIMENTAL_WORKTREES=1, le mode est accepté', async () => {
    const { parent } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.err).not.toMatch(/EXPÉRIMENTAL/);
    expect(r.code).toBe(0);
  });

  it('le défaut (clé absente ou false) est inchangé : accepté sans la variable', async () => {
    for (const yaml of ['', 'worktrees: false\n']) {
      const { parent } = setup([{ title: 'un' }, { title: 'deux' }], yaml);
      const r = await run(parent, ['a:L1', 'a:L2', '--dry-run'], fake(), {}, NO_VAR);
      removeDryRunBriefs(r.out);
      expect(r.err).not.toMatch(/EXPÉRIMENTAL/);
      expect(r.code).toBe(0);
    }
  });
});
