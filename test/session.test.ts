import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readNext, sharedStateDir, stateDir, writeLock } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T18:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Plan commité : L1 en cours (silencieux), L2 à faire, L3 gain rapide, L4 bloqué par L2. */
async function project() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Cache', '--estimate', '2');
  await cad(dir, 'add', 'Export');
  await cad(dir, 'add', 'Typo', '--quickwin');
  await cad(dir, 'add', 'Après export', '--after', 'L2');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-20T09:00:00');
  await cad(dir, 'start', 'L1');
  const plan = join(dir, 'docs/plan/raf.yaml');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('started: 2026-09-28', 'started: 2026-09-22'));
  git(dir, 'commit', '-qam', 'chore: plan');
  commit(dir, 'feat(L1): cache', '2026-09-24T10:00:00');
  return dir;
}

describe('session start', () => {
  it('rapporte les faits et propose trois lots du plan', async () => {
    const dir = await project();
    commit(dir, 'feat(L2): début export', '2026-09-28T09:00:00');
    commit(dir, 'wip sans lot', '2026-09-28T09:30:00');
    writeNext(dir, ['finir L1']);
    const { code, out } = await cad(dir, 'session', 'start', '--since', '2026-09-27');
    expect(code).toBe(0);
    expect(out).toContain('Notes de la dernière clôture (2026-09-27)\n  - finir L1');
    expect(out).toMatch(/En cours\n {2}L1 {2}Cache {2}\(dernière activité 2026-09-24, silencieux depuis 4 j\)/);
    expect(out).toMatch(/Fait depuis 2026-09-27\n {2}L2 — 1 commit\(s\) : feat\(L2\): début export\n {2}1 commit\(s\) sans lot/);
    expect(out).toContain('✗ L2 a 1 commit(s) mais est encore todo');
    expect(out).toContain('branche main, pas de branche amont');
    expect(out).toMatch(/Propositions\n {2}1\. L1 {2}Cache — en cours\n {2}2\. ⚡ L3 {2}Typo — gain rapide prêt\n {2}3\. L2 {2}Export — prêt/);
  });

  it('signale une livraison en cours et un verrou périmé', async () => {
    const dir = await project();
    writeLock(sharedStateDir(dir), { pid: process.pid, sha: 'abcdef1234', started: '2026-09-28T18:00:00.000Z' });
    expect((await cad(dir, 'session', 'start')).out).toContain(`Livraison en cours : abcdef1 (pid ${process.pid}, depuis 2026-09-28T18:00:00.000Z)`);
    const other = await project();
    writeLock(sharedStateDir(other), { pid: 2 ** 22 + 12345, sha: 'abcdef1234', started: 'x' });
    expect((await cad(other, 'session', 'start')).out).toContain('Verrou de livraison périmé');
  });

  it('refuse sans plan', async () => {
    expect((await cad(gitRepo(), 'session', 'start')).code).toBe(2);
  });
});

describe('session close', () => {
  it('liste les commits sans lot et les lots en cours sans commit du jour, code 1', async () => {
    const dir = await project();
    commit(dir, 'wip sans lot', '2026-09-28T11:00:00');
    writeFileSync(join(dir, 'x.txt'), 'x');
    git(dir, 'add', 'x.txt');
    const { code, out } = await cad(dir, 'session', 'close');
    expect(code).toBe(1);
    expect(out).toMatch(/Commits de la période\n {2}1 commit\(s\) sans lot :\n {4}[0-9a-f]{7} wip sans lot/);
    expect(out).toContain('L1  Cache — aucun commit sur la période : raf done ou raf note');
    expect(out).toContain('1 fichier(s) modifié(s)');
    expect(out).toMatch(/✗ pas fermé : \d+ point\(s\)/);
  });

  it('code 0 sur un dépôt propre et poussé', async () => {
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = await project();
    await cad(dir, 'done', 'L1');
    git(dir, 'commit', '-qam', 'chore: plan');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const { code, out } = await cad(dir, 'session', 'close', '--since', '2026-09-01');
    expect(out).toContain('✓ prêt à fermer');
    expect(code).toBe(0);
  });
});

describe('session next', () => {
  it('écrit puis efface les notes', async () => {
    const dir = await project();
    await cad(dir, 'session', 'next', 'finir L1', 'relire L2');
    expect(readNext(stateDir(dir))).toEqual({ date: '2026-09-28', lines: ['finir L1', 'relire L2'] });
    await cad(dir, 'session', 'next');
    expect(readNext(stateDir(dir))).toBeNull();
  });
});

function writeNext(dir: string, lines: string[]) {
  writeFileSync(join(stateDir(dir), 'next.md'), `# 2026-09-27\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}
