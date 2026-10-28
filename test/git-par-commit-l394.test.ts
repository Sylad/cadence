import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n') };
}

/** Un dépôt avec L1 en cours et `n` commits de travail qui le citent. */
async function repoWith(n: number) {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Cache');
  await cad(dir, 'add', 'Index');
  appendFileSync(join(dir, 'cadence.yaml'), 'docs:\n  sync:\n    - paths: [src/**]\n      docs: [README.md]\n  since: 2026-09-01\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-27T09:00:00');
  await cad(dir, 'start', 'L1');
  git(dir, 'add', '.cadence');
  commit(dir, 'plan: L1 démarré', '2026-09-28T09:00:00');
  for (let i = 0; i < n; i++) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', `f${i}.ts`), `export const a${i} = 1;\n`);
    git(dir, 'add', `src/f${i}.ts`);
    commit(dir, `feat(L1): étape ${i}`, '2026-09-28T10:00:00');
    writeFileSync(join(dir, `g${i}.ts`), `export const b${i} = 1;\n`);
    git(dir, 'add', `g${i}.ts`);
    commit(dir, `feat(L2): étape ${i}`, '2026-09-28T10:00:00'); // L2 reste todo : l'audit filtre ses commits de plan
  }
  return dir;
}

/** Lance `fn` avec un `git` d'enveloppe qui note chaque sous-commande ; rend les sous-commandes lancées. */
async function gitCalls(fn: () => Promise<unknown>): Promise<string[]> {
  const bin = tempDir();
  const log = join(bin, 'calls.log');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'git');
  writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do case "$a" in -c|core.*) ;; -*) ;; *) echo "$a" >> '${log}'; break;; esac; done\nexec '${real}' "$@"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(log, '');
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    await fn();
  } finally {
    process.env.PATH = before;
  }
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

describe('raf check et raf session start lisent les fichiers des commits en un seul git (L394)', () => {
  it('R1 — raf check ne lance aucun git diff-tree par commit : 12 commits liés, au plus un git log groupé', async () => {
    const dir = await repoWith(12);
    const calls = await gitCalls(() => cad(dir, 'check'));
    expect(calls.filter((c) => c === 'diff-tree')).toEqual([]);
    expect(calls.filter((c) => c === 'log').length).toBeLessThanOrEqual(4);
  });

  it('R2 — raf session start ne lance aucun git diff-tree par commit', async () => {
    const dir = await repoWith(12);
    const calls = await gitCalls(() => cad(dir, 'session', 'start'));
    expect(calls.filter((c) => c === 'diff-tree')).toEqual([]);
  });

  it('R3 — le verdict ne change pas : l\'écart docs.sync de L1 est toujours signalé, sans compter les commits de L2', async () => {
    const dir = await repoWith(3);
    const out = (await cad(dir, 'check')).out;
    expect(out).toContain('L1 : documentation en retard');
    expect(out).not.toContain('L2 : documentation en retard');
  });
});
