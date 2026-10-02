import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../src/check.js';
import { readCommits } from '../src/git.js';
import { linkCommits } from '../src/link.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

describe('check against a real repository', () => {
  it('reports every kind of drift', () => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo');
    plan.add('todo oublié', '2026-09-01');
    plan.add('en cours endormi', '2026-09-01');
    plan.add('fini trop vite', '2026-09-01');
    plan.addTask('L3', 'reste');
    plan.setStatus('L2', 'doing', '2026-09-01');
    plan.setStatus('L3', 'done', '2026-09-02', { force: true });
    commit(dir, 'feat(L1): premier pas', '2026-09-20T10:00:00');
    commit(dir, 'chore: rien de lié', '2026-09-21T10:00:00');
    commit(dir, 'fix(L9): lot fantôme', '2026-09-22T10:00:00');
    commit(dir, "Merge branch 'x'", '2026-09-22T11:00:00');
    commit(dir, 'fix: L2 corrigé', '2026-09-10T10:00:00');

    const lots = plan.lots();
    const linked = linkCommits(lots, readCommits(dir), plan.refs);
    const kinds = check(lots, linked, '2026-09-28').map((i) => i.kind).sort();
    expect(kinds).toEqual(['done-open-tasks', 'idle', 'orphan-commit', 'todo-with-commits', 'unknown-ref']);
  });

  it('flags cycles and missing dependencies', () => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, 'raf.yaml'), 'demo');
    plan.add('a', '2026-09-01');
    plan.add('b', '2026-09-01', { after: ['L1'] });
    plan.save();
    writeFileSync(plan.path, readFileSync(plan.path, 'utf8').replace('title: a', 'title: a\n    after: [L2, L7]'));
    const lots = Plan.load(plan.path).lots();
    const issues = check(lots, { byLot: new Map(), orphans: [], unknown: [] }, '2026-09-28');
    expect(issues.map((i) => i.kind).sort()).toEqual(['bad-dependency', 'cycle']);
  });
});

describe('ignore : commits automatiques', () => {
  it('les sujets qui correspondent à un motif « ignore » du plan ne sont pas des commits sans lot', async () => {
    const { run } = await import('../src/cli.js');
    const { gitRepo, commit } = await import('./helpers.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = gitRepo();
    const io = (out: string[]) => ({ cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date() });
    run(['init', '--no-hook'], io([]));
    const plan = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('lots:', "ignore: ['^chore\\(batch\\):', '[invalide']\nlots:"));
    commit(dir, 'chore(batch): weekly content refresh', '2026-09-28T10:00:00');
    commit(dir, 'wip', '2026-09-28T11:00:00');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(1);
    expect(out.join('\n')).not.toContain('weekly content refresh');
    expect(out.join('\n')).toContain('commit sans lot : ');
    expect(out.join('\n')).toContain('ignore : motif invalide « [invalide »');
  });
});

describe('planification', () => {
  it('un commit qui ne touche que le plan ne « démarre » pas le lot todo qu’il cite', async () => {
    const { run } = await import('../src/cli.js');
    const { gitRepo, commit } = await import('./helpers.js');
    const { execFileSync } = await import('node:child_process');
    const dir = gitRepo();
    const io = (out: string[]) => ({ cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date() });
    run(['init', '--no-hook'], io([]));
    run(['add', 'Audit'], io([]));
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'chore(L1): audit planifié'], { cwd: dir });
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(0);
    commit(dir, 'feat(L1): vrai travail', '2026-09-28T12:00:00');
    const out2: string[] = [];
    expect(await run(['check'], io(out2))).toBe(1);
    expect(out2.join('\n')).toContain('L1 a 1 commit(s) mais est encore todo');
  });
});

describe('readCommits', () => {
  it('reads a history larger than the default output buffer', () => {
    const dir = gitRepo();
    const body = 'x'.repeat(100_000);
    for (let i = 0; i < 12; i++) commit(dir, `feat(L1): pas ${i}\n\n${body}`);
    expect(readCommits(dir)).toHaveLength(12);
  });
});
