import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';
import { dossierTemp } from './temp.js';

export function ioTest(env: NodeJS.ProcessEnv = {}): Io & { sortie: string[]; erreurs: string[] } {
  const sortie: string[] = []; const erreurs: string[] = [];
  return { cwd: '/', env, now: () => new Date('2026-11-09T10:00:00Z'), out: (l) => sortie.push(l), err: (l) => erreurs.push(l), sortie, erreurs };
}

describe('cadence2', () => {
  it('sans argument, affiche l\'aide et sort en 0', async () => {
    const io = ioTest();
    expect(await run([], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(/cadence2 bench/);
  });
  it('commande inconnue : code 2', async () => {
    const io = ioTest();
    expect(await run(['zorglub'], io)).toBe(2);
    expect(io.erreurs[0]).toMatch(/inconnue/);
  });
});

describe('cadence run : aide et options inconnues (issue #54)', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  function depot(): string {
    const repo = join(dossierTemp('run-aide-'), 'projet');
    mkdirSync(repo, { recursive: true }); writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    return repo;
  }
  const rienCree = (repo: string) => {
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(join(dirname(repo), '.cadence-run'))).toBe(false);
  };

  for (const args of [['--help'], ['-h'], ['--fond', '--help'], ['Crée x', '--help']]) {
    it(`${args.join(' ')} : l'usage sur la sortie, code 0, ni worktree ni branche ni état`, async () => {
      const repo = depot(), io = { ...ioTest(), cwd: repo };
      expect(await run(['run', ...args], io)).toBe(0);
      expect(io.sortie.join('\n')).toMatch(/cadence run "<demande>"/);
      expect(io.erreurs).toEqual([]);
      rienCree(repo);
    });
  }

  for (const args of [['--zorglub'], ['--taile', 'fonction', 'Crée x'], ['- corrige x'], ['--fond', '--aide']]) {
    it(`${JSON.stringify(args)} : refusé en code 2, rien créé`, async () => {
      const repo = depot(), io = { ...ioTest(), cwd: repo };
      expect(await run(['run', ...args], io)).toBe(2);
      expect(io.erreurs[0]).toMatch(/option inconnue : -/);
      expect(io.erreurs[0]).toMatch(/cadence run "<demande>"/);
      rienCree(repo);
    });
  }
});
