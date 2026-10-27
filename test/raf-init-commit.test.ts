import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

function raf(dir: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { cwd: dir, env: { RAF_TODAY: '2026-10-27' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-27T09:00:00') });
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Un dépôt neuf où `raf init` vient de passer ; le premier commit est celui que le parcours du nouvel utilisateur écrit. */
function initialised(withHook = false) {
  const dir = gitRepo();
  expect(raf(dir, ['init', '--project', 'demo', ...(withHook ? [] : ['--no-hook'])]).code).toBe(0);
  return dir;
}

describe('le commit qui suit raf init n\'ouvre pas d\'écart (L377, accroc A5)', () => {
  it('R1 — le commit de ce que raf init a écrit (plan, notes/.gitkeep, .gitignore) n\'est pas un commit sans lot', () => {
    const dir = initialised();
    git(dir, 'add', '.cadence', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'chore: init raf');
    const r = raf(dir, ['check']);
    expect(r.out + r.err).not.toContain('commit sans lot');
    expect(r.code).toBe(0);
  });

  it('R2 — le hook post-commit ne dit pas « commit sans lot » après ce commit', () => {
    const dir = initialised(true);
    git(dir, 'add', '.cadence', '.gitignore');
    const out = execFileSync('git', ['commit', '-m', 'chore: init raf'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    expect(out).not.toContain('commit sans lot');
    // le hook parle bel et bien : un commit de code sans lot, lui, est signalé
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n');
    git(dir, 'add', 'index.js');
    const code = spawnSync('git', ['commit', '-m', 'chore: code'], { cwd: dir, encoding: 'utf8' });
    expect(code.stdout + code.stderr).toContain('commit sans lot');
  });

  it('R3 — la création de cadence.yaml dans le même commit reste un commit de plan', () => {
    const dir = initialised();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: npm test\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: init raf');
    expect(raf(dir, ['check']).out).not.toContain('commit sans lot');
  });

  it('R3b — un cadence.yaml créé avec deliver: dans ce commit est du travail (seuls plan: et orchestrate: sont de l\'init)', () => {
    const dir = initialised();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: npm test\ndeliver:\n  verify: []\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: init raf');
    expect(raf(dir, ['check']).out).toContain('commit sans lot');
  });

  it('R4 — un fichier de code dans le même commit le rend à nouveau commit sans lot', () => {
    const dir = initialised();
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: init raf');
    expect(raf(dir, ['check']).out).toContain('commit sans lot');
  });

  it('R5 — un .gitignore qui gagne une autre ligne que celle de raf init reste du travail', () => {
    const dir = initialised();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.playwright-mcp/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: init raf');
    expect(raf(dir, ['check']).out).toContain('commit sans lot');
  });

  it('R6 — une modification de cadence.yaml (hors création) reste du travail', () => {
    const dir = initialised();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'plan: init');
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: b\n');
    git(dir, 'commit', '-q', '-am', 'chore: autre test');
    expect(raf(dir, ['check']).out).toContain('commit sans lot : ');
  });
});
