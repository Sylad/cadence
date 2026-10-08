import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { findProjects } from '../src/lead.js';
import { commit, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Un projet raf dans `dir` (créé au besoin) : un lot L1 en cours, un commit du jour. */
async function project(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(dir, ...a);
  await cad(dir, 'init', '--project', name, '--no-hook');
  await cad(dir, 'add', `Travail ${name}`);
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-28T09:00:00');
  await cad(dir, 'start', 'L1');
  git(dir, 'commit', '-qam', 'chore: plan');
  commit(dir, 'feat(L1): travail', '2026-09-28T10:00:00');
}

describe('cadence session start|close --all', () => {
  it('start --all : une section par projet, depuis un dossier qui n\'est pas un dépôt', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    await project(join(root, 'beta'), 'beta');
    mkdirSync(join(root, 'sans-plan'));
    const { code, out, err } = await cad(root, 'session', 'start', '--all');
    expect(err).toBe('');
    expect(code).toBe(0);
    const heads = out.split('\n').filter((l) => l.startsWith('## '));
    expect(heads).toEqual(['## alpha', '## beta']);
    expect(out).toContain('L1');
    expect(out).not.toContain('sans-plan');
  });

  it('close --all : code 1 si un projet reste ouvert, 0 quand tous sont fermés', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    await project(join(root, 'beta'), 'beta');
    writeFileSync(join(root, 'beta', 'sale.txt'), 'x');
    const open = await cad(root, 'session', 'close', '--all');
    expect(open.out.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## alpha', '## beta']);
    expect(open.code).toBe(1);
    const alone = await cad(root, 'session', 'close');
    expect(alone.code).toBe(2); // sans --all, un dossier non dépôt reste refusé
    expect(alone.err).toMatch(/session : à lancer dans un dépôt git/);
  });

  it('une erreur dans un projet se lit dans sa section et ne bloque pas les autres (code 2)', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    await project(join(root, 'beta'), 'beta');
    writeFileSync(join(root, 'alpha/docs/plan/raf.yaml'), 'lots: [\n');
    const { code, out } = await cad(root, 'session', 'start', '--all');
    expect(code).toBe(2);
    const lines = out.split('\n');
    expect(lines[lines.indexOf('## alpha') + 1]).toMatch(/^✗ /);
    expect(lines).toContain('## beta');
  });

  it('--depth 2 descend d\'un niveau de plus, sans entrer dans un projet', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    await project(join(root, 'groupe', 'gamma'), 'gamma');
    await project(join(root, 'alpha', 'sous', 'delta'), 'delta');
    expect(findProjects(root).map((d) => d.slice(root.length + 1))).toEqual(['alpha']);
    expect(findProjects(root, 2).map((d) => d.slice(root.length + 1))).toEqual(['alpha', 'groupe/gamma']);
    const { out } = await cad(root, 'session', 'start', '--all', '--depth', '2');
    expect(out.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## alpha', '## groupe/gamma']);
  });

  it('refuse un --depth invalide, --depth sans --all, --all hors start/close', async () => {
    const root = tempDir();
    expect((await cad(root, 'session', 'start', '--all', '--depth', '0')).err).toMatch(/--depth invalide/);
    expect((await cad(root, 'session', 'start', '--depth', '2')).err).toMatch(/--depth demande --all/);
    expect((await cad(root, 'session', 'next', '--all', 'x')).err).toMatch(/--all/);
  });

  it('sans projet : une ligne le dit', async () => {
    const { code, out } = await cad(tempDir(), 'session', 'close', '--all');
    expect(code).toBe(0);
    expect(out).toMatch(/aucun projet/);
  });

  it('transmet --since et --idle à chaque projet', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    expect((await cad(root, 'session', 'start', '--all', '--idle', 'x')).err).toMatch(/--idle invalide/);
    expect((await cad(root, 'session', 'start', '--all', '--since', '3 days ago')).code).toBe(0);
  });
});
