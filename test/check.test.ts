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
    const linked = linkCommits(lots, readCommits(dir), plan.prefix);
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
