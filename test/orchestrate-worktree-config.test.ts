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

// L320 — le mode worktree est activé par la configuration seule : plus de garde expérimentale (CADENCE_EXPERIMENTAL_WORKTREES n'est plus lue).
describe('R1 — activation par la configuration seule (L320)', () => {
  const OLD_VAR = { CADENCE_EXPERIMENTAL_WORKTREES: undefined };
  const snapshot = (parent: string) => {
    const dir = store(parent).dir;
    return readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort().map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`);
  };

  it('R1 — orchestrate.worktrees: true sans aucune variable : la vague est acceptée et chaque lot est joué dans son worktree', async () => {
    const { parent } = setup();
    const f = fake();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, {}, OLD_VAR);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(f.calls.filter((c) => c.kind === 'implement').every((c) => c.cwd.includes('/worktrees/'))).toBe(true);
  });

  it('R1 — --dry-run l\'accepte aussi, sans mention d\'un statut expérimental', async () => {
    const { parent } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--dry-run'], fake(), {}, OLD_VAR);
    removeDryRunBriefs(r.out);
    expect(r.err).not.toMatch(/EXPÉRIMENTAL|CADENCE_EXPERIMENTAL_WORKTREES/);
    expect(r.code).toBe(0);
  });

  it('R1 — la variable CADENCE_EXPERIMENTAL_WORKTREES n\'est plus lue : à 0 ou à une autre valeur, le mode joue quand même', async () => {
    for (const value of ['0', 'true']) {
      const { parent } = setup();
      const f = fake();
      const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, {}, { CADENCE_EXPERIMENTAL_WORKTREES: value });
      expect(r.code).toBe(0);
      expect(f.calls.filter((c) => c.kind === 'implement').every((c) => c.cwd.includes('/worktrees/'))).toBe(true);
    }
  });

  it('R2 — le défaut des autres projets est inchangé : clé absente ou false, les lots restent à la suite dans le dépôt', async () => {
    for (const yaml of ['', 'worktrees: false\n']) {
      const { parent } = setup([{ title: 'un' }, { title: 'deux' }], yaml);
      const f = fake();
      const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, {}, OLD_VAR);
      expect(r.code).toBe(0);
      expect(f.calls.some((c) => c.cwd.includes('/worktrees/'))).toBe(false);
    }
  });

  it('R3 — le cadence.yaml de cadence active le mode (orchestrate.worktrees: true) ; la valeur par défaut du lecteur reste false', () => {
    expect(readOrchestrateConfig(join(import.meta.dirname, '..', 'cadence.yaml')).worktrees).toBe(true);
    expect(readOrchestrateConfig('/nope').worktrees).toBe(false);
  });
});

// La reprise (--resume, --integrate, --replay) ne demande plus rien de plus que la configuration ou la branche du lot.
describe('R4 — reprise sans variable (L320)', () => {
  const OLD_VAR = { CADENCE_EXPERIMENTAL_WORKTREES: undefined };

  it('R4 — vague suspendue au budget puis reprise sans variable : les lots reprennent dans leurs worktrees', async () => {
    const { parent } = setup();
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }), {}, OLD_VAR);
    expect(first.code).toBe(3);
    const f = fake();
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], f, {}, OLD_VAR);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((c) => c.cwd.includes('/worktrees/'))).toBe(true);
  });

  it('R4 — clé retirée après le lancement mais branche de lot à retrouver : la reprise joue le lot dans sa branche, sans refus', async () => {
    const { parent, repo } = setup();
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }), {}, OLD_VAR);
    expect(first.code).toBe(3);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: sans worktrees');
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], fake(), {}, OLD_VAR);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R4 — --resume --integrate et --resume --replay sans variable : acceptés (jamais le code 2 de l\'ancienne garde)', async () => {
    const { parent, f, r: first } = await conflictWave();
    expect(first.code).not.toBe(2);
    expect(f.calls.length).toBeGreaterThan(0);
    for (const opt of ['--integrate', '--replay']) {
      const r = await run(parent, ['--resume', WAVE, opt, 'a:L1'], fake(), {}, OLD_VAR);
      expect(r.err).not.toMatch(/EXPÉRIMENTAL|CADENCE_EXPERIMENTAL_WORKTREES/);
      expect(r.code).not.toBe(2);
    }
  });

  it('R4 — défaut inchangé à la reprise : clé absente, pas de branche, pas de worktree', async () => {
    const { parent, repo } = setup(undefined, '');
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }), {}, OLD_VAR);
    expect(first.code).toBe(3);
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], fake(), {}, OLD_VAR);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
    expect(branches(repo)).toBe('');
  });
});
