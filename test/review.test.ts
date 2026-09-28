// Non-régression des points de la relecture du 2026-09-28.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { schedule } from '../src/schedule.js';
import { commit, gitRepo, tempDir } from './helpers.js';

function raf(dir: string, argv: string[], env: Record<string, string> = { RAF_TODAY: '2026-09-28' }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T09:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('hook installation', () => {
  it('targets the shared hooks dir from a worktree', () => {
    const dir = gitRepo();
    commit(dir, 'init');
    const wt = join(tempDir(), 'wt');
    git(dir, 'worktree', 'add', '-q', wt);
    raf(wt, ['hook', 'install']);
    expect(readFileSync(join(dir, '.git/hooks/post-commit'), 'utf8')).toContain('raf hook post-commit');
  });

  it('expands a ~ in core.hooksPath', () => {
    const dir = gitRepo();
    const home = tempDir();
    git(dir, 'config', 'core.hooksPath', '~/githooks');
    // git développe « ~ » avec le HOME du processus : on le détourne vers un dossier jetable.
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      raf(dir, ['hook', 'install']);
    } finally {
      process.env.HOME = realHome;
    }
    expect(existsSync(join(home, 'githooks/post-commit'))).toBe(true);
    expect(existsSync(join(dir, '~'))).toBe(false);
  });

  it('writes into .husky/ rather than the generated .husky/_', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    git(dir, 'config', 'core.hooksPath', '.husky/_');
    raf(dir, ['hook', 'install']);
    expect(existsSync(join(dir, '.husky/post-commit'))).toBe(true);
    expect(existsSync(join(dir, '.husky/_/post-commit'))).toBe(false);
  });

  it('inserts the block before a trailing exit', () => {
    const dir = gitRepo();
    const hook = join(dir, '.git/hooks/post-commit');
    writeFileSync(hook, '#!/bin/bash\necho hi\nexit 0\n');
    raf(dir, ['hook', 'install']);
    const lines = readFileSync(hook, 'utf8').trimEnd().split('\n');
    expect(lines.at(-1)).toBe('exit 0');
    expect(lines).toContain('command -v raf >/dev/null 2>&1 && raf hook post-commit || true');
  });

  it('refuses to touch a non-shell hook', () => {
    const dir = gitRepo();
    const hook = join(dir, '.git/hooks/post-commit');
    writeFileSync(hook, '#!/usr/bin/env python3\nprint(1)\n');
    const r = raf(dir, ['hook', 'install']);
    expect(r.code).toBe(2);
    expect(readFileSync(hook, 'utf8')).toBe('#!/usr/bin/env python3\nprint(1)\n');
  });
});

describe('plan file robustness', () => {
  it('keeps a hand-written zero-indent sequence style', () => {
    const path = join(tempDir(), 'raf.yaml');
    writeFileSync(path, 'version: 1\nproject: x\nprefix: L\nlots:\n- id: L1\n  title: a\n  status: todo\n');
    const p = Plan.load(path);
    p.add('b', '2026-09-28');
    p.save();
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('lots:\n- id: L1\n  title: a\n');
    expect(text).toContain('\n- id: L2\n');
  });

  it('accepts project names YAML would otherwise choke on', () => {
    const dir = gitRepo();
    raf(dir, ['init', '--no-hook', '--project', '@sylad/cadence #2']);
    expect(Plan.load(join(dir, 'docs/plan/raf.yaml')).project).toBe('@sylad/cadence #2');
    expect(raf(tempDir(), ['init', '--no-hook', '--prefix', 'L:'], {}).code).toBe(2);
  });

  it('reports malformed hand-written dates instead of crashing', () => {
    const dir = gitRepo();
    raf(dir, ['init', '--no-hook']);
    raf(dir, ['add', 'a']);
    raf(dir, ['start', 'L1']);
    const path = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('started: 2026-09-28', 'started: 2026-9-3'));
    expect(raf(dir, ['check']).out).toContain('started « 2026-9-3 »');
    expect(raf(dir, ['gantt']).code).toBe(0);
  });

  it('reads a scalar « after: L1 » as a one-item list', () => {
    const path = join(tempDir(), 'raf.yaml');
    writeFileSync(path, 'version: 1\nlots:\n  - { id: L1, title: a }\n  - { id: L2, title: b, after: L1 }\n');
    expect(Plan.load(path).lot('L2').after).toEqual(['L1']);
  });
});

describe('transitions', () => {
  it('refuses to change a closed lot and unknown sub-tasks', () => {
    const dir = gitRepo();
    raf(dir, ['init', '--no-hook']);
    raf(dir, ['add', 'a']);
    raf(dir, ['done', 'L1']);
    expect(raf(dir, ['drop', 'L1']).code).toBe(2);
    expect(raf(dir, ['note', 'L1/t9', 'x']).code).toBe(2);
    raf(dir, ['add', 't', '--parent', 'L1']);
    raf(dir, ['done', 'L1/t1']);
    expect(raf(dir, ['done', 'L1/t1']).code).toBe(2);
  });
});

describe('CLI input validation', () => {
  it('turns argument errors into code 2, never a stack trace', () => {
    const dir = gitRepo();
    raf(dir, ['init', '--no-hook']);
    raf(dir, ['add', 'a']);
    expect(raf(dir, ['note', 'L1', '-5 degrés']).code).toBe(2);
    expect(raf(dir, ['note', 'L1', '--', '-5 degrés']).code).toBe(0);
    expect(raf(dir, ['check', '--idle', 'abc']).code).toBe(2);
    expect(raf(dir, ['now'], { RAF_TODAY: '28/09/2026' }).code).toBe(2);
  });

  it('creates the gantt output directory', () => {
    const dir = gitRepo();
    raf(dir, ['init', '--no-hook']);
    expect(raf(dir, ['gantt', '-o', 'out/deep/g.html']).code).toBe(0);
    expect(existsSync(join(dir, 'out/deep/g.html'))).toBe(true);
  });
});

describe('single lane', () => {
  it('schedules todo work after lots in progress', () => {
    const base = { quickwin: false, after: [], notes: [], tasks: [], problems: [] };
    const bars = schedule(
      [
        { ...base, id: 'L1', title: 'a', status: 'doing', started: '2026-09-28', estimate: 5 },
        { ...base, id: 'L2', title: 'b', status: 'todo', estimate: 1 },
      ],
      new Map(),
      '2026-09-28',
    );
    expect(bars[1]).toMatchObject({ start: '2026-10-05', end: '2026-10-05' });
  });
});
