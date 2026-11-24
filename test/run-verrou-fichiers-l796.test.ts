import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commitRefusal, HELD_DIR, repoHolders } from '../src/repo-held.js';
import { processStart } from '../src/proc.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';

// L796 (issue #70 du compte pro) : cadence run tenait toute la branche ; le pre-commit refusait tout commit du lead sur main pendant 30 à 60 min,
// même sur des fichiers que le run ne touche pas, et un `raf start` laissé non commité au lancement faisait rendre le lot `refus-integration` (~50 min).

const RAF_JS = () => join(testPackage(), 'bin/raf.js');
function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-24' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-11-24T08:00:00Z') });
  return { code, out: out.join('\n') };
}
function rafEnv(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${RAF_JS()}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-24' };
}
const sh = (cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const sortie = (s: string) => JSON.stringify({ session_id: s, total_cost_usd: 0, result: 'fini', subtype: 'success' });
const planText = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');

/** Un dépôt avec son plan (L1, L2), une porte verte, le hook raf installé ; `hook` false : sans hook. */
function project(hook = true): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = gitRepo(tempDir());
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'Lot du run');
  raf(dir, 'add', 'Autre lot');
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'guide.md'), 'v1\n');
  if (hook) raf(dir, 'hook', 'install');
  const env = rafEnv();
  sh(dir, env, 'git', 'add', '-A');
  expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: plan').status).toBe(0);
  return { dir, env };
}

describe('L796 (1) : le run ne verrouille que les fichiers qu il touche', () => {
  it('pre-commit : un commit du lead sur des fichiers disjoints passe, un commit sur un fichier du run (commité ou en cours) est refusé et le nomme', () => {
    const { dir } = project(false);
    const wt = join(tempDir(), 'wt');
    expect(git(dir, 'worktree', 'add', '-q', '-b', 'cadence/run-1', wt, 'HEAD').status).toBe(0);
    writeFileSync(join(wt, 'fait.txt'), 'commité');
    git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'feat: fait');
    writeFileSync(join(wt, 'en-cours.txt'), 'pas encore commité');
    const held = join(dir, '.git', 'cadence', HELD_DIR);
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, `run-${process.pid}.json`), JSON.stringify({ pid: process.pid, start: processStart(process.pid), kind: 'run', label: 'cadence run 1', branch: 'main', since: '2026-11-24T08:00:00Z', worktree: wt }));

    writeFileSync(join(dir, 'docs', 'guide.md'), 'v2\n'); git(dir, 'add', 'docs/guide.md');
    expect(commitRefusal(dir)).toBeNull(); // autre dossier : disjoint
    writeFileSync(join(dir, 'fait.txt'), 'du lead'); git(dir, 'add', 'fait.txt');
    expect(commitRefusal(dir)).toMatch(/commit refusé : la branche main est tenue par cadence run 1 .*fichiers que le run touche aussi : fait\.txt/);
    git(dir, 'reset', '-q', 'fait.txt');
    writeFileSync(join(dir, 'en-cours.txt'), 'du lead'); git(dir, 'add', 'en-cours.txt');
    expect(commitRefusal(dir)).toMatch(/: en-cours\.txt/); // un fichier que la session écrit sans l'avoir commité compte aussi
  });

  it('un porteur sans worktree (porte dans l arbre principal) tient toute la branche, comme avant', () => {
    const { dir } = project(false);
    const held = join(dir, '.git', 'cadence', HELD_DIR);
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, `porte-${process.pid}.json`), JSON.stringify({ pid: process.pid, start: processStart(process.pid), kind: 'porte', label: 'porte', branch: 'main', since: '2026-11-24T08:00:00Z' }));
    writeFileSync(join(dir, 'docs', 'guide.md'), 'v2\n'); git(dir, 'add', 'docs/guide.md');
    expect(commitRefusal(dir)).toMatch(/commit refusé : la branche main est tenue par porte/);
  });

  it('e2e (points 1 et 2) : pendant un vrai cadence run, le commit disjoint du lead passe, celui sur le fichier du run est refusé ; le run rebase et intègre', () => {
    const { dir, env } = project();
    const vu: Record<string, ReturnType<typeof sh>> = {};
    const exec: Executeur = (_args, o) => {
      writeFileSync(join(o.cwd, 'fait.txt'), 'ok'); // la session écrit, pas encore commité
      writeFileSync(join(dir, 'fait.txt'), 'du lead');
      sh(dir, env, 'git', 'add', 'fait.txt');
      vu.chevauche = sh(dir, env, 'git', 'commit', '-qm', 'chore: fait du lead');
      sh(dir, env, 'git', 'rm', '-q', '--cached', 'fait.txt'); sh(dir, env, 'rm', 'fait.txt');
      writeFileSync(join(dir, 'docs', 'guide.md'), 'v2\n');
      vu.disjoint = sh(dir, env, 'git', 'commit', '-qam', 'docs: guide du lead');
      sh(o.cwd, env, 'git', 'add', 'fait.txt');
      vu.session = sh(o.cwd, env, 'git', 'commit', '-qm', 'feat: travail du run');
      return { stdout: sortie('s1'), code: 0 };
    };
    const lignes: string[] = [];
    const e = executerRun({ repo: dir, demande: 'Crée fait.txt', exec, out: (l) => lignes.push(l), raf: RAF_JS() });
    expect(vu.chevauche.status).not.toBe(0);
    expect(vu.chevauche.stderr).toMatch(/commit refusé : la branche main est tenue par cadence run .*: fait\.txt/);
    expect(vu.disjoint.status).toBe(0);
    expect(vu.session.status).toBe(0);
    expect(e.etat).toBe('integre');
    expect(sh(dir, env, 'git', 'log', '--format=%s', '-3').stdout.trim()).toBe('feat: travail du run\ndocs: guide du lead\nchore: plan');
    expect(repoHolders(dir)).toEqual([]);
  });
});

describe('L796 (3) : le raf start du lot laissé non commité au lancement', () => {
  /** La session écrit aussi le plan (une note sur son lot) : avant L796, l'avance rapide butait sur le raf start non commité de l'arbre principal. */
  const sessionQuiNote = (lot: string): Executeur => (_args, o) => {
    const plan = join(o.cwd, '.cadence/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(`id: ${lot}\n`, `id: ${lot}\n    notes:\n      - 2026-11-24 note de la session\n`));
    writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
    git(o.cwd, 'add', '-A'); git(o.cwd, 'commit', '-qm', `feat(${lot}): travail du run`);
    return { stdout: sortie('s1'), code: 0 };
  };

  it('est commité par le run au lancement : le lot s intègre au lieu de rendre refus-integration', () => {
    const { dir, env } = project();
    expect(raf(dir, 'start', 'L1').code).toBe(0);
    expect(git(dir, 'status', '--porcelain').stdout).toMatch(/raf\.yaml/);
    const lignes: string[] = [];
    const e = executerRun({ repo: dir, demande: 'Crée fait.txt', lot: 'L1', exec: sessionQuiNote('L1'), out: (l) => lignes.push(l), raf: RAF_JS() });
    expect(e.etat).toBe('integre');
    expect(sh(dir, env, 'git', 'log', '--format=%s', '-2').stdout.trim()).toBe('feat(L1): travail du run\nplan: L1 démarré');
    expect(git(dir, 'status', '--porcelain').stdout).toBe('');
    expect(planText(dir)).toMatch(/title: Lot du run\n\s+status: doing/);
    expect(lignes.join('\n')).toMatch(/raf start L1 laissé non commité : commité par le run \(plan: L1 démarré, [0-9a-f]{7}\)/);
  });

  it('un plan modifié au-delà du start du lot n est pas commité par le run : avertissement comme avant', () => {
    const { dir } = project();
    expect(raf(dir, 'start', 'L1').code).toBe(0);
    writeFileSync(join(dir, '.cadence/raf.yaml'), planText(dir).replace('title: Autre lot', 'title: Autre lot renommé'));
    const avant = git(dir, 'rev-parse', 'HEAD').stdout;
    const lignes: string[] = [];
    executerRun({ repo: dir, demande: 'x', lot: 'L1', exec: (_a, o) => { writeFileSync(join(o.cwd, 'fait.txt'), 'ok'); git(o.cwd, 'add', '-A'); git(o.cwd, 'commit', '-qm', 'feat(L1): x'); return { stdout: sortie('s1'), code: 0 }; }, out: (l) => lignes.push(l), raf: RAF_JS() });
    expect(git(dir, 'log', '--format=%s', '-2').stdout).not.toMatch(/plan: L1 démarré/);
    expect(git(dir, 'rev-parse', 'HEAD~1').stdout).toBe(avant);
    expect(lignes.join('\n')).toMatch(/modifications non commitées .*\.cadence\/raf\.yaml/);
    expect(planText(dir)).toMatch(/Autre lot renommé/);
  });
});
