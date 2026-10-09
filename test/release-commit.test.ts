// (L72) Le commit de version cite le lot après sa revue : il ne doit pas rouvrir la porte de revue.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

async function raf(dir: string, ...argv: string[]) {
  return rafOn('2026-09-28', dir, ...argv);
}

// La porte ne vaut que pour un lot terminé après son jour d'activation : done se passe le lendemain.
async function rafOn(today: string, dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'x', version, ...extra }, null, 2) + '\n';
const lock = (version: string, dep = '1.0.0') =>
  JSON.stringify({ name: 'x', version, packages: { '': { name: 'x', version }, 'node_modules/y': { version: dep } } }, null, 2) + '\n';
const market = (version: string) => JSON.stringify({ name: 'm', plugins: [{ name: 'x', version }] }, null, 2) + '\n';

function write(dir: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

function commitFiles(dir: string, message: string, files: Record<string, string>) {
  write(dir, files);
  execFileSync('git', ['add', ...Object.keys(files)], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-28T10:00:00', GIT_COMMITTER_DATE: '2026-09-28T10:00:00' } });
}

const BASE = {
  'package.json': pkg('0.1.0'),
  'package-lock.json': lock('0.1.0'),
  '.claude-plugin/marketplace.json': market('0.1.0'),
  'CHANGELOG.md': '## [Unreleased]\n- x\n',
};

async function reviewedLot() {
  const dir = gitRepo();
  await raf(dir, 'init', '--no-hook');
  await raf(dir, 'review', 'enable');
  await raf(dir, 'add', 'Cache');
  await raf(dir, 'start', 'L1');
  commitFiles(dir, 'feat(L1): cache', { ...BASE, 'src.ts': 'a\n' });
  await raf(dir, 'review', 'L1', 'conforme');
  return dir;
}

describe('(L72) commit de version et porte de revue', () => {
  it('un commit qui ne change que les versions et le CHANGELOG ne demande pas de nouvelle revue', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0 (L1)', {
      'package.json': pkg('0.2.0'),
      'package-lock.json': lock('0.2.0'),
      '.claude-plugin/marketplace.json': market('0.2.0'),
      'CHANGELOG.md': '## [0.2.0] - 2026-09-28\n- x (L1)\n',
    });
    expect((await rafOn('2026-09-29', dir, 'done', 'L1')).code).toBe(0);
    const check = await raf(dir, 'check');
    expect(check.out).toBe('✓ plan et historique cohérents');
    expect((await raf(dir, 'commits', 'L1')).out).not.toContain('release: 0.2.0');
  });

  it('un commit de version sans lot cité n’est pas non plus « sans lot »', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0', { 'package.json': pkg('0.2.0'), 'package-lock.json': lock('0.2.0'), 'CHANGELOG.md': '## [0.2.0]\n' });
    expect((await raf(dir, 'check')).out).not.toContain('commit sans lot');
  });

  it('les fichiers décident : un autre fichier dans le commit le rend à relire', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0 (L1)', { 'package.json': pkg('0.2.0'), 'src.ts': 'b\n' });
    await rafOn('2026-09-29', dir, 'done', 'L1', '--force');
    expect((await raf(dir, 'check')).out).toContain('L1 est terminé avec 1 commit(s) postérieur(s) à sa revue de code');
  });

  it('un package.json dont autre chose que la version change reste du travail', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0 (L1)', { 'package.json': pkg('0.2.0', { dependencies: { z: '1' } }) });
    await rafOn('2026-09-29', dir, 'done', 'L1', '--force');
    expect((await raf(dir, 'check')).out).toContain('1 commit(s) postérieur(s) à sa revue');
  });

  it('un package-lock dont une dépendance change reste du travail', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'release: 0.2.0 (L1)', { 'package.json': pkg('0.2.0'), 'package-lock.json': lock('0.2.0', '2.0.0') });
    await rafOn('2026-09-29', dir, 'done', 'L1', '--force');
    expect((await raf(dir, 'check')).out).toContain('1 commit(s) postérieur(s) à sa revue');
  });

  it('un commit qui ne touche que le CHANGELOG est un commit de version', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'docs(L1): changelog', { 'CHANGELOG.md': '## [0.1.1]\n' });
    expect((await rafOn('2026-09-29', dir, 'done', 'L1')).code).toBe(0);
    expect((await raf(dir, 'check')).out).toBe('✓ plan et historique cohérents');
  });

  const README = (news: string, tail = 'fin\n') => `# x\n\n## What's new\n\n${news}\n\n## Usage\n\n${tail}`;

  it('le « What\'s new » du README, rangé par version, se rafraîchit dans le commit de version', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'docs(L1): readme', { 'README.md': README('**0.1.0**: a') });
    await raf(dir, 'review', 'L1', 'conforme');
    commitFiles(dir, 'release: 0.2.0 (L1)', {
      'package.json': pkg('0.2.0'),
      'CHANGELOG.md': '## [0.2.0]\n',
      'README.md': README('**0.2.0**: b (L1). **0.1.0**: a'),
    });
    expect((await rafOn('2026-09-29', dir, 'done', 'L1')).code).toBe(0);
    expect((await raf(dir, 'check')).out).toBe('✓ plan et historique cohérents');
  });

  it('un autre passage du README dans le commit de version reste du travail', async () => {
    const dir = await reviewedLot();
    commitFiles(dir, 'docs(L1): readme', { 'README.md': README('**0.1.0**: a') });
    await raf(dir, 'review', 'L1', 'conforme');
    commitFiles(dir, 'release: 0.2.0 (L1)', {
      'package.json': pkg('0.2.0'),
      'README.md': README('**0.2.0**: b (L1). **0.1.0**: a', 'autre\n'),
    });
    await rafOn('2026-09-29', dir, 'done', 'L1', '--force');
    expect((await raf(dir, 'check')).out).toContain('1 commit(s) postérieur(s) à sa revue');
  });
});
