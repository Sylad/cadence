import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourRow, tourStaleBranchLines } from '../src/lead.js';
import { gitRepo } from './helpers.js';

// Sonde L676 : la forme réelle des données (branche git de cadence réelle, lue par le tour), pas une fixture bâtie pour le code.
const H = 3600_000;
const git = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

function repoWithBranch(opts: { lot?: string; createdMsAgo: number; commits: number }): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), 'version: 1\nproject: demo\nprefix: L\nlots:\n  - id: L1\n    title: "T"\n    status: todo\n    estimate: 1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const b = 'cadence/2026-11-01-0800/demo--L1';
  git(dir, 'branch', b);
  git(dir, 'config', '--local', `branch.${b}.cadence-base`, 'main');
  if (opts.lot) git(dir, 'config', '--local', `branch.${b}.cadence-lot`, opts.lot);
  git(dir, 'config', '--local', `branch.${b}.cadence-created`, String(Date.now() - opts.createdMsAgo));
  git(dir, 'checkout', '-q', b);
  for (let i = 0; i < opts.commits; i++) {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `c${i}`);
  }
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

describe('lead tour — branche vieille, données réelles (L676)', () => {
  it('R2 — une vraie branche de lot de 3 j avec 2 commits : le tour lit ses worktrees et marque ⚠ avec les deux gestes', () => {
    const dir = repoWithBranch({ lot: 'demo:L1', createdMsAgo: 72 * H, commits: 2 });
    const lines = tourStaleBranchLines([tourRow(dir, '2026-11-07')], Date.now());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 commit(s) non intégré(s)');
    expect(lines[0]).toContain('--resume --wave 2026-11-01-0800 --integrate demo:L1');
  });
  it('R2 — une vraie branche de 3 j sans commit non intégré : aucun ⚠', () => {
    const dir = repoWithBranch({ lot: 'demo:L1', createdMsAgo: 72 * H, commits: 0 });
    expect(tourStaleBranchLines([tourRow(dir, '2026-11-07')], Date.now())).toEqual([]);
  });
  it('R2 — une vraie branche de 47 h avec commits : aucun ⚠', () => {
    const dir = repoWithBranch({ lot: 'demo:L1', createdMsAgo: 47 * H, commits: 1 });
    expect(tourStaleBranchLines([tourRow(dir, '2026-11-07')], Date.now())).toEqual([]);
  });
  it('R2 — la même ligne ne sort pas deux fois si la liste est lue deux fois', () => {
    const dir = repoWithBranch({ lot: 'demo:L1', createdMsAgo: 72 * H, commits: 1 });
    const row = tourRow(dir, '2026-11-07');
    expect(tourStaleBranchLines([row], Date.now())).toHaveLength(1);
    expect(tourStaleBranchLines([row], Date.now())).toHaveLength(1);
  });
});
