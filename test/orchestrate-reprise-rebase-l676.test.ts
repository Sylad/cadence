import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, workReport } from './orchestrate-harness.js';
import { fake, meeting, run, setup, store, WAVE, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L676 — `--resume` d'une vague qui retrouve SA branche de lot : rebase d'abord (règle de l'intégration), sinon lot rendu sans session et branche intacte.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Une vague dont le lot a écrit `L1.txt` puis s'est suspendue au budget : sa branche reste, avec ses commits. */
async function suspended() {
  const { parent, repo } = setup();
  const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
  expect(first.code).toBe(3);
  const branch = `cadence/${WAVE}/a--L1`;
  expect(git(repo, 'rev-list', '--count', `main..${branch}`)).not.toBe('0');
  return { parent, repo, branch };
}

describe('R1 — --resume rebase la branche de la vague avant toute session', () => {
  it('R1 — 120 commits sur main pendant la suspension : la session de la reprise part avec 0 commit de retard, ses commits gardés', async () => {
    const { parent, repo, branch } = await suspended();
    const own = git(repo, 'rev-list', '--count', `main..${branch}`);
    for (let i = 0; i < 120; i++) commitFile(repo, `main-${i}.txt`, `chore: main ${i}`);
    const behind: string[] = [];
    const seen = (cwd: string) => behind.push(git(cwd, 'rev-list', '--count', 'HEAD..main'));
    const f = fake({
      implement: async (cwd) => { seen(cwd); return claudeOut(workReport({ commits: [commitFile(cwd, 'L1-suite.txt', 'feat(L1): suite')] })); },
      fix: async (cwd) => { seen(cwd); return claudeOut(workReport({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): suite')] })); },
      review: async (cwd) => { seen(cwd); return claudeOut((await import('./orchestrate-harness.js')).reviewReport()); },
    });
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], f);
    expect(r.out).toMatch(new RegExp(`branche ${branch.replace(/\//g, '\\/')} rebasée sur main avant la reprise \\(12\\d commit\\(s\\) de main rattrapé\\(s\\)\\)`));
    expect(behind.length).toBeGreaterThan(0);
    expect(behind[0]).toBe('0');
    expect(git(repo, 'log', '--format=%s', 'main')).toContain('feat(L1): travail');
    expect(own).not.toBe('0');
  });
  it('R1 — le rebase échoue (main a écrit le fichier du lot) : lot rendu sans session, état écrit sur disque, branche intacte', async () => {
    const { parent, repo, branch } = await suspended();
    const tip = git(repo, 'rev-parse', branch);
    writeFileSync(join(repo, 'L1.txt'), 'main a écrit le même fichier\n');
    git(repo, 'add', '--', 'L1.txt');
    git(repo, 'commit', '-q', '-m', 'feat: même fichier', '--', 'L1.txt');
    const f = fake();
    const r = await run(parent, ['--resume', WAVE, '--budget', '5M'], f);
    expect(f.calls.filter((c) => c.lot === 'L1')).toEqual([]);
    expect(r.out).toMatch(/branche .* de la vague non rebasée : main a \d+ commit\(s\) d'avance.*le rebase sur main a échoué \(conflit sur L1\.txt\).*lot rendu sans session, branche intacte/);
    expect(git(repo, 'rev-parse', branch)).toBe(tip);
    const onDisk = JSON.parse(readFileSync(join(store(parent).dir, 'a--L1.json'), 'utf8'));
    expect(onDisk.status).toBe('handed-back');
    expect(onDisk.outcome).toContain('le rebase sur main a échoué');
  });
});
