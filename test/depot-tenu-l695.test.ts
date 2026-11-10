import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commitRefusal, holdRepo, HELD_DIR, PENDING_PLAN, readPending, repoHolders } from '../src/repo-held.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';

// L695 (D-9, erreur 1 du relevé du 10-11) : le lead ne commite plus sur la branche qu'un programme tient ; son plan attend la fin du programme.

const RAF_JS = () => join(testPackage(), 'bin/raf.js');

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-10' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-10T19:30:00Z') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un `raf` réel (paquet jetable) en tête du PATH, pour le hook git comme pour le lead. */
function rafEnv(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${RAF_JS()}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-10' };
}

/** Un dépôt avec son plan (L1), une porte verte, le hook raf installé et commité ; `.cadence-run` reste sous le dossier jetable. */
function project(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = gitRepo(tempDir());
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'Lot du lead');
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
  raf(dir, 'hook', 'install');
  const env = rafEnv();
  spawnSync('git', ['add', '-A'], { cwd: dir, env });
  expect(spawnSync('git', ['commit', '-qm', 'chore: plan'], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
  return { dir, env };
}

const sh = (cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
const planText = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
const sortie = (s: string) => JSON.stringify({ session_id: s, total_cost_usd: 0, result: 'fini', subtype: 'success' });

describe('L695 : dépôt tenu par un programme', () => {
  it('e2e : pendant un cadence run, raf note est mis en attente et le commit du lead sur main refusé ; le run s intègre puis applique la note', () => {
    const { dir, env } = project();
    const vu: Record<string, ReturnType<typeof sh> | string> = {};
    // Faux claude : pendant la session, le lead écrit le plan et tente un commit sur main ; la session, elle, commite dans son worktree.
    const exec: Executeur = (_args, o) => {
      vu.note = sh(dir, env, 'raf', 'note', 'L1', 'écrite pendant le run');
      vu.plan = planText(dir);
      writeFileSync(join(dir, 'lead.txt'), 'du lead');
      sh(dir, env, 'git', 'add', 'lead.txt');
      vu.commit = sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead');
      writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
      sh(o.cwd, env, 'git', 'add', 'fait.txt');
      vu.session = sh(o.cwd, env, 'git', 'commit', '-qm', 'feat: travail du run');
      return { stdout: sortie('s1'), code: 0 };
    };
    const lignes: string[] = [];
    const e = executerRun({ repo: dir, demande: 'Crée fait.txt', exec, out: (l) => lignes.push(l), raf: RAF_JS() });

    const note = vu.note as ReturnType<typeof sh>;
    expect(note.status).toBe(0);
    expect(note.stdout).toMatch(/mis en attente : raf note L1 écrite pendant le run — la branche main est tenue par cadence run/);
    expect(vu.plan).not.toMatch(/écrite pendant le run/);
    const commit = vu.commit as ReturnType<typeof sh>;
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toMatch(/commit refusé : la branche main est tenue par cadence run .* `raf add\|note\|done` écrivent dans \.cadence\/plan-en-attente\.yaml/);
    expect((vu.session as ReturnType<typeof sh>).status).toBe(0);

    expect(e.etat).toBe('integre');
    expect(sh(dir, env, 'git', 'log', '--format=%s', '-1').stdout.trim()).toBe('feat: travail du run');
    expect(planText(dir)).toMatch(/écrite pendant le run/);
    expect(existsSync(join(dir, PENDING_PLAN))).toBe(false);
    expect(lignes.join('\n')).toMatch(/plan en attente : 1 écriture\(s\) appliquée\(s\)/);
    expect(repoHolders(dir)).toEqual([]);
    // Le dépôt rendu, le commit du lead passe.
    expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead').status).toBe(0);
  });

  it('le plan en attente n est jamais suivi par git (info/exclude)', () => {
    const { dir, env } = project();
    const unhold = holdRepo(dir, 'porte', 'cadence verify --gate abc1234');
    try {
      expect(raf(dir, 'add', 'Nouveau lot').out).toMatch(/mis en attente : raf add Nouveau lot .* tenue par cadence verify --gate abc1234/);
    } finally {
      unhold();
    }
    expect(readPending(dir).map((w) => w.argv)).toEqual([['add', 'Nouveau lot']]);
    expect(sh(dir, env, 'git', 'status', '--porcelain').stdout).toBe('');
  });

  it('une autre branche n est pas tenue : un worktree de lot commite et écrit son plan librement', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      sh(dir, process.env, 'git', 'switch', '-qc', 'autre');
      expect(commitRefusal(dir)).toBeNull();
      expect(raf(dir, 'note', 'L1', 'sur autre').code).toBe(0);
      expect(planText(dir)).toMatch(/sur autre/);
      sh(dir, process.env, 'git', 'switch', '-q', 'main');
      expect(commitRefusal(dir)).toMatch(/tenue par porte/);
    } finally {
      unhold();
    }
  });

  it('raf attente liste ; appliquer est refusé tant que la branche est tenue, puis joue l attente', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'porte', 'cadence verify --gate abc1234');
    raf(dir, 'done', 'L1');
    expect(raf(dir, 'attente').out).toMatch(/raf done L1 {2}\(tenu par cadence verify --gate abc1234\)/);
    const refus = raf(dir, 'attente', 'appliquer');
    expect(refus.code).toBe(2);
    expect(refus.err).toMatch(/encore tenue par cadence verify --gate abc1234/);
    unhold();
    const ok = raf(dir, 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/1 écriture\(s\) appliquée\(s\)/);
    expect(planText(dir)).toMatch(/status: done/);
    expect(raf(dir, 'attente').out).toMatch(/rien en attente/);
  });

  it('un programme arrêté en route : son fichier est écarté, et le premier raf add applique l attente d abord', async () => {
    const { dir } = project();
    // Un porteur mort : un processus qui a fini.
    const child = spawn(process.execPath, ['-e', '0']);
    const pid = child.pid!;
    await new Promise((r) => child.once('exit', r));
    const held = join(dir, '.git', 'cadence', HELD_DIR);
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, `run-${pid}.json`), JSON.stringify({ pid, kind: 'run', label: 'cadence run mort', branch: 'main', since: '2026-11-10T19:00:00Z' }));
    mkdirSync(join(dir, '.cadence'), { recursive: true });
    writeFileSync(join(dir, PENDING_PLAN), '- date: 2026-11-10T19:01:00Z\n  tenu: cadence run mort\n  argv: [note, L1, laissée par le run]\n');
    expect(commitRefusal(dir)).toBeNull();
    expect(readdirSync(held)).toEqual([]);
    const add = raf(dir, 'add', 'Après');
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/plan en attente : 1 écriture\(s\) appliquée\(s\)/);
    expect(planText(dir)).toMatch(/laissée par le run/);
    expect(planText(dir)).toMatch(/Après/);
  });

  it('une écriture en attente qui échoue reste en attente avec les suivantes', () => {
    const { dir } = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    raf(dir, 'note', 'L99', 'lot inconnu');
    raf(dir, 'note', 'L1', 'ensuite');
    unhold();
    const r = raf(dir, 'attente', 'appliquer');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/0 écriture\(s\) appliquée\(s\), 2 restée\(s\) en attente \(échec de raf note L99 lot inconnu\)/);
    expect(readPending(dir)).toHaveLength(2);
  });
});
