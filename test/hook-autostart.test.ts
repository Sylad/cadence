import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readHookConfig } from '../src/config.js';
import { messageFromArgv } from '../src/hook.js';
import { gitRepo, tempDir } from './helpers.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

/** Un dépôt avec le plan commité, le hook installé et un `raf` réel (paquet jetable) en tête du PATH. */
function project(autostart?: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = gitRepo();
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'A');
  raf(dir, 'add', 'B');
  raf(dir, 'start', 'L2');
  if (autostart) writeFileSync(join(dir, 'cadence.yaml'), `hook:\n  autostart: ${autostart}\n`);
  raf(dir, 'hook', 'install');
  const bin = tempDir();
  const shim = join(bin, 'raf');
  writeFileSync(shim, `#!/bin/sh\nexec node "${join(process.env.CADENCE_TEST_PACKAGE!, 'bin/raf.js')}" "$@"\n`);
  chmodSync(shim, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-09-28' };
  spawnSync('git', ['add', '-A'], { cwd: dir, env });
  // Le hook est déjà là : le premier commit ne cite pas de lot et ne porte que le plan.
  expect(spawnSync('git', ['commit', '-qm', 'chore: plan'], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
  return { dir, env };
}

function work(dir: string, env: NodeJS.ProcessEnv, message: string, extra: string[] = []) {
  writeFileSync(join(dir, 'src.txt'), `${Math.random()}`);
  git(dir, 'add', 'src.txt');
  return spawnSync('git', ['commit', '-q', '-m', message, ...extra], { cwd: dir, env, encoding: 'utf8' });
}

const planText = (dir: string) => readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
const count = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD').stdout.trim());

describe('(L104) hook.autostart dans cadence.yaml', () => {
  it('readHookConfig : warn, refuse, start ; le reste est refusé', () => {
    const dir = tempDir();
    const file = join(dir, 'cadence.yaml');
    expect(readHookConfig(file)).toEqual({});
    writeFileSync(file, 'hook:\n  autostart: refuse\n');
    expect(readHookConfig(file)).toEqual({ autostart: 'refuse' });
    writeFileSync(file, 'hook:\n  autostart: start\n');
    expect(readHookConfig(file)).toEqual({ autostart: 'start' });
    writeFileSync(file, 'hook:\n  autostart: warn\n');
    expect(readHookConfig(file)).toEqual({ autostart: 'warn' });
    writeFileSync(file, 'hook:\n  autostart: oui\n');
    expect(() => readHookConfig(file)).toThrow(/hook\.autostart.*warn.*refuse.*start/);
    writeFileSync(file, 'hook:\n  autre: 1\n');
    expect(() => readHookConfig(file)).toThrow(/hook\.autre inconnu/);
  });

  it('messageFromArgv lit -m, -am, --message, plusieurs -m et -F', () => {
    const f = join(tempDir(), 'msg.txt');
    writeFileSync(f, 'feat(L3): depuis un fichier\n');
    expect(messageFromArgv(['git', 'commit', '-m', 'feat(L1): a'])).toBe('feat(L1): a');
    expect(messageFromArgv(['git', 'commit', '-am', 'feat(L1): b'])).toBe('feat(L1): b');
    expect(messageFromArgv(['git', 'commit', '--message=feat(L1): c'])).toBe('feat(L1): c');
    expect(messageFromArgv(['git', 'commit', '--message', 'feat(L1): d', '-m', 'corps'])).toBe('feat(L1): d\n\ncorps');
    expect(messageFromArgv(['git', 'commit', '-mfeat(L1): e'])).toBe('feat(L1): e');
    expect(messageFromArgv(['git', 'commit', '-F', f])).toBe('feat(L3): depuis un fichier\n');
    expect(messageFromArgv(['git', 'commit', '--amend'])).toBeNull();
    expect(messageFromArgv(['git', 'status'])).toBeNull();
  });

  it('raf hook install pose aussi le bloc pre-commit, sans doublon', () => {
    const dir = gitRepo();
    raf(dir, 'hook', 'install');
    const pre = join(dir, '.git/hooks/pre-commit');
    expect(readFileSync(pre, 'utf8')).toContain('raf hook pre-commit');
    expect(raf(dir, 'hook', 'install').out).toContain('déjà présent');
    expect(readFileSync(pre, 'utf8').match(/>>> raf/g)).toHaveLength(1);
  });

  it('par défaut : l\'avertissement actuel, le commit passe et le lot reste todo', () => {
    const { dir, env } = project();
    const r = work(dir, env, 'feat(L1): a');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('L1 est encore todo');
    expect(planText(dir)).not.toMatch(/id: L1[\s\S]*?status: doing[\s\S]*?id: L2/);
    const warn = project('warn');
    expect(work(warn.dir, warn.env, 'feat(L1): a').status).toBe(0);
  });

  it('refuse : le commit sur un lot todo échoue bruyamment avec « raf start <id> », rien n\'est commité', () => {
    const { dir, env } = project('refuse');
    const before = count(dir);
    const r = work(dir, env, 'feat(L1): a');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('L1 est encore todo');
    expect(r.stderr).toContain('raf start L1');
    expect(count(dir)).toBe(before);
    expect(raf(dir, 'show', 'L1').out).toContain('todo');
  });

  it('refuse : lot en cours, commit sans lot, commit du plan seul et --no-verify passent', () => {
    const { dir, env } = project('refuse');
    expect(work(dir, env, 'feat(L2): b').status).toBe(0);
    expect(work(dir, env, 'wip').status).toBe(0);
    expect(work(dir, env, 'feat(L1): c', ['--no-verify']).status).toBe(0);
    raf(dir, 'add', 'C');
    git(dir, 'add', 'docs/plan/raf.yaml');
    expect(spawnSync('git', ['commit', '-qm', 'chore(L3): plan'], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
  });

  it('start : le hook fait raf start, le plan part dans le MÊME commit, sans amend ni plan sale', () => {
    const { dir, env } = project('start');
    const before = count(dir);
    const r = work(dir, env, 'feat(L1): a');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('raf start L1');
    expect(count(dir)).toBe(before + 1);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').stdout.split('\n').filter(Boolean).sort()).toEqual(['docs/plan/raf.yaml', 'src.txt']);
    expect(git(dir, 'status', '--porcelain').stdout).toBe('');
    expect(raf(dir, 'show', 'L1').out).toContain('doing');
    expect(git(dir, 'reflog', '-1', '--format=%gs').stdout).toContain('commit');
  });

  it('start : un lot déjà en cours, un commit sans lot ou du plan seul ne touchent pas au plan', () => {
    const { dir, env } = project('start');
    const plan = planText(dir);
    expect(work(dir, env, 'feat(L2): b').status).toBe(0);
    expect(work(dir, env, 'wip').status).toBe(0);
    expect(planText(dir)).toBe(plan);
    expect(git(dir, 'status', '--porcelain').stdout).toBe('');
  });

  it('start : sans message lisible (éditeur), rien n\'est démarré et le commit passe', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    writeFileSync(join(dir, 'cadence.yaml'), 'hook:\n  autostart: start\n');
    const r = raf(dir, 'hook', 'pre-commit');
    expect(r.code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).toContain('todo');
  });
});
