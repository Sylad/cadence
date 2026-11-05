import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelogShapeProblems } from '../src/orchestrate/changelog-merge.js';
import { rebaseOnto, changelogShapeOf } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { claudeOut, git, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, subjects } from './orchestrate-worktree-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L619 — le contrôle de forme du CHANGELOG intégré, joué avant la porte complète.
const PUBLISHED = '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version (L1)\n- seconde (L2)\n  suite de la seconde\n';
const log = (unreleased: string, tail = PUBLISHED) => `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleased}\n${tail}`;

describe('L619 — changelogShapeProblems', () => {
  const main = log('### Added\n\n- autre lot (L5)\n');
  it('R1 — un CHANGELOG sain ne donne aucun problème', () => {
    expect(changelogShapeProblems(log('### Added\n\n- autre lot (L5)\n- le lot (L6)\n\n### Fixed\n\n- correctif (L6)\n'), main)).toEqual([]);
  });
  it('R2 — un titre dupliqué sous [Unreleased] est signalé, nommé', () => {
    const p = changelogShapeProblems(log('### Added\n\n- a (L6)\n\n### Fixed\n\n- b (L6)\n\n### Added\n\n- c (L7)\n'), main);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('### Added');
  });
  it('R3 — une entrée dupliquée sous [Unreleased] est signalée, y compris sous deux titres', () => {
    expect(changelogShapeProblems(log('### Added\n\n- a (L6)\n- a (L6)\n'), main)).toHaveLength(1);
    expect(changelogShapeProblems(log('### Added\n\n- a (L6)\n\n### Fixed\n\n- a (L6)\n'), main)).toHaveLength(1);
  });
  it('R4 — une entrée ajoutée sous une version publiée (absente de la partie publiée de main) est signalée', () => {
    const p = changelogShapeProblems(log('### Added\n\n- autre lot (L5)\n', PUBLISHED.replace('- seconde', '- entrée du lot (L6)\n- seconde')), main);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('entrée du lot (L6)');
  });
  it('R4 — une entrée publiée modifiée (ligne de suite changée) est signalée ; une version publiée intacte, non', () => {
    expect(changelogShapeProblems(log('', PUBLISHED.replace('suite de la seconde', 'autre suite')), log('', PUBLISHED))).toHaveLength(1);
    expect(changelogShapeProblems(log(''), log(''))).toEqual([]);
  });
  it('R4 — une entrée que main porte déjà sous une version n\'est pas un ajout du lot (publication pendant la branche)', () => {
    const released = log('', `## [1.1.0] - 2026-02-01\n\n### Added\n\n- autre lot (L5)\n\n${PUBLISHED}`);
    expect(changelogShapeProblems(released, released)).toEqual([]);
  });
  it('R5 — sans bloc [Unreleased] ou sans main lisible : rien à contrôler, aucun problème inventé', () => {
    expect(changelogShapeProblems('# Changelog\n\n## [1.0.0]\n\n- x\n', main)).toEqual([]);
    expect(changelogShapeProblems(log('### Added\n\n- a\n'), '# Changelog\n')).toEqual([]);
  });
  it('R6 — plusieurs défauts : un message chacun', () => {
    const p = changelogShapeProblems(log('### Added\n\n- a (L6)\n- a (L6)\n\n### Added\n\n- b\n', PUBLISHED + '- glissée (L6)\n'), main);
    expect(p).toHaveLength(3);
  });
});

describe('L619 — au rebase réel', () => {
  function setup() {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), log('### Added\n\n- autre lot (L5)\n'));
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    const put = (d: string, text: string, msg: string) => {
      writeFileSync(join(d, 'CHANGELOG.md'), text);
      git(d, 'add', '--', 'CHANGELOG.md');
      git(d, 'commit', '-q', '-m', msg);
    };
    return { repo, t, put };
  }
  it('R7 — changelogShapeOf rend le défaut d\'un lot qui a écrit sous la version publiée, rien pour un lot sain', () => {
    const bad = setup();
    bad.put(bad.t.dir, log('### Added\n\n- autre lot (L5)\n', PUBLISHED.replace('- seconde', '- entrée du lot (L6)\n- seconde')), 'feat(L6): x');
    bad.put(bad.repo, log('### Added\n\n- autre lot (L5)\n\n### Fixed\n\n- ailleurs (L7)\n'), 'autre');
    expect(rebaseOnto(bad.t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(changelogShapeOf(bad.t.dir, 'main')).toHaveLength(1);
    const ok = setup();
    ok.put(ok.t.dir, log('### Added\n\n- autre lot (L5)\n- le lot (L6)\n'), 'feat(L6): x');
    ok.put(ok.repo, log('### Added\n\n- autre lot (L5)\n\n### Fixed\n\n- ailleurs (L7)\n'), 'autre');
    expect(rebaseOnto(ok.t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(changelogShapeOf(ok.t.dir, 'main')).toEqual([]);
  });
});

describe('L619 — l\'intégration refuse avant la porte complète', () => {
  it('R8 — un lot qui écrit son entrée sous la version publiée est rendu avant que la suite complète soit jouée ; son voisin sain s\'intègre', async () => {
    process.env.CHECK_LOG = join(tempDir(), 'checks.log');
    const files = { 'CHANGELOG.md': log(''), 'check.sh': 'echo run >> "$CHECK_LOG"\n' };
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', files);
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        const path = join(cwd, 'CHANGELOG.md');
        const text = readFileSync(path, 'utf8');
        // L1 écrit sous [Unreleased] ; L2 sous la version publiée, la faute que les reprises à la main du 05-11 corrigeaient.
        writeFileSync(path, lot === 'L1' ? text.replace('## [Unreleased]\n', `## [Unreleased]\n\n### Added\n\n- entrée de ${lot}\n`) : `${text.trimEnd()}\n- entrée de ${lot}\n`);
        writeFileSync(join(cwd, `${lot}.txt`), 'x\n');
        git(cwd, 'add', '--', 'CHANGELOG.md', `${lot}.txt`);
        git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
        return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const bad = store(parent).readLot('a', 'L2')!;
    expect(bad.status).toBe('handed-back');
    expect(bad.outcome).toMatch(/^intégration refusée : CHANGELOG\.md mal formé au sommet intégré \(entrée sous une version publiée.*entrée de L2/);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(r.code).toBe(1);
    expect(subjects(repo).filter((s) => s.startsWith('feat('))).toEqual(['feat(L1): travail']);
  });
});
