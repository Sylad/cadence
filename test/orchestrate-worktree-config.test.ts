import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';
import { branches, conflictWave, fake, meeting, run, setup, store, WAVE, writes } from './orchestrate-worktree-harness.js';
import { git } from './orchestrate-harness.js';

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

// La garde vaut aussi à la reprise : --resume, --integrate et --replay ne contournent pas le refus (une seule décision, worktreesEnabled).
describe('garde d\'activation — reprise', () => {
  const NO_VAR = { CADENCE_EXPERIMENTAL_WORKTREES: undefined };
  const RESUME = /orchestrate\.worktrees: true est refusé.*EXPÉRIMENTAL.*L299, L300 et L301.*CADENCE_EXPERIMENTAL_WORKTREES=1/;
  const snapshot = (parent: string) => {
    const dir = store(parent).dir;
    return readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort().map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`);
  };

  it('vague par défaut suspendue au budget, worktrees: true commité ensuite, --resume sans la variable : code 2, aucun worktree, état inchangé', async () => {
    const { parent, repo } = setup(undefined, '');
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
    expect(first.code).toBe(3);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n  worktrees: true\n');
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: worktrees');
    const before = snapshot(parent);
    const f = fake();
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], f, {}, NO_VAR);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(RESUME);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
    expect(branches(repo)).toBe('');
    expect(snapshot(parent)).toEqual(before);
  });

  it('vague lancée avec la variable, reprise sans : code 2, worktrees et état inchangés', async () => {
    const { parent, repo } = setup();
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
    expect(first.code).toBe(3);
    const before = snapshot(parent);
    const branchesBefore = branches(repo);
    const f = fake();
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], f, {}, NO_VAR);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(RESUME);
    expect(f.calls).toEqual([]);
    expect(branches(repo)).toBe(branchesBefore);
    expect(snapshot(parent)).toEqual(before);
  });

  it('clé retirée après le lancement mais branche de lot à retrouver : refusé aussi, avec la branche nommée', async () => {
    const { parent, repo } = setup();
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
    expect(first.code).toBe(3);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: sans worktrees');
    const before = snapshot(parent);
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], fake(), {}, NO_VAR);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(new RegExp(`la branche cadence/${WAVE}/a--L1 .*est refusé.*EXPÉRIMENTAL`));
    expect(snapshot(parent)).toEqual(before);
  });

  it('--resume --integrate et --resume --replay sans la variable : code 2, état inchangé', async () => {
    const { parent, f, r: first } = await conflictWave();
    expect(first.code).not.toBe(2);
    expect(f.calls.length).toBeGreaterThan(0);
    const before = snapshot(parent);
    for (const opt of ['--integrate', '--replay']) {
      const g = fake();
      const r = await run(parent, ['--resume', WAVE, opt, 'a:L1'], g, {}, NO_VAR);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(RESUME);
      expect(g.calls).toEqual([]);
      expect(snapshot(parent)).toEqual(before);
    }
  });

  it('défaut inchangé à la reprise : clé absente, pas de branche, la variable n\'est pas demandée', async () => {
    const { parent, repo } = setup(undefined, '');
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }), {}, NO_VAR);
    expect(first.code).toBe(3);
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], fake(), {}, NO_VAR);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
    expect(branches(repo)).toBe('');
  });
});
