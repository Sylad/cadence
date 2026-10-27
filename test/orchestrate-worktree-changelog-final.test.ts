import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebaseOnto, settleOwnEntries } from '../src/orchestrate/integrate.js';
import { mergeUnreleased, settleLotEntries } from '../src/orchestrate/changelog-merge.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L369 — l'intégration en worktree ne rend pas le lot pour un conflit d'ajout dans le CHANGELOG, et laisse UNE entrée finale par lot (celle du sommet de sa branche).
const PUBLISHED = '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n';
const log = (unreleased: string, tail = PUBLISHED) => `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleased}\n${tail}`;
const read = (dir: string) => readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');

function setup(startLog: string) {
  const repo = gitRepo();
  writeFileSync(join(repo, 'CHANGELOG.md'), startLog);
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

describe('R1 — une publication de la branche du dépôt n\'est pas un retrait', () => {
  // La publication range « autre lot » sous 1.1.0 ; le lot, resté sur l'ancien [Unreleased], ajoute son entrée juste après.
  const START = log('### Added\n\n- autre lot\n');
  const released = (body: string) => log(body, `## [1.1.0] - 2026-02-01\n\n### Added\n\n- autre lot\n- ajout de la publication\n\n${PUBLISHED}`);
  it('R1 — mergeUnreleased : une entrée de base que la publication a rangée sous la version publiée de ours ne bloque pas l\'ajout de theirs', () => {
    const theirs = log('### Added\n\n- autre lot\n- entrée du lot\n');
    expect(mergeUnreleased(START, released(''), theirs)).toBe(released('### Added\n\n- entrée du lot\n'));
  });
  it('R1 — mergeUnreleased : une entrée de base retirée sans se retrouver sous une version reste un conflit', () => {
    const theirs = log('### Added\n\n- autre lot\n- entrée du lot\n');
    expect(mergeUnreleased(START, log('### Added\n\n- ailleurs\n'), theirs)).toBeNull();
  });
  it('R1 — au rebase : la publication et l\'ajout du lot se touchent, le lot n\'est pas rendu, son entrée est sous [Unreleased]', () => {
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Added\n\n- autre lot\n- entrée du lot\n'), 'feat(L1): lot');
    put(repo, released(''), 'release 1.1.0');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(read(t.dir)).toBe(released('### Added\n\n- entrée du lot\n'));
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('R1 — une entrée n\'est « déplacée par la publication » que si elle est de base, et en égalité exacte', () => {
  // La publication 1.1.0 porte « Fix typo in README » ; le lot ajoute « Fix typo », dont le texte est un préfixe de la première : ce n'est pas la même entrée.
  const START = log('');
  const RELEASED_TAIL = `## [1.1.0] - 2026-02-01\n\n### Added\n\n- Fix typo in README\n\n${PUBLISHED}`;
  const LOT = log('### Added\n\n- Fix typo\n');
  it('R1 — mergeUnreleased : l\'entrée du lot, préfixe d\'une entrée publiée par ours, reste sous [Unreleased]', () => {
    expect(mergeUnreleased(START, log('', RELEASED_TAIL), LOT, START)).toBe(log('### Added\n\n- Fix typo\n', RELEASED_TAIL));
  });
  it('R1 — mergeUnreleased : une entrée de base sous-chaîne d\'une entrée publiée par ours n\'est pas « déplacée » : conflit', () => {
    const base = log('### Added\n\n- Fix typo\n');
    expect(mergeUnreleased(base, log('', RELEASED_TAIL), log('### Added\n\n- Fix typo\n- ajout\n'), base)).toBeNull();
  });
  it('R1 — settleLotEntries : une entrée du sommet absente du résultat y est remise même si une entrée publiée de main la contient', () => {
    const rebased = log('', RELEASED_TAIL);
    expect(settleLotEntries(rebased, LOT, START, rebased, [])).toBe(log('### Added\n\n- Fix typo\n', RELEASED_TAIL));
  });
  it('R1 — au rebase : la publication porte une entrée qui contient celle du lot, le lot est intégré et son entrée est sous [Unreleased]', () => {
    const { repo, t, put } = setup(START);
    put(t.dir, LOT, 'feat(L1): lot');
    put(repo, log('', RELEASED_TAIL), 'release 1.1.0');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(read(t.dir)).toBe(log('### Added\n\n- Fix typo\n', RELEASED_TAIL));
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('R1 — la publication et un lot qui réécrit son entrée', () => {
  it('R1 — au rebase : deux commits du lot (le second précise l\'entrée du premier) sur une publication qui touche le même endroit : une seule entrée, la finale', () => {
    const START = log('### Added\n\n- autre lot\n');
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Added\n\n- autre lot\n- entrée v1\n'), 'feat(L1): lot');
    put(t.dir, log('### Added\n\n- autre lot\n- entrée finale\n'), 'fix(L1): précise');
    put(repo, log('', `## [1.1.0] - 2026-02-01\n\n### Added\n\n- autre lot\n- ajout de la publication\n\n${PUBLISHED}`), 'release 1.1.0');
    const r = rebaseOnto(t.dir, 'main');
    expect(r).toMatchObject({ kind: 'rebased', settled: false });
    expect(read(t.dir)).toBe(log('### Added\n\n- entrée finale\n', `## [1.1.0] - 2026-02-01\n\n### Added\n\n- autre lot\n- ajout de la publication\n\n${PUBLISHED}`));
  });
});

describe('R2 — une entrée finale par lot, prise au sommet de sa branche', () => {
  const START = log('### Added\n\n- base\n');
  const TIP = log('### Added\n\n- base\n- version finale\n');
  const stacked = log('### Added\n\n- base\n- main\n- version 1\n- version 2\n- version finale\n');
  const MAIN = log('### Added\n\n- base\n- main\n');
  it('R2 — settleLotEntries écarte les entrées intermédiaires du lot : il ne reste que sa version du sommet', () => {
    const out = settleLotEntries(stacked, TIP, START, MAIN, ['- version 1', '- version 2']);
    expect(out).toBe(log('### Added\n\n- base\n- main\n- version finale\n'));
  });
  it('R2 — settleLotEntries remet l\'entrée du sommet absente du résultat, sous sa section', () => {
    const tip = log('### Added\n\n- base\n\n### Fixed\n\n- correctif final\n');
    expect(settleLotEntries(MAIN, tip, START, MAIN, [])).toBe(log('### Added\n\n- base\n- main\n\n### Fixed\n\n- correctif final\n'));
  });
  it('R2 — settleLotEntries ne touche pas une entrée de main, même identique à une intermédiaire du lot', () => {
    const out = settleLotEntries(MAIN, START, START, MAIN, ['- main']);
    expect(out).toBeNull();
  });
  it('R2 — settleLotEntries rend null quand le résultat est déjà réglé', () => {
    expect(settleLotEntries(log('### Added\n\n- base\n- main\n- version finale\n'), TIP, START, MAIN, ['- version 1'])).toBeNull();
  });
  it('R2 — au rebase : le lot réécrit quatre fois son entrée pendant que main ajoute la sienne, une seule entrée du lot reste, la finale', () => {
    const { repo, t, put } = setup(START);
    for (const v of ['1', '2', '3', 'finale']) put(t.dir, log(`### Added\n\n- base\n- version ${v}\n`), `fix(L1): v${v}`);
    put(repo, MAIN, 'feat(L2): autre lot');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(read(t.dir)).toBe(log('### Added\n\n- base\n- main\n- version finale\n'));
    expect(git(t.dir, 'log', '--format=%s', 'main..HEAD').split('\n')).toHaveLength(4);
  });
});

describe('R2 — une entrée que le lot a rangée lui-même sous une version n\'est pas une intermédiaire', () => {
  const START = log('### Added\n\n- base\n');
  it('R2 — au rebase : le lot écrit une entrée sous [Unreleased] puis la range sous une nouvelle version, elle reste sous cette version', () => {
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Added\n\n- base\n- entrée E du lot\n'), 'feat(L1): lot');
    const released = log('', `## [1.1.0] - 2026-02-01\n\n### Added\n\n- base\n- entrée E du lot\n\n${PUBLISHED}`);
    put(t.dir, released, 'chore(L1): release 1.1.0');
    writeFileSync(join(repo, 'autre.txt'), 'x');
    git(repo, 'add', '--', 'autre.txt');
    git(repo, 'commit', '-q', '-m', 'autre fichier');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased', settled: false });
    expect(read(t.dir)).toBe(released);
  });
  it('R2 — au rebase : le lot range son entrée sous la version 1.0.0 existante, elle y reste', () => {
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Added\n\n- base\n- entrée E du lot\n'), 'feat(L1): lot');
    const released = log('', `## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n- base\n- entrée E du lot\n`);
    put(t.dir, released, 'chore(L1): release');
    writeFileSync(join(repo, 'autre.txt'), 'x');
    git(repo, 'add', '--', 'autre.txt');
    git(repo, 'commit', '-q', '-m', 'autre fichier');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(read(t.dir)).toBe(released);
  });
  it('R2 — settleLotEntries : une entrée du sommet rangée sous une version n\'est pas écartée', () => {
    const tip = log('', `## [1.1.0] - 2026-02-01\n\n### Added\n\n- base\n- entrée E du lot\n\n${PUBLISHED}`);
    expect(settleLotEntries(tip, tip, START, START, ['- entrée E du lot'])).toBeNull();
  });
});

describe('R2 — le réglage final fait son commit', () => {
  it('R2 — settleOwnEntries : les intermédiaires empilées dans le résultat du rebase sont retirées dans un commit « une entrée finale par lot »', () => {
    const START = log('### Added\n\n- base\n');
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Added\n\n- base\n- version 1\n'), 'feat(L1): v1');
    put(t.dir, log('### Added\n\n- base\n- version finale\n'), 'fix(L1): finale');
    put(repo, log('### Added\n\n- base\n- main\n'), 'feat(L2): autre lot');
    const before = git(t.dir, 'rev-parse', 'HEAD');
    // L'état que le rebase laisserait si rien ne réglait les versions intermédiaires (cas L360 du 26-10).
    git(t.dir, 'reset', '-q', '--hard', 'main');
    put(t.dir, log('### Added\n\n- base\n- main\n- version 1\n- version finale\n'), 'feat(L1): lot rejoué');
    expect(settleOwnEntries(t.dir, 'main', before, START)).toBe(true);
    expect(read(t.dir)).toBe(log('### Added\n\n- base\n- main\n- version finale\n'));
    expect(git(t.dir, 'log', '-1', '--format=%s')).toMatch(/^docs: CHANGELOG — une entrée finale par lot/);
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('R2 — un lot qui place son entrée en tête de section puis la réécrit', () => {
  const START = log('### Fixed\n\n- a\n- b\n');
  it('R2 — mergeUnreleased : une entrée du lot que l\'union a recasée en fin de section dans ours ne bloque pas la réécriture du lot', () => {
    const base = log('### Fixed\n\n- E v1\n- a\n- b\n');
    const ours = log('### Fixed\n\n- M\n- a\n- b\n- E v1\n');
    const theirs = log('### Fixed\n\n- E v2\n- a\n- b\n');
    expect(mergeUnreleased(base, ours, theirs, START)).toBe(log('### Fixed\n\n- M\n- a\n- b\n- E v2\n'));
  });
  it('R2 — au rebase : le lot écrit son entrée en tête de section puis la réécrit pendant que main ajoute la sienne, le lot n\'est pas rendu, une seule entrée du lot reste', () => {
    const { repo, t, put } = setup(START);
    put(t.dir, log('### Fixed\n\n- E v1\n- a\n- b\n'), 'feat(L1): v1');
    put(t.dir, log('### Fixed\n\n- E v2\n- a\n- b\n'), 'fix(L1): v2');
    put(repo, log('### Fixed\n\n- M\n- a\n- b\n'), 'feat(L2): autre lot');
    expect(rebaseOnto(t.dir, 'main')).toMatchObject({ kind: 'rebased' });
    expect(read(t.dir)).toBe(log('### Fixed\n\n- M\n- a\n- b\n- E v2\n'));
    expect(git(t.dir, 'status', '--porcelain')).toBe('');
  });
});
