import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { assembleFragments, changelogWithFragments, FRAGMENTS_DIR, parseFragment, readFragments, RUBRIQUES } from '../src/changelog-fragments.js';
import { splitUnreleased } from '../src/release.js';
import { commit, gitRepo } from './helpers.js';

// L679 — le CHANGELOG du dépôt cadence s'écrit en fragments : changelog.d/<lot>.md, assemblés par cadence release.
const root = join(import.meta.dirname, '..');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

const CHANGELOG = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old fix (L1).\n';

describe('L679 — deux branches qui ajoutent chacune leur entrée', () => {
  /** Un dépôt, deux branches parties du même commit, chacune avec son écriture ; rend le code du rebase de la seconde sur la première. */
  function rebaseDeux(ecrire: (dir: string, lot: string) => string): { status: number; dir: string } {
    const dir = gitRepo();
    put(dir, 'CHANGELOG.md', CHANGELOG);
    put(dir, `${FRAGMENTS_DIR}/README.md`, 'Mode d’emploi.\n');
    git(dir, 'add', '.');
    commit(dir, 'chore: initial');
    for (const lot of ['L10', 'L11']) {
      git(dir, 'checkout', '-q', '-b', lot, 'main');
      git(dir, 'add', ecrire(dir, lot));
      commit(dir, `feat(${lot}): entrée`);
    }
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'L10');
    const r = spawnSync('git', ['rebase', 'main', 'L11'], { cwd: dir, encoding: 'utf8' });
    return { status: r.status ?? 1, dir };
  }

  it('R1 — chacune avec son fragment : le rebase passe sans conflit, les deux fragments sont là', () => {
    const { status, dir } = rebaseDeux((d, lot) => {
      put(d, `${FRAGMENTS_DIR}/${lot}.md`, `### Fixed\n\n- Correctif (${lot}).\n`);
      return `${FRAGMENTS_DIR}/${lot}.md`;
    });
    expect(status).toBe(0);
    expect(readFragments(dir).map((f) => f.file)).toEqual([`${FRAGMENTS_DIR}/L11.md`, `${FRAGMENTS_DIR}/L10.md`]);
  });

  it('R2 — témoin : chacune sous [Unreleased] de CHANGELOG.md, le même rebase est en conflit (ce que L679 supprime)', () => {
    const { status } = rebaseDeux((d, lot) => {
      put(d, 'CHANGELOG.md', CHANGELOG.replace('## [Unreleased]\n', `## [Unreleased]\n\n### Fixed\n\n- Correctif (${lot}).\n`));
      return 'CHANGELOG.md';
    });
    expect(status).not.toBe(0);
  });
});

describe('L679 — lecture et assemblage', () => {
  it('R3 — rubriques regroupées dans l\'ordre de Keep a Changelog, fragments dans l\'ordre stable (lot le plus récent en tête)', () => {
    const a = parseFragment('changelog.d/L9.md', '### Fixed\n\n- f9 (L9).\n\n### Added\n\n- a9 (L9).\n');
    const b = parseFragment('changelog.d/L12.md', '### Fixed\n\n- f12 (L12).\n  suite de f12\n');
    const body = assembleFragments([b, a]);
    expect(body).toBe('\n### Added\n\n- a9 (L9).\n\n### Fixed\n\n- f12 (L12).\n  suite de f12\n- f9 (L9).\n\n');
  });

  it('R4 — une rubrique inconnue, du texte avant la première ou un fragment vide sont refusés en nommant le fichier', () => {
    expect(() => parseFragment('changelog.d/L1.md', '### Nouveau\n\n- x\n')).toThrow(/L1\.md.*inconnue/);
    expect(() => parseFragment('changelog.d/L1.md', '- x\n')).toThrow(/L1\.md.*avant la première rubrique/);
    expect(() => parseFragment('changelog.d/L1.md', '\n')).toThrow(/L1\.md.*vide/);
    expect(() => parseFragment('changelog.d/L1.md', '### Fixed\n\n')).toThrow(/aucune entrée/);
    expect(RUBRIQUES).toEqual(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
  });
});

describe('L679 — cadence release assemble les fragments', () => {
  function projet(unreleased = ''): string {
    const dir = gitRepo();
    put(dir, 'package.json', '{\n  "name": "acme-tool",\n  "version": "1.2.3"\n}\n');
    put(dir, 'CHANGELOG.md', CHANGELOG.replace('## [Unreleased]\n', `## [Unreleased]\n${unreleased}`));
    put(dir, `${FRAGMENTS_DIR}/README.md`, 'Mode d’emploi.\n');
    put(dir, `${FRAGMENTS_DIR}/L10.md`, '### Added\n\n- Une chose (L10).\n');
    put(dir, `${FRAGMENTS_DIR}/L11.md`, '### Fixed\n\n- Un correctif (L11).\n\n### Added\n\n- Une autre chose (L11).\n');
    git(dir, 'add', '.');
    commit(dir, 'chore: initial');
    return dir;
  }
  const release = (dir: string, ...argv: string[]) => {
    const out: string[] = [];
    const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-12' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-11-12T09:00:00') }) as number;
    return { code, out: out.join('\n') };
  };
  const SECTION = '## [1.2.4] - 2026-11-12\n\n### Added\n\n- Une autre chose (L11).\n- Une chose (L10).\n\n### Fixed\n\n- Un correctif (L11).\n\n';

  it('R5 — --dry-run annonce la section assemblée et les fragments retirés, sans rien écrire', () => {
    const dir = projet();
    const { code, out } = release(dir, 'patch', '--dry-run');
    expect(code).toBe(0);
    expect(out).toContain('écrirait : CHANGELOG.md ([Unreleased] et 2 fragment(s) de changelog.d/ → [1.2.4] - 2026-11-12');
    expect(out).toContain('retirerait : changelog.d/L10.md');
    expect(out).toContain('retirerait : changelog.d/L11.md');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG);
    expect(existsSync(join(dir, FRAGMENTS_DIR, 'L10.md'))).toBe(true);
  });

  it('R6 — la release écrit la section (même forme qu\'à la main), retire les fragments, garde le dossier, et les étapes les ajoutent au commit', () => {
    const dir = projet();
    const { code, out } = release(dir, 'patch');
    expect(code).toBe(0);
    const log = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(log).toBe(CHANGELOG.replace('## [1.2.3]', `${SECTION}## [1.2.3]`));
    expect(readdirSync(join(dir, FRAGMENTS_DIR))).toEqual(['README.md']);
    expect(out).toMatch(/git add .*CHANGELOG\.md changelog\.d\/L11\.md changelog\.d\/L10\.md && git commit/);
    git(dir, 'add', 'package.json', 'CHANGELOG.md', 'changelog.d/L11.md', 'changelog.d/L10.md');
    expect(git(dir, 'status', '--porcelain')).toBe('M  CHANGELOG.md\nD  changelog.d/L10.md\nD  changelog.d/L11.md\nM  package.json\n');
  });

  it('R7 — une entrée restée sous [Unreleased] passe avec les fragments, sous sa rubrique', () => {
    const dir = projet('\n### Fixed\n\n- Restée là (L9).\n\n');
    expect(release(dir, 'patch').code).toBe(0);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('### Fixed\n\n- Restée là (L9).\n- Un correctif (L11).\n\n## [1.2.3]');
  });

  it('R8 — un fragment mal formé refuse la release, rien n\'est écrit', () => {
    const dir = projet();
    put(dir, `${FRAGMENTS_DIR}/L12.md`, '- sans rubrique (L12)\n');
    git(dir, 'add', '.');
    commit(dir, 'chore: fragment');
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/L12\.md.*avant la première rubrique/);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG);
  });

  it('R9 — un dossier changelog.d/ sans fragment ni entrée sous [Unreleased] : rien à publier, la commande le dit', () => {
    const dir = gitRepo();
    put(dir, 'package.json', '{\n  "name": "acme-tool",\n  "version": "1.2.3"\n}\n');
    put(dir, 'CHANGELOG.md', CHANGELOG);
    put(dir, `${FRAGMENTS_DIR}/README.md`, 'Mode d’emploi.\n');
    git(dir, 'add', '.');
    commit(dir, 'chore: initial');
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/ni fragment dans changelog\.d\//);
  });
});

describe('L679 — le dépôt cadence lui-même', () => {
  it('R10 — [Unreleased] de CHANGELOG.md reste vide : chaque entrée va dans un fragment de changelog.d/', () => {
    const { body } = splitUnreleased(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));
    expect(body.trim(), `écrire l'entrée dans ${FRAGMENTS_DIR}/<lot>.md, pas sous [Unreleased]`).toBe('');
  });

  it('R11 — chaque fragment du dépôt se lit (rubrique connue, au moins une entrée) et cite son lot', () => {
    for (const f of readFragments(root)) {
      const lot = /^changelog\.d\/(L\d+)/.exec(f.file)?.[1];
      if (lot) expect([...f.parts.values()].join('\n'), `${f.file} cite ${lot}`).toMatch(new RegExp(`\\b${lot}\\b`));
    }
  });

  it('R12 — le mode d\'emploi du dossier est là (il garde le dossier après une release)', () => {
    expect(existsSync(join(root, FRAGMENTS_DIR, 'README.md'))).toBe(true);
  });

  it('R13 — changelogWithFragments rend le CHANGELOG que la prochaine release publierait', () => {
    const dir = gitRepo();
    put(dir, 'CHANGELOG.md', CHANGELOG);
    put(dir, `${FRAGMENTS_DIR}/L10.md`, '### Fixed\n\n- x (L10).\n');
    expect(changelogWithFragments(dir)).toBe(CHANGELOG.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n### Fixed\n\n- x (L10).\n\n'));
  });
});
