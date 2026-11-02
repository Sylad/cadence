import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { docSyncCommits } from '../src/docsync.js';
import { commit, gitRepo } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-09' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-09T18:30:00') });
  return { code, out: out.join('\n') };
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
function work(dir: string, message: string, files: string[]) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), `${message}\n${Math.random()}`);
  }
  git(dir, 'add', '--', ...files);
  commit(dir, message, '2026-10-09T10:00:00');
}
const CONFIG = `docs:\n  sync:\n    - paths: [src/**]\n      docs: [README.md]\n`;
async function repo() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Un lot');
  await cad(dir, 'start', 'L1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  git(dir, 'add', '--', '.cadence', 'cadence.yaml');
  commit(dir, 'chore(L1): départ', '2026-10-09T08:00:00');
  return dir;
}

describe('probe L537 — docs.sync ignore refactor', () => {
  it('un document écrit dans un commit refactor compte toujours pour le feat du même lot', async () => {
    const dir = await repo();
    work(dir, 'feat(L1): comportement', ['src/a.ts']);
    work(dir, 'refactor(L1): réécrit la doc', ['README.md']);
    expect((await cad(dir, 'check')).out).not.toContain('documentation en retard');
  });

  it('un refactor dont le corps annonce BREAKING CHANGE reste un changement', async () => {
    const dir = await repo();
    work(dir, 'refactor(L1): renomme la sortie\n\nBREAKING CHANGE: la sortie change', ['src/a.ts']);
    expect((await cad(dir, 'check')).out).toContain('documentation en retard');
  });

  it('refactor sur deux lots cités : le refactor seul reste ignoré', async () => {
    const dir = await repo();
    work(dir, 'refactor(L1): a', ['src/a.ts']);
    work(dir, 'refactor(L1): b', ['src/b.ts']);
    expect((await cad(dir, 'check')).out).not.toContain('documentation en retard');
  });

  it('docSyncCommits : espaces et formes voisines', () => {
    const c = (subject: string) => ({ subject }) as never;
    const keep = (s: string[]) => docSyncCommits(s.map(c)).map((x: { subject: string }) => x.subject);
    expect(keep(['refactor(L1) : x', 'refactorX(L1): x', 'refactoring: x', 'refactor(L1)!: x', 'refactor!: x', 'refactor(a)(b): x'])).toEqual(['refactor(L1) : x', 'refactorX(L1): x', 'refactoring: x', 'refactor(L1)!: x', 'refactor!: x', 'refactor(a)(b): x']);
    expect(keep(['refactor(): x', 'refactor:x'])).toEqual([]);
  });
});
