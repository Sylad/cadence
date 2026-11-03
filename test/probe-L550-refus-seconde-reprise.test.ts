import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedStateDir } from '../src/state.js';
import { activeLock, REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, liveWaves, registerWave } from '../src/orchestrate/registry.js';
import { claudeOut, git, reviewReport, workReport, commitFile } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// probe(L550) — la seconde reprise refusée tout de suite : bords (attente nulle, refus répété, enregistrement mort)
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => { process.env.CADENCE_HOME = tempDir(); });
afterEach(() => { process.env.CADENCE_HOME = fileHome; });

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
async function prepare() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      const n = lot === 'L1' ? 4 : 7;
      writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
      git(cwd, 'add', '--', 'f.txt');
      git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
      return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
    },
    'review-small': async () => { git(repo, 'checkout', '-q', '-b', 'autre'); return claudeOut(reviewReport({ verdict: 'ok' })); },
  });
  await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  git(repo, 'checkout', '-q', 'main');
  const lot = f.calls.find((c) => c.kind === 'review-small')!.lot;
  return { parent, repo, lot };
}
function hold(repo: string, parent: string) {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: sleeper.pid, wave: 'autre-vague', started: '2026-10-04T00:00:00Z' }));
  registerWave(cadenceHome(), { pid: sleeper.pid!, wave: '2026-10-04-1412', started: '2026-10-04T00:00:00Z', cwd: parent, repos: [] });
  return sleeper;
}

describe('probe L550 — seconde reprise refusée', () => {
  it('waitMs 0 : la reprise déjà tenue par un vivant est refusée en 2, message exact, verrou intact', async () => {
    const { parent, repo, lot } = await prepare();
    const s = hold(repo, parent);
    try {
      const r = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 0, pollMs: 50 } });
      expect(r.code).toBe(2);
      // La première reprise est inscrite vivante : le garde « tourne encore » refuse, et le verrou du dépôt tenu par une autre vague ajoute son propre refus.
      expect(r.err.trim().split('\n')).toEqual([
        `orchestrate : la vague 2026-10-04-1412 tourne encore (pid ${s.pid}) : à la fin de la vague : cadence orchestrate --resume --wave 2026-10-04-1412 --integrate a:${lot}`, // L554 : le geste
        `orchestrate : a : une orchestration y est déjà en cours (autre-vague, pid ${s.pid})`,
      ]);
      expect(activeLock(join(sharedStateDir(repo), REPO_LOCK))?.pid).toBe(s.pid);
    } finally { s.kill(); }
  });
  it('deux refus de suite : mêmes code et message, verrou et inscription du premier intacts, rien d\'écrit', async () => {
    const { parent, repo, lot } = await prepare();
    const s = hold(repo, parent);
    const before = JSON.stringify(store(parent).readLot('a', lot));
    try {
      for (let i = 0; i < 2; i++) {
        const r = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 20_000, pollMs: 50 } });
        expect(r.code).toBe(2);
        expect(r.err).toContain('tourne encore');
        expect(r.out).not.toContain('attente de sa fin');
      }
      expect(liveWaves(cadenceHome()).map((w) => w.wave)).toEqual(['2026-10-04-1412']);
      expect(activeLock(join(sharedStateDir(repo), REPO_LOCK))?.pid).toBe(s.pid);
      expect(JSON.stringify(store(parent).readLot('a', lot))).toBe(before);
    } finally { s.kill(); }
  });
  it('inscription de la première reprise morte : plus de refus (le processus est mort), la reprise ne sort pas en « tourne encore »', async () => {
    const { parent, repo, lot } = await prepare();
    const s = hold(repo, parent);
    s.kill();
    await new Promise((r) => s.once('exit', r));
    const r = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake({ 'review-small': () => claudeOut(reviewReport({ verdict: 'x' })) }), { repoWait: { waitMs: 2000, pollMs: 50 } });
    expect(r.err).not.toContain('tourne encore');
  });
});
