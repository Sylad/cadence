import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { mergeUnreleased, moveToUnreleased } from '../src/orchestrate/changelog-merge.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L314 — conflit d'ajout pur dans le CHANGELOG à l'intégration : union par section sous [Unreleased], le reste reste rendu.
const log = (unreleased: string, tail = '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n') =>
  `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleased}\n${tail}`;
const unreleased = (t: string) => t.slice(t.indexOf('## [Unreleased]'), t.indexOf('## [1.0.0]'));
const BASE = log('### Added\n\n- base A\n');

describe('R1 — union par section de deux ajouts sous [Unreleased]', () => {
  it('R1 — deux entrées ajoutées à la même section : les deux restent, celle de base d\'abord, ours puis theirs', () => {
    const ours = log('### Added\n\n- base A\n- entrée ours\n');
    const theirs = log('### Added\n\n- base A\n- entrée theirs\n');
    const out = mergeUnreleased(BASE, ours, theirs);
    expect(out).toBe(log('### Added\n\n- base A\n- entrée ours\n- entrée theirs\n'));
  });
  it('R1 — la même entrée ajoutée des deux côtés n\'est écrite qu\'une fois', () => {
    const both = log('### Added\n\n- base A\n- même\n');
    expect(mergeUnreleased(BASE, both, both)).toBe(both);
  });
  it('R1 — une entrée sur plusieurs lignes reste un bloc', () => {
    const ours = log('### Added\n\n- base A\n- longue\n  suite\n');
    const theirs = log('### Added\n\n- base A\n- autre\n');
    expect(mergeUnreleased(BASE, ours, theirs)).toBe(log('### Added\n\n- base A\n- longue\n  suite\n- autre\n'));
  });
});

describe('R2 — un seul titre par section, ordre Keep a Changelog', () => {
  it('R2 — ### Added d\'un côté, ### Fixed de l\'autre : une section chacun, Added avant Fixed', () => {
    const ours = log('### Fixed\n\n- correctif ours\n\n### Added\n\n- base A\n');
    const theirs = log('### Added\n\n- base A\n- ajout theirs\n');
    const out = mergeUnreleased(BASE, ours, theirs)!;
    expect(out).toBe(log('### Added\n\n- base A\n- ajout theirs\n\n### Fixed\n\n- correctif ours\n'));
    expect(unreleased(out).match(/^### Added$/gm)).toHaveLength(1);
  });
  it('R2 — Changed, Fixed et Security sont rangés dans l\'ordre Added, Changed, Deprecated, Removed, Fixed, Security', () => {
    const ours = log('### Security\n\n- s\n\n### Added\n\n- base A\n');
    const theirs = log('### Fixed\n\n- f\n\n### Added\n\n- base A\n\n### Changed\n\n- c\n');
    const heads = (unreleased(mergeUnreleased(BASE, ours, theirs)!).match(/^### .*$/gm) ?? []);
    expect(heads).toEqual(['### Added', '### Changed', '### Fixed', '### Security']);
  });
  it('R2 — deux titres identiques d\'un même côté sont fondus en un seul', () => {
    const ours = log('### Added\n\n- base A\n- x\n\n### Fixed\n\n- f1\n\n### Added\n\n- y\n');
    const out = mergeUnreleased(BASE, ours, BASE)!;
    expect(out).toBe(log('### Added\n\n- base A\n- x\n- y\n\n### Fixed\n\n- f1\n'));
  });
});

describe('R3 — seul un ajout pur est résolu', () => {
  it('R3 — une entrée de base modifiée d\'un côté : null', () => {
    const ours = log('### Added\n\n- base A modifiée\n');
    const theirs = log('### Added\n\n- base A\n- ajout\n');
    expect(mergeUnreleased(BASE, ours, theirs)).toBeNull();
  });
  it('R3 — une entrée de base supprimée d\'un côté : null', () => {
    const ours = log('### Added\n\n- autre\n');
    expect(mergeUnreleased(BASE, ours, BASE)).toBeNull();
  });
  it('R3 — du texte libre sous [Unreleased] hors section : null', () => {
    const ours = log('note libre\n\n### Added\n\n- base A\n');
    expect(mergeUnreleased(BASE, ours, BASE)).toBeNull();
  });
  it('R3 — le reste du fichier modifié des deux côtés différemment : null ; d\'un seul côté : repris', () => {
    const tail = (t: string) => `## [1.0.0] - 2026-01-01\n\n- ${t}\n`;
    const base = log('### Added\n\n- base A\n', tail('v'));
    expect(mergeUnreleased(base, log('### Added\n\n- base A\n- o\n', tail('o')), log('### Added\n\n- base A\n- t\n', tail('t')))).toBeNull();
    expect(mergeUnreleased(base, log('### Added\n\n- base A\n- o\n', tail('v')), log('### Added\n\n- base A\n- t\n', tail('t')))).toBe(
      log('### Added\n\n- base A\n- o\n- t\n', tail('t')),
    );
  });
  it('R3 — pas de section [Unreleased] : null', () => {
    expect(mergeUnreleased('# c\n', '# c\n- a\n', '# c\n- b\n')).toBeNull();
  });
});

describe('R4 — au rebase d\'intégration', () => {
  function setup(extra?: (repo: string, dir: string) => void) {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), BASE);
    writeFileSync(join(repo, 'f.txt'), 'f\n');
    git(repo, 'add', '--', 'CHANGELOG.md', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    const put = (d: string, f: string, text: string, msg: string) => {
      writeFileSync(join(d, f), text);
      git(d, 'add', '--', f);
      git(d, 'commit', '-q', '-m', msg);
    };
    put(t.dir, 'CHANGELOG.md', log('### Added\n\n- base A\n- entrée du lot\n'), 'feat(L1): lot');
    put(repo, 'CHANGELOG.md', log('### Added\n\n- base A\n- entrée de main\n\n### Fixed\n\n- correctif de main\n'), 'feat(L2): autre lot');
    extra?.(repo, t.dir);
    return { repo, t, put };
  }
  it('R4 — deux lots ajoutent une entrée : le rebase réussit, l\'union est commitée, aucun rebase en cours', () => {
    const { t } = setup();
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'rebased', changelog: 1, moved: 0 });
    expect(readFileSync(join(t.dir, 'CHANGELOG.md'), 'utf8')).toBe(
      log('### Added\n\n- base A\n- entrée de main\n- entrée du lot\n\n### Fixed\n\n- correctif de main\n'),
    );
    expect(git(t.dir, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(git(t.dir, 'rev-parse', '--git-dir'), 'rebase-merge'))).toBe(false);
  });
  it('R4 — deux commits du lot touchent le CHANGELOG : chacun est résolu, un seul titre à la fin', () => {
    const { t, put } = setup();
    put(t.dir, 'CHANGELOG.md', log('### Added\n\n- base A\n- entrée du lot\n\n### Changed\n\n- seconde du lot\n'), 'feat(L1): suite');
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'rebased', changelog: 2 });
    const text = readFileSync(join(t.dir, 'CHANGELOG.md'), 'utf8');
    expect(unreleased(text).match(/^### Added$/gm)).toHaveLength(1);
    expect(text).toContain('- seconde du lot');
  });
  it('R4 — le CHANGELOG et un autre fichier en conflit : rebase abandonné, les deux fichiers listés, worktree intact', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), BASE);
    writeFileSync(join(repo, 'f.txt'), 'f\n');
    git(repo, 'add', '--', 'CHANGELOG.md', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    writeFileSync(join(t.dir, 'CHANGELOG.md'), log('### Added\n\n- base A\n- lot\n'));
    writeFileSync(join(t.dir, 'f.txt'), 'f du lot\n');
    git(t.dir, 'add', '--', 'CHANGELOG.md', 'f.txt');
    git(t.dir, 'commit', '-q', '-m', 'feat(L1): lot');
    const tip = git(t.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'CHANGELOG.md'), log('### Added\n\n- base A\n- main\n'));
    writeFileSync(join(repo, 'f.txt'), 'f de main\n');
    git(repo, 'add', '--', 'CHANGELOG.md', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'autre');
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'conflict', files: ['CHANGELOG.md', 'f.txt'] });
    expect(git(t.dir, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
  it('R4 — le CHANGELOG modifié sur une entrée de base : conflit rendu, rebase abandonné', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), BASE);
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    writeFileSync(join(t.dir, 'CHANGELOG.md'), log('### Added\n\n- base A du lot\n'));
    git(t.dir, 'add', '--', 'CHANGELOG.md');
    git(t.dir, 'commit', '-q', '-m', 'feat(L1): lot');
    const tip = git(t.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'CHANGELOG.md'), log('### Added\n\n- base A de main\n'));
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'autre');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'conflict', files: ['CHANGELOG.md'] });
    expect(git(t.dir, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('R4 — commit devenu vide', () => {
  it('R4 — la même entrée ajoutée des deux côtés : le commit du lot devenu vide ne bloque pas le rebase', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), BASE);
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    writeFileSync(join(t.dir, 'x.txt'), 'x\n');
    writeFileSync(join(t.dir, 'CHANGELOG.md'), log('### Added\n\n- base A\n- même\n'));
    git(t.dir, 'add', '--', 'x.txt', 'CHANGELOG.md');
    git(t.dir, 'commit', '-q', '-m', 'feat(L1): lot');
    writeFileSync(join(repo, 'CHANGELOG.md'), log('### Added\n\n- base A\n- même\n'));
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'autre');
    expect(rebaseOnto(t.dir, 'main').kind).toBe('rebased');
    expect(readFileSync(join(t.dir, 'CHANGELOG.md'), 'utf8')).toBe(log('### Added\n\n- base A\n- même\n'));
  });
});

// L323 — un lot réécrit SA PROPRE entrée dans un commit suivant : l'entrée de base absente du point de départ est la sienne, la version de theirs gagne.
describe('R5 — l\'entrée du lot rejoué peut être modifiée ou retirée par un commit suivant', () => {
  const START = BASE;
  const lotBase = log('### Added\n\n- base A\n- entrée du lot\n');
  const withMain = log('### Added\n\n- base A\n- entrée du lot\n- entrée de main\n');
  it('R5 — une entrée ajoutée par le lot et réécrite par theirs : la version de theirs gagne, l\'entrée voisine de main reste', () => {
    const theirs = log('### Added\n\n- base A\n- entrée du lot précisée\n');
    expect(mergeUnreleased(lotBase, withMain, theirs, START)).toBe(log('### Added\n\n- base A\n- entrée de main\n- entrée du lot précisée\n'));
  });
  it('R5 — une entrée ajoutée par le lot et retirée par theirs : elle disparaît, celle de main reste', () => {
    expect(mergeUnreleased(lotBase, withMain, BASE, START)).toBe(log('### Added\n\n- base A\n- entrée de main\n'));
  });
  it('R5 — une entrée présente au point de départ et modifiée reste un conflit à la main', () => {
    const theirs = log('### Added\n\n- base A modifiée\n- entrée du lot\n');
    expect(mergeUnreleased(lotBase, withMain, theirs, START)).toBeNull();
  });
  it('R5 — sans point de départ connu, une entrée de base modifiée reste un conflit', () => {
    const theirs = log('### Added\n\n- base A\n- entrée du lot précisée\n');
    expect(mergeUnreleased(lotBase, withMain, theirs)).toBeNull();
  });
  it('R5 — au rebase : deux commits du lot (le second précise l\'entrée du premier), une entrée voisine arrivée sur main', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), BASE);
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
    put(t.dir, lotBase, 'feat(L1): lot');
    put(t.dir, log('### Added\n\n- base A\n- entrée du lot précisée\n'), 'fix(L1): précise');
    put(repo, log('### Added\n\n- base A\n- entrée de main\n'), 'feat(L2): autre lot');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased', changelog: 2 });
    expect(readFileSync(join(t.dir, 'CHANGELOG.md'), 'utf8')).toBe(log('### Added\n\n- base A\n- entrée de main\n- entrée du lot précisée\n'));
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

// L362 — une publication sur main pendant la vie de la branche : [Unreleased] de main est devenu [1.1.0], celui de la branche contient encore les entrées publiées.
describe('R6 — les entrées du lot vont sous le [Unreleased] de main, pas sous la version publiée', () => {
  const PUBLISHED = (unreleasedBody: string) =>
    `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleasedBody}## [1.1.0] - 2026-02-01\n\n### Added\n\n- base A\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n`;
  function setup(lotChangelog: string) {
    const repo = gitRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), log('### Added\n\n- base A\n', '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n'));
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = new RunStore(tempDir(), 'w1');
    const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
    expect(prepareTree(t).ok).toBe(true);
    writeFileSync(join(t.dir, 'CHANGELOG.md'), lotChangelog);
    writeFileSync(join(t.dir, 'x.txt'), 'x\n');
    git(t.dir, 'add', '--', 'CHANGELOG.md', 'x.txt');
    git(t.dir, 'commit', '-q', '-m', 'feat(L1): lot');
    writeFileSync(join(repo, 'CHANGELOG.md'), PUBLISHED(''));
    git(repo, 'add', '--', 'CHANGELOG.md');
    git(repo, 'commit', '-q', '-m', 'release 1.1.0');
    return t;
  }
  const lotLog = (body: string) => log(body, '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n');
  const text = (t: { dir: string }) => readFileSync(join(t.dir, 'CHANGELOG.md'), 'utf8');
  it('R6 — entrée ajoutée dans une section existante, voisine d\'une entrée publiée : sous [Unreleased], la version publiée garde la sienne', () => {
    const t = setup(lotLog('### Added\n\n- base A\n- entrée du lot\n'));
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased', moved: 1 });
    expect(text(t)).toBe(PUBLISHED('### Added\n\n- entrée du lot\n\n'));
  });
  it('R6 — entrée ajoutée sous une nouvelle section : sous [Unreleased] aussi', () => {
    const t = setup(lotLog('### Added\n\n- base A\n\n### Fixed\n\n- correctif du lot\n'));
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased', moved: 1 });
    expect(text(t)).toBe(PUBLISHED('### Fixed\n\n- correctif du lot\n\n'));
  });
  it('R6 — une entrée du lot absente de [Unreleased] et déjà dans la partie publiée de main reste où elle est', () => {
    const lotTip = lotLog('### Added\n\n- base A\n- déjà publiée\n');
    const start = lotLog('### Added\n\n- base A\n');
    const rebased = PUBLISHED('').replace('- base A\n', '- base A\n- déjà publiée\n');
    expect(moveToUnreleased(rebased, lotTip, start, rebased)).toBeNull();
  });
});
