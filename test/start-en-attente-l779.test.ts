import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { holdRepo, PENDING_PLAN, readPending, uncommittedFiles } from '../src/repo-held.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';

// L779 (issue #66 du compte pro) : pendant qu'un cadence run tient la branche, `raf note` allait au plan en attente mais `raf start` écrivait
// .cadence/raf.yaml dans l'arbre principal ; la séquence documentée `raf start <lot> && cadence run … --fond` salissait le plan, et le run suivant
// disait « l'arbre principal a des modifications non commitées : .cadence/raf.yaml ». `raf start` passe désormais par le plan en attente.

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-24' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-24T08:00:00Z') }) as number;
  } catch (e) {
    return { code: -1, out: out.join('\n'), err: `${err.join('\n')}${(e as Error).message}` };
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const planText = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');

/** Un dépôt avec son plan (L1, L2 todo, L3 done), tout commité. */
function project(): string {
  const dir = gitRepo(tempDir());
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'Lot du lead');
  raf(dir, 'add', 'Autre lot');
  raf(dir, 'add', 'Lot fini');
  raf(dir, 'done', 'L3');
  git(dir, 'add', '-A');
  expect(git(dir, 'commit', '-qm', 'chore: plan').status).toBe(0);
  return dir;
}

/** Un `raf` réel (paquet jetable) en tête du PATH, comme le lancerait le lead dans son terminal. */
function rafEnv(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${join(testPackage(), 'bin/raf.js')}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-24' };
}

describe('L779 : raf start sur une branche tenue par cadence run', () => {
  it('e2e : pendant un vrai cadence run, le lead fait raf note puis raf start pour son lot suivant ; rien n est écrit dans l arbre principal, le run s intègre et applique les deux', () => {
    const dir = project();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
    git(dir, 'add', '-A');
    expect(git(dir, 'commit', '-qm', 'chore: porte').status).toBe(0);
    const env = rafEnv();
    const vu: Record<string, unknown> = {};
    // Faux claude : pendant la session du run, le lead prépare le lot suivant dans l'arbre principal (la séquence de l'issue, avant son propre cadence run).
    const exec: Executeur = (_args, o) => {
      vu.note = spawnSync('raf', ['note', 'L2', 'à lancer ensuite'], { cwd: dir, env, encoding: 'utf8' });
      vu.start = spawnSync('raf', ['start', 'L2'], { cwd: dir, env, encoding: 'utf8' });
      vu.diff = git(dir, 'diff', '--name-only').stdout;
      vu.nonCommites = uncommittedFiles(dir);
      writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
      git(o.cwd, 'add', 'fait.txt');
      git(o.cwd, 'commit', '-qm', 'feat: travail du run');
      return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 };
    };
    const lignes: string[] = [];
    const e = executerRun({ repo: dir, demande: 'Crée fait.txt', exec, out: (l) => lignes.push(l), raf: join(testPackage(), 'bin/raf.js') });

    const start = vu.start as ReturnType<typeof spawnSync>;
    expect(start.status).toBe(0);
    expect(String(start.stdout)).toMatch(/mis en attente : raf start L2 — la branche main est tenue par cadence run/);
    expect(vu.diff).toBe('');
    expect(vu.nonCommites).toEqual([]);
    expect(e.etat).toBe('integre');
    expect(lignes.join('\n')).toMatch(/plan en attente : 2 écriture\(s\) appliquée\(s\)/);
    expect(planText(dir)).toMatch(/title: Autre lot\n\s+status: doing/);
    expect(planText(dir)).toMatch(/à lancer ensuite/);
    expect(existsSync(join(dir, PENDING_PLAN))).toBe(false);
  });

  it('rejoue l issue #66 : raf note puis raf start sont mis en attente, l arbre principal reste propre, le run qui rend le dépôt les applique', () => {
    const dir = project();
    const before = planText(dir);
    const unhold = holdRepo(dir, 'run', 'cadence run 20261124070000-1');
    try {
      const note = raf(dir, 'note', 'L1', 'à lancer après le run');
      expect(note.code).toBe(0);
      expect(note.out).toMatch(/^mis en attente : raf note L1/);
      const start = raf(dir, 'start', 'L1');
      expect(start.code).toBe(0);
      expect(start.out).toMatch(/^mis en attente : raf start L1 — la branche main est tenue par cadence run 20261124070000-1 .*appliqué par le run quand il rend le dépôt \(2 en attente\)/);
      expect(start.out).not.toMatch(/L1 → doing/);
      // Ce que montrait l'issue : git diff du plan (status: doing, started:) ; et ce que le cadence run suivant aurait nommé au départ.
      expect(planText(dir)).toBe(before);
      expect(git(dir, 'diff', '--name-only').stdout).toBe('');
      expect(uncommittedFiles(dir)).toEqual([]);
      expect(readPending(dir).map((w) => w.argv)).toEqual([['note', 'L1', 'à lancer après le run'], ['start', 'L1']]);
    } finally {
      unhold();
    }
    const ok = raf(dir, 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/2 écriture\(s\) appliquée\(s\)/);
    expect(planText(dir)).toMatch(/id: L1\n\s+title: Lot du lead\n\s+status: doing/);
    expect(planText(dir)).toMatch(/started: 2026-11-24/);
  });

  it('un raf start invalide est refusé tout de suite, pas mis en attente (il bloquerait les écritures suivantes)', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 20261124070000-1');
    try {
      const inconnu = raf(dir, 'start', 'L9');
      expect(inconnu.code).not.toBe(0);
      expect(inconnu.err).toMatch(/L9/);
      const fini = raf(dir, 'start', 'L3');
      expect(fini.code).not.toBe(0);
      expect(fini.err).toMatch(/L3 est done/);
      expect(raf(dir, 'start', 'L1').code).toBe(0);
      const deja = raf(dir, 'start', 'L1');
      expect(deja.code).not.toBe(0);
      expect(deja.err).toMatch(/L1 : raf start déjà en attente/);
      expect(raf(dir, 'start').code).not.toBe(0);
      expect(readPending(dir).map((w) => w.argv)).toEqual([['start', 'L1']]);
    } finally {
      unhold();
    }
  });

  it('sur une branche libre, raf start écrit le plan comme avant', () => {
    const dir = project();
    const start = raf(dir, 'start', 'L2');
    expect(start.code).toBe(0);
    expect(start.out).toMatch(/L2 → doing/);
    expect(planText(dir)).toMatch(/title: Autre lot\n\s+status: doing/);
    expect(readPending(dir)).toEqual([]);
  });
});
