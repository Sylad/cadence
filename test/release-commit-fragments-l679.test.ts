// (L679, suite de revue) Le commit de version retire les fragments de changelog.d/ : il reste un commit de version (docs/releasing.md),
// et une suite de revue dont le fragment a été retiré par une release entre-temps est rendue avec le geste à faire.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { isReleaseOnly } from '../src/audit.js';
import { publishedFragmentNote } from '../src/changelog-fragments.js';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { tryGit } from '../src/orchestrate/git.js';
import { gitRepo } from './helpers.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-09-28T10:00:00', GIT_COMMITTER_DATE: '2026-09-28T10:00:00' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();

async function raf(dir: string, today: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-09-28T10:00:00') });
  return { code, out: out.join('\n') };
}

/** Écrit, retire (texte null) puis commite ; rend le sha. */
function commitFiles(dir: string, message: string, files: Record<string, string | null>): string {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, f));
    else {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
  }
  git(dir, 'add', '-A', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const pkg = (version: string) => JSON.stringify({ name: 'x', version }, null, 2) + '\n';
const FRAGMENT = '### Fixed\n\n- Un correctif (L1).\n';

/** Un lot L1 relu, dont le commit écrit son fragment à côté du mode d'emploi de changelog.d/. */
async function reviewedLot() {
  const dir = gitRepo();
  await raf(dir, '2026-09-28', 'init', '--no-hook');
  await raf(dir, '2026-09-28', 'review', 'enable');
  await raf(dir, '2026-09-28', 'add', 'Cache');
  await raf(dir, '2026-09-28', 'start', 'L1');
  commitFiles(dir, 'feat(L1): cache', { 'package.json': pkg('0.1.0'), 'CHANGELOG.md': '## [Unreleased]\n', 'changelog.d/README.md': 'Mode d’emploi.\n', 'changelog.d/L1.md': FRAGMENT, 'src.ts': 'a\n' });
  await raf(dir, '2026-09-28', 'review', 'L1', 'conforme');
  return dir;
}

const RELEASE = { 'package.json': pkg('0.2.0'), 'CHANGELOG.md': `## [Unreleased]\n\n## [0.2.0] - 2026-09-28\n\n${FRAGMENT}`, 'changelog.d/L1.md': null };

describe('L679 — le commit de version qui retire les fragments reste un commit de version', () => {
  it('R1 — « release: 0.2.0 » (version, CHANGELOG, fragment retiré) : raf check ne le compte pas sans lot', async () => {
    const dir = await reviewedLot();
    const sha = commitFiles(dir, 'release: 0.2.0', RELEASE);
    expect(git(dir, 'show', '--name-status', '--format=', sha)).toBe('M\tCHANGELOG.md\nD\tchangelog.d/L1.md\nM\tpackage.json');
    expect(isReleaseOnly(sha, dir)).toBe(true);
    expect((await raf(dir, '2026-09-28', 'check')).out).not.toContain('commit sans lot');
  });

  it('R2 — cité par le lot après sa revue, il ne rouvre pas la porte de revue', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0 (L1)', RELEASE);
    expect((await raf(dir, '2026-09-29', 'done', 'L1')).code).toBe(0);
    expect((await raf(dir, '2026-09-28', 'check')).out).toBe('✓ plan et historique cohérents');
  });

  it('R3 — un fragment modifié ou ajouté, ou le mode d’emploi retiré, rend le commit à relire', async () => {
    const dir = await reviewedLot();
    expect(isReleaseOnly(commitFiles(dir, 'release: 0.2.0', { 'package.json': pkg('0.2.0'), 'changelog.d/L1.md': `${FRAGMENT}- autre (L1).\n` }), dir)).toBe(false);
    expect(isReleaseOnly(commitFiles(dir, 'release: 0.2.1', { 'package.json': pkg('0.2.1'), 'changelog.d/L2.md': FRAGMENT }), dir)).toBe(false);
    expect(isReleaseOnly(commitFiles(dir, 'release: 0.2.2', { 'package.json': pkg('0.2.2'), 'changelog.d/README.md': null }), dir)).toBe(false);
  });
});

describe('L679 — suite de revue dont le fragment a été publié entre-temps', () => {
  it('R4 — le rebase est en conflit modify/delete et la note nomme le geste : recréer le fragment sans l’entrée publiée', () => {
    const dir = gitRepo();
    commitFiles(dir, 'feat(L1): cache', { 'CHANGELOG.md': '## [Unreleased]\n', 'changelog.d/README.md': 'Mode d’emploi.\n', 'changelog.d/L1.md': FRAGMENT });
    const main = git(dir, 'symbolic-ref', '--short', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'suite');
    commitFiles(dir, 'fix(L1): suite de revue', { 'changelog.d/L1.md': `${FRAGMENT}- Le correctif de la suite (L1).\n` });
    git(dir, 'checkout', '-q', main);
    commitFiles(dir, 'release: 0.2.0', { 'CHANGELOG.md': `## [Unreleased]\n\n## [0.2.0]\n\n${FRAGMENT}`, 'changelog.d/L1.md': null });
    git(dir, 'checkout', '-q', 'suite');

    const r = rebaseOnto(dir, main);
    expect(r.kind).toBe('conflict');
    const files = r.kind === 'conflict' ? r.files : [];
    expect(files).toEqual(['changelog.d/L1.md']);
    const note = publishedFragmentNote(files, (f) => tryGit(dir, 'cat-file', '-e', `refs/heads/${main}:${f}`) !== null);
    expect(note).toContain('changelog.d/L1.md : retiré par une release');
    expect(note).toContain('recréer le fragment avec seulement ce que la suite change');
  });

  it('R5 — aucune note pour un fragment encore présent ni pour un autre fichier', () => {
    expect(publishedFragmentNote(['changelog.d/L1.md', 'src/a.ts', 'changelog.d/README.md'], (f) => f === 'changelog.d/L1.md')).toBe('');
  });
});
