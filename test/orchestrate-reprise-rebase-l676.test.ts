import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { rebaseOwnBranch, reviewedHead } from '../src/orchestrate/reprise-rebase.js';
import { redSha } from '../src/orchestrate/accept.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
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

describe('R2 — le rebase de --resume reporte les shas que l\'état garde (revue conforme, ancre du commit rouge)', () => {
  const ACC = 'docs/specs/ecran/acceptation-L1.json';
  /** Une branche de la vague avec un commit rouge d'acceptation puis un commit de travail, main avancé d'un commit ; l'état garde la revue conforme au sommet et l'ancre du commit rouge. */
  function lotState() {
    const { parent, repo } = setup();
    const branch = lotBranch(WAVE, 'a', 'L1');
    const dir = lotTreeDir(store(parent).dir, 'a', 'L1', repo);
    const made = prepareTree({ repo, dir, branch, base: 'main', lot: 'a:L1' });
    if (!made.ok) throw new Error(made.cause);
    mkdirSync(join(dir, 'docs/specs/ecran'), { recursive: true });
    writeFileSync(join(dir, ACC), '{"fichiers":[]}\n');
    git(dir, 'add', '--', ACC);
    git(dir, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', ACC);
    const rouge = git(dir, 'rev-parse', 'HEAD');
    commitFile(dir, 'L1.txt', 'feat(L1): travail');
    const head = git(dir, 'rev-parse', 'HEAD');
    const work = head;
    commitFile(repo, 'main-1.txt', 'chore: main');
    const logs: string[] = [];
    const lot = { project: 'a', lot: 'L1', repo, status: 'suspended', next: 'fix', steps: [], constats: [], warnings: [], code: { conforme: true, bloquants: 0, majeurs: 0, mineurs: 1, verdict: 'conforme', sousTaches: [], nonVerifie: [], head }, accept: { acceptation: ACC, rouge } };
    const c = { lot, wave: { store: store(parent), log: (l: string) => logs.push(l) } } as never as LotCtx;
    return { parent, repo, branch, dir, c, lot, logs, rouge, head, work };
  }
  it('R2 — revue conforme gardée : code.head suit le sommet rebasé, conclude ne voit pas « un commit postérieur à la revue »', () => {
    const s = lotState();
    rebaseOwnBranch(s.c, { repo: s.repo, branch: s.branch, dir: s.dir, base: 'main', recovered: false });
    expect(s.lot.status).toBe('suspended');
    expect(git(s.dir, 'rev-list', '--count', 'HEAD..main')).toBe('0');
    expect(s.lot.code.head).not.toBe(s.head);
    expect(s.lot.code.head).toBe(git(s.dir, 'rev-parse', 'HEAD'));
    expect(s.logs.join('\n')).toContain('revue de code gardée reporté(e) sur le commit rebasé');
    expect(store(s.parent).readLot('a', 'L1')?.code?.head).toBe(s.lot.code.head);
  });
  it('R2 — ancre du commit rouge : accept.rouge suit le commit rouge rebasé, le verrou n\'y voit pas de réécriture', () => {
    const s = lotState();
    rebaseOwnBranch(s.c, { repo: s.repo, branch: s.branch, dir: s.dir, base: 'main', recovered: false });
    expect(s.lot.accept.rouge).not.toBe(s.rouge);
    expect(s.lot.accept.rouge).toBe(redSha(s.dir, ACC));
  });
  it('R2 — report impossible (un commit du lot déjà dans main) : branche remise à son sommet, lot rendu sans session, cause au journal', () => {
    const s = lotState();
    git(s.repo, 'cherry-pick', s.work);
    rebaseOwnBranch(s.c, { repo: s.repo, branch: s.branch, dir: s.dir, base: 'main', recovered: false });
    expect(s.lot.status).toBe('handed-back');
    expect(git(s.repo, 'rev-parse', s.branch)).toBe(s.head);
    expect(s.lot.code.head).toBe(s.head);
    expect(s.logs.join('\n')).toMatch(/remise à son sommet .*ne peuvent pas être reportées/);
  });
  it('R2 — publication pendant la branche : les commits que rebaseOnto ajoute en queue (CHANGELOG replacé) sont acceptés, la revue reste sur le dernier commit du lot et n\'est pas périmée', () => {
    const doc = (unreleased: string, releases = '') => `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleased}${releases}## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n`;
    const { parent, repo } = setup(undefined, undefined, { 'CHANGELOG.md': doc('### Fixed\n\n- entrée de main\n\n') });
    const branch = lotBranch(WAVE, 'a', 'L1');
    const dir = lotTreeDir(store(parent).dir, 'a', 'L1', repo);
    const made = prepareTree({ repo, dir, branch, base: 'main', lot: 'a:L1' });
    if (!made.ok) throw new Error(made.cause);
    writeFileSync(join(dir, 'CHANGELOG.md'), doc('### Fixed\n\n- entrée de main\n- entrée du lot (L1)\n\n'));
    writeFileSync(join(dir, 'L1.txt'), 'travail\n');
    git(dir, 'add', '--', 'CHANGELOG.md', 'L1.txt');
    git(dir, 'commit', '-q', '-m', 'feat(L1): travail', '--', 'CHANGELOG.md', 'L1.txt');
    const head = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'CHANGELOG.md'), doc('', '## [1.1.0] - 2026-11-06\n\n### Fixed\n\n- entrée de main\n\n'));
    git(repo, 'commit', '-q', '-m', 'chore(release): 1.1.0', '--', 'CHANGELOG.md');
    const logs: string[] = [];
    const lot = { project: 'a', lot: 'L1', repo, status: 'suspended', next: 'fix', steps: [], constats: [], warnings: [], code: { conforme: true, bloquants: 0, majeurs: 0, mineurs: 1, verdict: 'conforme', sousTaches: [], nonVerifie: [], head } } as never as LotCtx['lot'];
    const c = { lot, wave: { store: store(parent), log: (l: string) => logs.push(l) } } as never as LotCtx;
    rebaseOwnBranch(c, { repo, branch, dir, base: 'main', recovered: false });
    expect(logs.join('\n')).not.toContain('remise à son sommet');
    expect(lot.status).toBe('suspended');
    const lotTip = git(dir, 'log', '-1', '--format=%H', '--grep', 'feat(L1)');
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(lotTip); // un commit du programme en queue
    expect(lot.code?.head).toBe(lotTip);
    expect(lot.rebaseTail?.length).toBeGreaterThan(0);
    expect(reviewedHead(dir, lot)).toBe(true);
    expect(logs.join('\n')).toContain('la revue gardée reste sur le dernier commit du lot');
    const changelog = git(dir, 'show', 'HEAD:CHANGELOG.md');
    expect(changelog.indexOf('entrée du lot')).toBeLessThan(changelog.indexOf('## [1.1.0]'));
  });
});
