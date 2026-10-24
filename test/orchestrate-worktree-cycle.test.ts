import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { branches, fake, inWorktree, lotOf, meeting, run, setup, store, subjects, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L279 — un worktree par lot dans une vague : e2e de bout en bout, vrais dépôts git, sessions simulées.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

describe('R1 — sans orchestrate.worktrees', () => {
  it('R1 — sans orchestrate.worktrees, deux lots du même dépôt jouent à la suite dans le dépôt, aucun worktree créé', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], '');
    let active = 0;
    let peak = 0;
    const f = fake({
      implement: writes(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      }),
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(peak).toBe(1);
    expect(f.calls.every((c) => c.cwd === repo)).toBe(true);
    expect(branches(repo)).toBe('');
    expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
  });
});

describe('C1 / R3 / R10 / R12 — deux lots indépendants du même dépôt en parallèle, chacun dans son worktree', () => {
  it('C1 — chaque session joue dans le worktree de son lot, les deux lots sont intégrés, worktrees et branches retirés (R12)', async () => {
    const { parent, repo } = setup();
    const f = fake({ implement: writes(meeting(2)) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(f.calls.every((c) => inWorktree(c.cwd))).toBe(true);
    expect(new Set(f.calls.map((c) => c.cwd)).size).toBe(2);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(existsSync(join(repo, 'L1.txt'))).toBe(true);
    expect(existsSync(join(repo, 'L2.txt'))).toBe(true);
    expect(branches(repo)).toBe(''); // R12 : intégrés, retirés
    expect(readdirSync(join(store(parent).dir, 'worktrees'))).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
  it('R10 — deux lots prêts en même temps : intégrés l\'un après l\'autre, historique linéaire', async () => {
    const { parent, repo } = setup();
    const meet = meeting(2);
    const f = fake({
      review: async () => {
        await meet();
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '--merges', '--format=%h')).toBe('');
    const s = subjects(repo);
    expect(s.filter((x) => x.startsWith('feat(L1)'))).toHaveLength(1);
    expect(s.filter((x) => x.startsWith('feat(L2)'))).toHaveLength(1);
    expect(r.out).toMatch(/a:L1 intégré : [0-9a-f]{7}\.\.[0-9a-f]{7}/);
    expect(r.out).toMatch(/a:L2 intégré : [0-9a-f]{7}\.\.[0-9a-f]{7}/);
  });
  it('R3 — trois lots indépendants d\'un dépôt, plafond 2 : jamais plus de deux sessions simultanées, le troisième n\'a ni worktree ni branche avant sa place', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }, { title: 'trois' }]);
    const meet = meeting(2);
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const f = fake({
      implement: async (cwd, brief) => {
        active++;
        peak = Math.max(peak, active);
        const lot = lotOf(brief);
        if (lot !== 'L3') {
          await meet();
          seen.push(branches(repo)); // pendant que L1 et L2 jouent, L3 attend sa place
        }
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', 'a:L3', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(peak).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
    for (const b of seen) {
      expect(b).toContain('a--L1');
      expect(b).toContain('a--L2');
      expect(b).not.toContain('a--L3');
    }
    expect(['L1', 'L2', 'L3'].every((l) => existsSync(join(repo, `${l}.txt`)))).toBe(true);
  });
  it('R3 — plafond 1 : les lots s\'enchaînent, aucun refus', async () => {
    const { parent } = setup();
    let active = 0;
    let peak = 0;
    const f = fake({
      implement: writes(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      }),
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f);
    expect(r.code).toBe(0);
    expect(peak).toBe(1);
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
});
