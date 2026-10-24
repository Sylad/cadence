import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cadenceHome } from '../src/orchestrate/registry.js';
import { waveReadsIntegrate, waveReadsReplay } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { baseBranchOf, lotBranch, lotTreeDir, prepareTree, recoverTree } from '../src/orchestrate/worktree.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { branches, fake, inWorktree, lotOf, planOf, run, setup, store, subjects, WAVE } from './orchestrate-worktree-harness.js';
import { fakeApp } from './fake-app.js';
import { tempDir } from './helpers.js';

// L301 — suite de la revue L279 : chemin de reprise d'un lot rendu hors intégration, worktree hors du dépôt, intégration après l'arrêt de l'application UX, lecteurs d'instantané.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const nonConforme = reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'f.txt', ligne: 1, texte: 'cassé' }], verdict: 'non conforme' });

/** Une branche de lot d'une vague passée : créée par prepareTree, avec `n` commits de travail du lot. */
function oldBranch(repo: string, wave: string, lot: string, n: number, created?: number): { branch: string; dir: string } {
  const dir = lotTreeDir(join(repo, '..', `.cadence-${wave}`), 'a', lot);
  const branch = lotBranch(wave, 'a', lot);
  const made = prepareTree({ repo, dir, branch, base: 'main', lot: `a:${lot}` });
  if (!made.ok) throw new Error(made.cause);
  for (let i = 0; i < n; i++) commitFile(dir, `${wave}-${lot}-${i}.txt`, `feat(${lot}): travail ${i}`);
  if (created !== undefined) git(repo, 'config', '--local', `branch.${branch}.cadence-created`, String(created));
  return { branch, dir };
}

describe('R1 — un lot rendu hors intégration reprend sa branche dans une nouvelle vague', () => {
  it('R1 — lot rendu sur une revue non conforme : la nouvelle vague du même lot rejoue dans le worktree de sa branche, commits d\'avant compris, et l\'intègre', async () => {
    const { parent, repo } = setup();
    const f1 = fake({ review: async (_cwd, brief) => claudeOut(lotOf(brief) === 'L1' ? nonConforme : reviewReport()) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f1);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(branches(repo)).toContain(`cadence/${WAVE}/a--L1`);
    const f2 = fake({ implement: async (cwd) => {
      expect(existsSync(join(cwd, 'L1-implement.txt'))).toBe(true); // le travail de la première vague est là
      return claudeOut(workReport({ commits: [commitFile(cwd, 'L1-suite.txt', 'feat(L1): suite')] }));
    } });
    const r = await run(parent, ['a:L1'], f2);
    expect(r.out).toContain(`orchestrate : a:L1 : branche cadence/${WAVE}/a--L1 d'une vague précédente reprise`);
    expect(f2.calls.filter((c) => c.kind === 'implement').every((c) => inWorktree(c.cwd))).toBe(true);
    expect(new RunStore(parent, `${WAVE}-2`).readLot('a', 'L1')!.status).toBe('ready');
    expect(branches(repo)).toBe(''); // branche intégrée puis retirée, plus de branche de la vague passée
    expect(git(repo, 'ls-files')).toContain('L1-implement.txt');
    expect(git(repo, 'ls-files')).toContain('L1-suite.txt');
    expect(planOf(repo).lot('L1').review!.verdict).toContain('orchestré');
  });
});

describe('R1 — recoverTree retrouve la branche la plus récente du lot', () => {
  it('R1 — deux branches de vagues passées : la plus récente par date de création est renommée au nom de la nouvelle vague, son worktree déplacé, sa config gardée', () => {
    const { repo, parent } = setup();
    const older = oldBranch(repo, 'w1', 'L1', 1, 1000);
    const newer = oldBranch(repo, 'w2', 'L1', 2, 2000);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w3'), 'a', 'L1');
    const branch = lotBranch('w3', 'a', 'L1');
    expect(recoverTree(repo, branch, dir, 'main')).toEqual({ from: newer.branch, unintegrated: 2 });
    expect(baseBranchOf(repo, branch)).toBe('main');
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').split('\n').sort()).toEqual([older.branch, branch].sort());
    expect(existsSync(newer.dir)).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(existsSync(join(dir, 'w2-L1-1.txt'))).toBe(true);
  });
  it('R1 — branche sans worktree (dossier retiré) : la branche seule est renommée, aucun dossier créé', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'w1', 'L1', 1);
    git(repo, 'worktree', 'remove', '--force', old.dir);
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'a', 'L1');
    expect(recoverTree(repo, lotBranch('w2', 'a', 'L1'), dir, 'main')?.from).toBe(old.branch);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'cadence/*')).toContain('cadence/w2/a--L1');
  });
  it('R1 — rien à reprendre : branche déjà intégrée, autre lot, autre branche de départ, branche qui n\'est pas celle de cadence', () => {
    const { repo, parent } = setup();
    const done = oldBranch(repo, 'w1', 'L1', 1);
    git(repo, 'merge', '--ff-only', '-q', done.branch); // intégrée
    oldBranch(repo, 'w1', 'L2', 1); // un autre lot
    const other = oldBranch(repo, 'w2', 'L3', 1);
    git(repo, 'config', '--local', `branch.${other.branch}.cadence-base`, 'develop'); // partie d'une autre branche
    git(repo, 'branch', 'cadence/w0/a--L4'); // pas de config cadence
    const at = (lot: string) => recoverTree(repo, lotBranch('w9', 'a', lot), lotTreeDir(join(parent, 'w9'), 'a', lot), 'main');
    expect(at('L1')).toBeNull();
    expect(at('L3')).toBeNull();
    expect(at('L4')).toBeNull();
    expect(at('L5')).toBeNull();
  });
  it('R1 — la branche de la vague elle-même n\'est jamais « reprise »', () => {
    const { repo, parent } = setup();
    const own = oldBranch(repo, 'w1', 'L1', 1);
    expect(recoverTree(repo, own.branch, lotTreeDir(join(parent, 'w1'), 'a', 'L1'), 'main')).toBeNull();
  });
});

describe('R1 — recoverTree refuse une branche que la reprise ne mènerait pas à l\'intégration', () => {
  it('R1 — worktree avec un fichier suivi modifié : rien n\'est déplacé ni renommé, la raison est rendue', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'w1', 'L1', 1);
    writeFileSync(join(old.dir, 'w1-L1-0.txt'), 'modifié sans commit\n');
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'a', 'L1');
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), dir, 'main');
    expect(got).toEqual({ from: old.branch, refused: expect.stringContaining('w1-L1-0.txt') });
    expect(existsSync(old.dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim()).toBe(old.branch);
  });
  it('R1 — un commit de la branche touche le plan : la branche n\'est pas reprise, intacte', () => {
    const { repo, parent } = setup();
    const old = oldBranch(repo, 'w1', 'L1', 1);
    commitFile(old.dir, 'docs/plan/raf.yaml', 'feat(L1): plan');
    const dir = lotTreeDir(join(parent, '.cadence', 'runs', 'w2'), 'a', 'L1');
    const got = recoverTree(repo, lotBranch('w2', 'a', 'L1'), dir, 'main', new Set(['docs/plan/raf.yaml']));
    expect(got).toEqual({ from: old.branch, refused: expect.stringContaining('docs/plan/raf.yaml') });
    expect(existsSync(old.dir)).toBe(true);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'cadence/*').trim()).toBe(old.branch);
  });
  it('R1 — vague : un lot rendu avec du travail non commité n\'est pas repris, le journal le dit et la session ne démarre pas sur un arbre sale', async () => {
    const { parent, repo } = setup();
    const f1 = fake({ review: async (_cwd, brief) => claudeOut(lotOf(brief) === 'L1' ? nonConforme : reviewReport()) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f1);
    const dir = git(repo, 'worktree', 'list', '--porcelain').split('\n').find((l) => l.startsWith('worktree ') && l.includes('a--L1'))!.slice(9);
    writeFileSync(join(dir, 'L1-implement.txt'), 'à moitié\n');
    const f2 = fake();
    const r = await run(parent, ['a:L1'], f2);
    expect(r.out).toContain('non reprise');
    expect(r.out).toContain('L1-implement.txt');
    expect(r.out).not.toContain('une vague précédente reprise');
  });
});

describe('R1 — plan touché : la reprise ne rejoue pas un commit de plan jusqu\'à un conflit d\'intégration', () => {
  it('R1 — la vague 1 rend le lot (plan touché), la vague 2 ne reprend pas sa branche et le dit', async () => {
    const { parent, repo } = setup();
    const f1 = fake({ implement: async (cwd) => claudeOut(workReport({ commits: [commitFile(cwd, 'docs/plan/raf.yaml', 'feat(L1): plan')] })) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f1);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    const r = await run(parent, ['a:L1'], fake());
    expect(r.out).toContain('non reprise');
    expect(r.out).toContain('docs/plan/raf.yaml');
    expect(r.out).not.toContain('une vague précédente reprise');
    expect(branches(repo)).toContain(`cadence/${WAVE}/a--L1`);
  });
});

describe('R2 — le worktree d\'une vague lancée à la racine du dépôt est hors du dépôt', () => {
  it('R2 — lotTreeDir : vague dans le dépôt → sous le dossier des worktrees de cadence ; vague hors du dépôt → sous la vague', () => {
    const { repo, parent } = setup();
    const inside = join(repo, '.cadence', 'runs', 'w1');
    mkdirSync(inside, { recursive: true });
    const dir = lotTreeDir(inside, 'a', 'L1', repo);
    expect(dir.startsWith(join(cadenceHome(), 'worktrees'))).toBe(true);
    expect(dir.endsWith(join('a--L1'))).toBe(true);
    expect(dir).not.toBe(lotTreeDir(join(repo, '.cadence', 'runs', 'w2'), 'a', 'L1', repo)); // deux vagues, deux dossiers
    const outside = join(parent, '.cadence', 'runs', 'w1');
    expect(lotTreeDir(outside, 'a', 'L1', repo)).toBe(join(outside, 'worktrees', 'a--L1'));
  });
  it('R2 — vague lancée depuis la racine du dépôt : les sessions jouent dans un worktree hors du dépôt, rien d\'imprévu dans son arbre', async () => {
    const { repo } = setup();
    const f = fake();
    const r = await run(repo, ['.:L1', '.:L2', '--max-sessions', '2'], f);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const c of f.calls.filter((k) => k.kind === 'implement')) {
      expect(inWorktree(c.cwd)).toBe(true);
      expect(c.cwd.startsWith(join(cadenceHome(), 'worktrees'))).toBe(true);
      expect(c.cwd.startsWith(`${repo}/`)).toBe(false);
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('R3 — l\'intégration a lieu une fois l\'application UX arrêtée', () => {
  it('R3 — à l\'avance de la branche du dépôt, l\'application de la revue UX ne répond plus', async () => {
    const app = await fakeApp(0);
    const { parent, repo } = setup([{ title: 'un', estimate: 1, visible: true }, { title: 'deux' }], `worktrees: true\nux: { command: '${app.command}', url: '${app.url}', timeout: 5 }`);
    const f = fake({ ux: async () => claudeOut(reviewReport()) });
    // Un hook post-merge note, à chaque avance de la branche du dépôt, si l'application répond encore.
    const seen = join(tempDir(), 'avances.txt');
    const hook = join(repo, '.git', 'hooks', 'post-merge');
    writeFileSync(hook, `#!/bin/sh\nnode -e "fetch(process.argv[1]).then(() => 'up', () => 'down').then((r) => require('fs').appendFileSync(process.argv[2], process.argv[3] + ' ' + r + '\\n'))" '${app.url}' '${seen}' "$(git log -1 --format=%s)"\n`, { mode: 0o755 });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(f.calls.filter((c) => c.kind === 'ux')).toHaveLength(1);
    expect(r.code).toBe(0);
    expect(subjects(repo).some((s) => s.startsWith('feat(L1)'))).toBe(true);
    expect(readFileSync(seen, 'utf8').split('\n').filter((l) => l.startsWith('feat(L1)'))).toEqual(['feat(L1): travail down']);
  });
});

describe('R4 — l\'instantané de la vague connaît --integrate et --replay', () => {
  const snapshot = (command: string | null): string => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tool', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'tool', 'bin', 'cadence.js'), '');
    if (command !== null) {
      mkdirSync(join(dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
      writeFileSync(join(dir, 'tool', 'dist', 'orchestrate', 'command.js'), command);
    }
    return dir;
  };
  it('R4 — sans instantané : on suppose que oui (rien à relire)', () => {
    const dir = tempDir();
    expect(waveReadsIntegrate(dir)).toBe(true);
    expect(waveReadsReplay(dir)).toBe(true);
  });
  it('R4 — un instantané dont command.js porte --integrate (abandonCommits) et --replay : oui', () => {
    const dir = snapshot("a.abandonCommits = true; if (t === '--replay') {}");
    expect(waveReadsIntegrate(dir)).toBe(true);
    expect(waveReadsReplay(dir)).toBe(true);
  });
  it('R4 — un instantané d\'avant --replay : --integrate oui, --replay non ; d\'avant L279 : ni l\'un ni l\'autre', () => {
    const avantReplay = snapshot('a.abandonCommits = true;');
    expect(waveReadsIntegrate(avantReplay)).toBe(true);
    expect(waveReadsReplay(avantReplay)).toBe(false);
    const avantL279 = snapshot('// ancien');
    expect(waveReadsIntegrate(avantL279)).toBe(false);
    expect(waveReadsReplay(avantL279)).toBe(false);
  });
  it('R4 — un instantané sans command.js illisible : non', () => {
    const dir = snapshot(null);
    expect(waveReadsIntegrate(dir)).toBe(false);
    expect(waveReadsReplay(dir)).toBe(false);
  });
});
