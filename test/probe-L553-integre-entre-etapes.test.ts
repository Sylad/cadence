import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedStateDir } from '../src/state.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore } from '../src/orchestrate/state.js';
import { HYPOTHESES_HANDBACK } from '../src/orchestrate/cycle.js';
import { activeLock, REPO_LOCK } from '../src/orchestrate/lock.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// Sonde L553 : l'intégration passe entre les étapes d'une autre vague seulement dans les cas sûrs.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
const edit = (cwd: string, n: number, lot: string) => {
  writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
  git(cwd, 'add', '--', 'f.txt');
  git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
  return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
};

async function handedBack() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      return edit(cwd, lot === 'L1' ? 4 : 7, lot);
    },
    'review-small': async () => {
      git(repo, 'checkout', '-q', '-b', 'autre');
      return claudeOut(reviewReport({ verdict: 'rebase sans dégât' }));
    },
  });
  await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  const lot = f.calls.find((c) => c.kind === 'review-small')!.lot;
  git(repo, 'checkout', '-q', 'main');
  return { parent, repo, lot, other: lot === 'L1' ? 'L2' : 'L1' };
}

function holder(repo: string, wave: string) {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: sleeper.pid, wave, started: '2026-10-04T00:00:00Z' }));
  return sleeper;
}

describe('L553 — cas où l\'intégration doit continuer d\'attendre', () => {
  it('worktree du lot absent — autre vague vivante tient le dépôt, lot sans .git de worktree — attendre puis refuser (2)', async () => {
    const { parent, repo, lot } = await handedBack();
    const l = store(parent).readLot('a', lot)!;
    rmSync(join(lotTreeDir(store(parent).dir, l.project, l.lot, l.repo), '.git'), { force: true });
    const sleeper = holder(repo, 'autre-vague');
    try {
      const r = await run(parent, ['--resume', WAVE, '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.code).toBe(2);
      expect(activeLock(join(sharedStateDir(repo), REPO_LOCK))?.pid).toBe(sleeper.pid);
    } finally {
      sleeper.kill();
    }
  });
  it('autre lot vivant dans le même dépôt — un lot suspendu non intégré partage le dépôt — ne pas passer, attendre puis refuser (2)', async () => {
    const { parent, repo, lot, other } = await handedBack();
    const o = store(parent).readLot('a', other)!;
    o.status = 'suspended';
    o.next = 'implement' as typeof o.next;
    store(parent).writeLot(o);
    const sleeper = holder(repo, 'autre-vague');
    try {
      const r = await run(parent, ['--resume', WAVE, '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.code).toBe(2);
    } finally {
      sleeper.kill();
    }
  });
  it('id de vague « local: » vide — verrou d\'une vague nommée « local: » sans lot — doit se comporter comme une tâche locale (attente)', async () => {
    const { parent, repo, lot } = await handedBack();
    const sleeper = holder(repo, 'local:');
    try {
      const r = await run(parent, ['--resume', WAVE, '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.code).toBe(2);
    } finally {
      sleeper.kill();
    }
  });
  it('--replay — reprise --replay (pas --integrate) avec une autre vague vivante — pas de crash, code 0, 1 ou 2', async () => {
    const { parent, repo, lot } = await handedBack();
    const sleeper = holder(repo, 'autre-vague');
    try {
      const r = await run(parent, ['--resume', WAVE, '--replay', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect([0, 1, 2]).toContain(r.code);
      expect(r.err).not.toMatch(/TypeError|undefined/);
    } finally {
      sleeper.kill();
    }
  });
  it('reprise sans --integrate — autre vague tient le dépôt, reprise simple — refus (2), sans « passe entre ses étapes »', async () => {
    const { parent, repo } = await handedBack();
    const sleeper = holder(repo, 'autre-vague');
    try {
      const r = await run(parent, ['--resume', WAVE], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.code).toBe(2);
    } finally {
      sleeper.kill();
    }
  });
  it('R1 — la vague porteuse a un lot en implémentation dans l\'arbre principal (sans worktree) — l\'intégration y écrirait sous sa session : attendre puis refuser (2)', async () => {
    const { parent, repo, lot } = await handedBack();
    const sleeper = holder(repo, 'autre-vague');
    const launch = tempDir();
    const other = RunStore.reserve(launch, 'autre-vague')!;
    other.writeWave({ id: 'autre-vague', status: 'running', created: 'x', lots: ['a:L9'] } as never);
    other.writeLot({ ...newLot({ project: 'a', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status: 'implementing' });
    registerWave(process.env.CADENCE_HOME!, { pid: sleeper.pid!, wave: 'autre-vague', started: 'x', cwd: launch, repos: [repo] });
    try {
      const r = await run(parent, ['--resume', WAVE, '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.out).toContain('attente de sa fin');
      expect(r.code).toBe(2);
    } finally {
      sleeper.kill();
    }
  });
  it('R2 — --replay d\'un lot rendu sur des notes d\'hypothèses (il rejouera des sessions) — ne passe pas entre les étapes : attendre puis refuser (2)', async () => {
    const { parent, repo, lot } = await handedBack();
    const l = store(parent).readLot('a', lot)!;
    l.next = 'implement' as typeof l.next;
    l.status = 'handed-back';
    l.outcome = `${HYPOTHESES_HANDBACK}refusées`;
    store(parent).writeLot(l);
    const sleeper = holder(repo, 'autre-vague');
    try {
      const r = await run(parent, ['--resume', WAVE, '--replay', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(r.out).not.toContain("l'intégration passe entre ses étapes");
      expect(r.code).toBe(2);
    } finally {
      sleeper.kill();
    }
  });
});
