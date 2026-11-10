import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commitPaths } from '../src/git.js';
import { processStart } from '../src/proc.js';
import { applyPending, commitRefusal, deferPlanWrite, holdRepo, HELD_DIR, PENDING_PLAN, readPending, repoHolders } from '../src/repo-held.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { gitRepo, isRunning, tempDir, testPackage } from './helpers.js';

// L695, revue r1 (D-10) : majeurs 1 à 4 — verrou du run rendu dans tous les cas, programmes non refusés par le hook,
// porte en place testée, plan en attente sous verrou.

const RAF_JS = () => join(testPackage(), 'bin/raf.js');
const VITE_NODE = join(process.cwd(), 'node_modules/.bin/vite-node');

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-10' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-10T19:30:00Z') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function rafEnv(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${RAF_JS()}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-10' };
}

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
const heldDir = (dir: string) => join(dir, '.git', 'cadence', HELD_DIR);
const sortie = (s: string) => JSON.stringify({ session_id: s, total_cost_usd: 0, result: 'fini', subtype: 'success' });
const until = async (ok: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return ok();
};
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Lance `code` (TypeScript, imports absolus) dans un processus à part ; rend sa fin. */
function child(code: string): { pid: number; done: Promise<number | null> } {
  const f = join(tempDir(), 'enfant.ts');
  writeFileSync(f, code);
  const c = spawn(VITE_NODE, [f], { detached: true, stdio: 'ignore' });
  return { pid: c.pid!, done: new Promise((r) => c.on('exit', (code) => r(code))) };
}
const src = (p: string) => JSON.stringify(join(process.cwd(), p));

describe('L695 r1, majeur 1 : le run rend son verrou dans tous les cas', () => {
  it('le fichier tenu du run porte l heure de démarrage du processus : un pid repris ne le tient plus', () => {
    const { dir } = project();
    let tenu: { pid: number; start?: string } | null = null;
    const exec: Executeur = () => {
      const f = readdirSync(heldDir(dir))[0]!;
      tenu = JSON.parse(readFileSync(join(heldDir(dir), f), 'utf8'));
      return { stdout: sortie('s1'), code: 0 };
    };
    executerRun({ repo: dir, demande: 'rien', exec, out: () => {}, raf: RAF_JS() });
    expect(tenu).not.toBeNull();
    expect(tenu!.pid).toBe(process.pid);
    expect(tenu!.start).toBe(processStart(process.pid));
  });

  it('un fichier tenu dont le pid vit mais a été repris (autre heure de démarrage) ne bloque pas le commit et est retiré', () => {
    const { dir } = project();
    mkdirSync(heldDir(dir), { recursive: true });
    writeFileSync(join(heldDir(dir), `run-${process.pid}.json`), JSON.stringify({ pid: process.pid, start: 'un-autre-depart', kind: 'run', label: 'cadence run ancien', branch: 'main', since: '2026-11-09T22:00:00Z' }));
    expect(commitRefusal(dir)).toBeNull();
    expect(readdirSync(heldDir(dir))).toEqual([]);
  });

  it('une exception pendant le run : le dépôt est rendu, le plan en attente appliqué, l état dit l échec', () => {
    const { dir, env } = project();
    const exec: Executeur = () => {
      sh(dir, env, 'raf', 'note', 'L1', 'pendant le run qui plante');
      throw new Error('panne simulée');
    };
    const lignes: string[] = [];
    const e = executerRun({ repo: dir, demande: 'rien', exec, out: (l) => lignes.push(l), raf: RAF_JS() });
    expect(e.etat).toBe('echec');
    expect(e.detail).toMatch(/panne simulée/);
    expect(repoHolders(dir)).toEqual([]);
    expect(readdirSync(heldDir(dir))).toEqual([]);
    expect(planText(dir)).toMatch(/pendant le run qui plante/);
    expect(existsSync(join(dir, PENDING_PLAN))).toBe(false);
  });

  it('Ctrl-C pendant la session : le run meurt et la branche n est plus tenue', async () => {
    const { dir } = project();
    const c = child(
      `import { spawnSync } from 'node:child_process';\n` +
        `import { executerRun } from ${src('v2/src/run/run.ts')};\n` +
        `executerRun({ repo: ${JSON.stringify(dir)}, demande: 'rien', raf: ${JSON.stringify(RAF_JS())}, out: () => {}, exec: () => { const r = spawnSync('sleep', ['30']); return { stdout: '', code: r.status ?? 1 }; } });\n`,
    );
    try {
      expect(await until(() => existsSync(heldDir(dir)) && readdirSync(heldDir(dir)).length > 0, 20_000)).toBe(true);
      expect(commitRefusal(dir)).toMatch(/tenue par cadence run/);
      process.kill(-c.pid, 'SIGINT');
      await c.done;
      expect(await until(() => !isRunning(c.pid), 3_000)).toBe(true);
      expect(commitRefusal(dir)).toBeNull();
      expect(readdirSync(heldDir(dir))).toEqual([]);
    } finally {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }
  }, 40_000);
});

describe('L695 r1, majeur 2 : le hook ne refuse que le commit du lead', () => {
  it('pendant un hold, un commit de programme (commitPaths : deliver, config set) passe ; celui du lead est refusé', () => {
    const { dir, env } = project();
    const unhold = holdRepo(dir, 'run', 'cadence run test');
    try {
      writeFileSync(join(dir, 'lead.txt'), 'lead');
      sh(dir, env, 'git', 'add', 'lead.txt');
      const lead = sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead');
      expect(lead.status).not.toBe(0);
      expect(lead.stderr).toMatch(/commit refusé/);
      sh(dir, env, 'git', 'reset', '-q', 'lead.txt');
      writeFileSync(join(dir, 'programme.txt'), 'programme');
      const prev = process.env.PATH;
      process.env.PATH = env.PATH;
      try {
        expect(commitPaths(dir, ['programme.txt'], 'chore(L1): commit d un programme')).toMatch(/^[0-9a-f]{7,}$/);
      } finally {
        process.env.PATH = prev;
      }
      expect(sh(dir, env, 'git', 'log', '--format=%s', '-1').stdout.trim()).toBe('chore(L1): commit d un programme');
    } finally {
      unhold();
    }
  });

  it('le commit du plan d une vague v1 (commitPlan) passe par le même chemin que les programmes', () => {
    const text = readFileSync(join(process.cwd(), 'src/orchestrate/cycle/plan-writes.ts'), 'utf8');
    expect(text).toMatch(/commitAsProgram\(repo, \[/);
    expect(text).not.toMatch(/git\(repo, 'commit'/);
  });
});

describe('L695 r1, majeur 3 : verify --gate en place tient la branche pendant la porte et la rend après', () => {
  function gateRepo(test: string): { repo: string; sha: string } {
    const repo = gitRepo(tempDir());
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: ${JSON.stringify(test)}\nverify:\n  inPlace: true\n`);
    spawnSync('git', ['add', '.'], { cwd: repo });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    return { repo, sha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() };
  }
  const gate = (repo: string, sha: string) =>
    verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), verify: readVerifyConfig(join(repo, 'cadence.yaml')), out: () => {} });

  it.each([['verte', 0, 'true'], ['rouge', 1, 'false']] as const)('porte %s : tenue pendant, rendue après', async (_, code, last) => {
    const seen = join(tempDir(), 'vu.txt');
    const { repo, sha } = gateRepo(`cat .git/cadence/${HELD_DIR}/*.json > ${seen}; ${last}`);
    expect(await gate(repo, sha)).toBe(code);
    const vu = JSON.parse(readFileSync(seen, 'utf8')) as { kind: string; label: string; branch: string; start?: string };
    expect(vu).toMatchObject({ kind: 'porte', branch: 'main' });
    expect(vu.label).toBe(`cadence verify --gate ${sha.slice(0, 7)}`);
    expect(vu.start).toBe(processStart(process.pid));
    expect(repoHolders(repo)).toEqual([]);
    expect(readdirSync(join(repo, '.git', 'cadence', HELD_DIR))).toEqual([]);
  });

  it('porte interrompue (SIGTERM) : le fichier tenu est retiré avant la mort', async () => {
    const { repo, sha } = gateRepo('exec sleep 30');
    const c = child(
      `import { verifyGate } from ${src('src/verify-gate.ts')};\n` +
        `import { readOrchestrateConfig, readVerifyConfig } from ${src('src/config.ts')};\n` +
        `process.exitCode = await verifyGate({ repo: ${JSON.stringify(repo)}, sha: ${JSON.stringify(sha)}, config: readOrchestrateConfig(${JSON.stringify(join(repo, 'cadence.yaml'))}), verify: readVerifyConfig(${JSON.stringify(join(repo, 'cadence.yaml'))}), out: () => {} });\n`,
    );
    const dir = join(repo, '.git', 'cadence', HELD_DIR);
    try {
      expect(await until(() => existsSync(dir) && readdirSync(dir).length > 0, 20_000)).toBe(true);
      process.kill(c.pid, 'SIGTERM');
      await c.done;
      // Retiré par le processus lui-même (le pid est mort, mais on regarde le dossier sans passer par repoHolders, qui écarte aussi les morts).
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }
  }, 40_000);
});

describe('L695 r1, majeur 4 : le plan en attente est écrit et appliqué sous verrou', () => {
  const holder = { pid: 1, kind: 'run', label: 'cadence run B', branch: 'main', since: '2026-11-10T20:00:00Z' };

  it('une écriture mise en attente pendant une application n est pas perdue', async () => {
    const { dir } = project();
    deferPlanWrite(dir, { ...holder, label: 'cadence run A' }, ['note', 'L1', 'de A'], new Date());
    const marker = join(tempDir(), 'pret');
    let c: ReturnType<typeof child> | null = null;
    applyPending(dir, () => {
      c = child(
        `import { writeFileSync } from 'node:fs';\n` +
          `import { deferPlanWrite } from ${src('src/repo-held.ts')};\n` +
          `writeFileSync(${JSON.stringify(marker)}, '1');\n` +
          `deferPlanWrite(${JSON.stringify(dir)}, ${JSON.stringify(holder)}, ['note', 'L1', 'du lead pendant B'], new Date());\n`,
      );
      for (let i = 0; i < 400 && !existsSync(marker); i++) pause(50);
      pause(800); // sans verrou, l'enfant a écrit pendant ce temps et l'application l'efface en finissant
      return 0;
    }, () => {});
    expect(await c!.done).toBe(0);
    expect(readPending(dir).map((w) => w.argv)).toEqual([['note', 'L1', 'du lead pendant B']]);
  }, 40_000);

  it('deux applications concurrentes ne jouent pas deux fois la même écriture', async () => {
    const { dir } = project();
    deferPlanWrite(dir, holder, ['note', 'L1', 'une seule fois'], new Date());
    const marker = join(tempDir(), 'pret');
    const log = join(tempDir(), 'joue.txt');
    writeFileSync(log, '');
    let c: ReturnType<typeof child> | null = null;
    const joue: string[][] = [];
    applyPending(dir, (argv) => {
      joue.push(argv);
      c = child(
        `import { appendFileSync, writeFileSync } from 'node:fs';\n` +
          `import { applyPending } from ${src('src/repo-held.ts')};\n` +
          `writeFileSync(${JSON.stringify(marker)}, '1');\n` +
          `applyPending(${JSON.stringify(dir)}, (argv) => { appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n'); return 0; }, () => {});\n`,
      );
      for (let i = 0; i < 400 && !existsSync(marker); i++) pause(50);
      pause(800);
      return 0;
    }, () => {});
    expect(await c!.done).toBe(0);
    expect(joue).toEqual([['note', 'L1', 'une seule fois']]);
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(readPending(dir)).toEqual([]);
  }, 40_000);
});
