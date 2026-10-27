import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { planCommits, workByLot } from '../src/audit.js';
import { planLoader } from '../src/config.js';
import { linkCommits } from '../src/link.js';
import { commit, gitRepo } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n') };
}

/** L1 démarré, dont le seul commit est celui du plan (« plan: L1 démarré ») : le lot n'a aucun commit de travail. */
async function planOnlyLot() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Cache');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-27T09:00:00');
  await cad(dir, 'start', 'L1');
  git(dir, 'add', '.cadence');
  commit(dir, 'plan: L1 démarré', '2026-09-28T09:00:00');
  return dir;
}

const withWork = (dir: string) => {
  writeFileSync(join(dir, 'cache.ts'), 'export {};\n');
  git(dir, 'add', 'cache.ts');
  commit(dir, 'feat(L1): cache', '2026-09-28T10:00:00');
};

describe('même compte de commits d’un lot partout (L379, accroc A8)', () => {
  it('R1 — raf now ne compte pas le commit de plan : « plan: L1 démarré » seul, aucun commit affiché', async () => {
    const dir = await planOnlyLot();
    expect((await cad(dir, 'commits', 'L1')).out).toBe('');
    const { out } = await cad(dir, 'now');
    expect(out).toContain('L1  Cache  (1 j)');
    expect(out).not.toContain('commit(s)');
  });

  it('R2 — cadence lead tour ne compte pas le commit de plan : « L1 (0 commit) »', async () => {
    const dir = await planOnlyLot();
    const { out } = await cad(dir, 'lead', 'tour', dir);
    expect(out).toContain('L1 (0 commit');
  });

  it('R3 — session start ne compte pas le commit de plan : « 0 commit »', async () => {
    const dir = await planOnlyLot();
    const { out } = await cad(dir, 'session', 'start', '--since', '2026-09-27');
    expect(out).toContain('(0 commit,');
  });

  it('R4 — un commit de travail est compté une fois, et par raf now, le tour, session start et raf commits', async () => {
    const dir = await planOnlyLot();
    withWork(dir);
    expect((await cad(dir, 'commits', 'L1')).out.split('\n')).toHaveLength(1);
    expect((await cad(dir, 'now')).out).toContain('1 commit(s)');
    expect((await cad(dir, 'lead', 'tour', dir)).out).toContain('L1 (1 commit');
    expect((await cad(dir, 'session', 'start', '--since', '2026-09-27')).out).toContain('(1 commit,');
  });

  it('R5 — le journal de période (« Fait depuis », « Commits de la période ») ne liste pas le commit de plan, comme raf commits', async () => {
    const dir = await planOnlyLot();
    const start = (await cad(dir, 'session', 'start', '--since', '2026-09-27')).out;
    expect(start).not.toContain('plan: L1 démarré');
    expect(start).not.toContain('L1 — 1 commit(s)');
    const close = (await cad(dir, 'session', 'close', '--since', '2026-09-27')).out;
    expect(close).not.toContain('plan: L1 démarré');
    withWork(dir);
    expect((await cad(dir, 'session', 'start', '--since', '2026-09-27')).out).toMatch(/L1 — 1 commit\(s\) : feat\(L1\): cache\n/);
  });

  it('R6 — le compte ne filtre que les lots demandés (ceux que l’écran affiche), pas tout l’historique des lots', async () => {
    const dir = await planOnlyLot();
    await cad(dir, 'add', 'Autre');
    await cad(dir, 'start', 'L2');
    git(dir, 'add', '.cadence');
    commit(dir, 'plan: L2 démarré', '2026-09-28T09:30:00');
    withWork(dir);
    const plan = planLoader(dir)();
    const linked = linkCommits(plan.lots(), planCommits(plan, dir), plan.refs);
    // L2 est cité par un commit : sans la liste des lots demandés, il serait filtré lui aussi (le garde-fou du test).
    expect([...workByLot(plan, dir, linked).keys()].sort()).toEqual(['L1', 'L2']);
    expect([...workByLot(plan, dir, linked, ['L1']).keys()]).toEqual(['L1']);
    expect(workByLot(plan, dir, linked, ['L1']).get('L1')).toHaveLength(1);
  });
});
