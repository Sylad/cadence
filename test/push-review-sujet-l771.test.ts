import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { cleanupTempDirs, commit, gitRepo } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const push = (local: string, remote: string) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;

async function cli(dir: string, stdin: string, ...argv: string[]) {
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-17' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-17T10:00:00'), stdin: () => stdin });
  return { code, err: err.join('\n') };
}

const prePush = (dir: string, stdin: string) => cli(dir, stdin, 'hook', 'pre-push', 'origin');

function change(dir: string, file: string, text: string, message: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  commit(dir, message, '2026-11-17T10:00:00');
  return head(dir);
}

/** Plan natif, revue exigée, trois lots démarrés (L1, L2, L3) ; aucun n'est relu. */
async function project() {
  const dir = gitRepo();
  await cli(dir, '', 'init', '--no-hook');
  await cli(dir, '', 'review', 'enable');
  for (const t of ['Cache', 'Légende', 'Fragments']) await cli(dir, '', 'add', t);
  for (const id of ['L1', 'L2', 'L3']) await cli(dir, '', 'start', id);
  return { dir, base: change(dir, 'README.md', 'x\n', 'init') };
}

describe('hook pre-push : les lots d\'un commit sont ceux de son sujet, pas de son corps (L771)', () => {
  it('R1 — portée qui cite le lot relu, corps qui cite d\'autres lots non relus : le push passe', async () => {
    const { dir, base } = await project();
    const a = change(dir, 'src/a.ts', '1\n', 'fix(L1): cache\n\nDepuis L2, la règle L3 n\'admettait que CHANGELOG.md (probe-L2-bords).');
    await cli(dir, '', 'review', 'L1', 'conforme');
    const r = await prePush(dir, push(a, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R2 — portée sans lot, lot en fin de sujet relu, corps qui cite d\'autres lots (c384e01 de la 2.0.14) : le push passe', async () => {
    const { dir, base } = await project();
    const a = change(dir, 'src/a.ts', '1\n', 'fix(qualite): un lot écrit son fragment (L1)\n\nDepuis L2, la règle des lots de config (L3) n\'admettait que CHANGELOG.md.');
    await cli(dir, '', 'review', 'L1', 'conforme');
    expect((await prePush(dir, push(a, base))).code).toBe(0);
  });

  it('R3 — un id en tête de sujet, sans verdict : refusé, et seul ce lot est nommé', async () => {
    const { dir, base } = await project();
    const a = change(dir, 'src/a.ts', '1\n', 'L1 : cache vidé\n\nComme L2 et L3.');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${a.slice(0, 7)})`);
    expect(r.err).not.toContain('L2 (');
    expect(r.err).not.toContain('L3 (');
  });

  it('R4 — portée qui cite le lot, sans verdict : refusé même quand le corps ne cite rien', async () => {
    const { dir, base } = await project();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L2): légende');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L2 (${a.slice(0, 7)})`);
  });

  it('R5 — un lot cité seulement dans le corps n\'est pas jugé : le commit passe comme un commit sans lot', async () => {
    const { dir, base } = await project();
    const a = change(dir, 'notes.txt', 'n\n', 'docs: notes\n\nVoir L1 et L2.');
    expect((await prePush(dir, push(a, base))).code).toBe(0);
  });
});
