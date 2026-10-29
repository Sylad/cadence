import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { INTEGRATION_LOCK } from '../src/orchestrate/integrate.js';
import { sharedStateDir } from '../src/state.js';
import { gitRepo, tempDir } from './helpers.js';

// L425 — raf add / note / done préviennent quand une intégration du dépôt est en cours : un fichier suivi modifié dans l'arbre principal la fait refuser.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-29' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-29T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function projet() {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  raf(dir, 'add', 'un');
  raf(dir, 'start', 'L1');
  return dir;
}

const lockFile = (dir: string) => join(sharedStateDir(dir), INTEGRATION_LOCK);
const integrating = (dir: string, pid = process.pid) => writeFileSync(lockFile(dir), JSON.stringify({ pid, wave: '2026-10-29-cad3', started: '2026-10-29T09:00:00Z' }));
const WARN = /intégration en cours \(vague 2026-10-29-cad3, pid \d+\)/;

describe('raf add / note / done pendant une intégration (L425)', () => {
  it('R1 — raf add avertit sur stderr de l\'intégration en cours, et ajoute le lot', () => {
    const dir = projet();
    integrating(dir);
    const r = raf(dir, 'add', 'deux');
    expect(r.code).toBe(0);
    expect(r.out).toBe('L2');
    expect(r.err).toMatch(WARN);
    expect(r.err).toContain('refuser');
  });
  it('R1 — raf note avertit et écrit la note', () => {
    const dir = projet();
    integrating(dir);
    const r = raf(dir, 'note', 'L1', 'bonjour');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(WARN);
    expect(raf(dir, 'show', 'L1').out).toContain('bonjour');
  });
  it('R1 — raf done avertit et clôt le lot', () => {
    const dir = projet();
    integrating(dir);
    const r = raf(dir, 'done', 'L1', '--force');
    expect(r.code).toBe(0);
    expect(r.out).toContain('L1 → done');
    expect(r.err).toMatch(WARN);
  });
  it('R2 — sans intégration en cours : aucun avertissement', () => {
    const dir = projet();
    for (const argv of [['add', 'deux'], ['note', 'L1', 'x'], ['done', 'L1', '--force']]) expect(raf(dir, ...argv).err).not.toMatch(/intégration en cours/);
  });
  it('R2 — verrou d\'un porteur mort : aucun avertissement', () => {
    const dir = projet();
    integrating(dir, 2 ** 22 + 12345);
    expect(raf(dir, 'add', 'deux').err).not.toMatch(/intégration en cours/);
  });
  it('R3 — depuis un worktree d\'un lot, pas d\'avertissement : seul l\'arbre principal fait refuser l\'intégration', () => {
    const dir = projet();
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'plan'], { stdio: 'ignore' });
    const tree = join(tempDir(), 'wt');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'lot', tree], { stdio: 'ignore' });
    try {
      integrating(dir);
      expect(raf(tree, 'note', 'L1', 'x').err).not.toMatch(/intégration en cours/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
