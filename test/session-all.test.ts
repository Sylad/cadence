import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { findProjects } from '../src/lead.js';
import { commit, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  return cadOn('2026-09-28', dir, ...argv);
}

async function cadOn(today: string, dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${today}T18:30:00`) });
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

  it('refuse --all avec RAF_FILE, --file ou --config : un seul plan ne vaut pas pour tous les projets', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    await project(join(root, 'beta'), 'beta');
    const plan = join(root, 'alpha', 'docs/plan/raf.yaml');
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['session', 'start', '--all'], { cwd: root, env: { RAF_TODAY: '2026-09-28', RAF_FILE: plan }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T18:30:00') });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/RAF_FILE.*--all|--all.*RAF_FILE/);
    expect(out.join('\n')).not.toMatch(/## /);
    for (const opt of ['--file', '--config']) {
      const r = await cad(root, 'session', 'start', '--all', opt, plan);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(opt));
    }
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
    const dflt = await cadOn('2026-09-30', root, 'session', 'start', '--all');
    expect(dflt.out).not.toMatch(/silencieux depuis/);
    expect(dflt.out).not.toContain('Fait depuis');
    const tuned = await cadOn('2026-09-30', root, 'session', 'start', '--all', '--idle', '0', '--since', '2026-09-27');
    expect(tuned.out).toMatch(/silencieux depuis 2 j/);
    expect(tuned.out).toContain('Fait depuis 2026-09-27');
  });

  it('un sous-dossier sans .git dans un dépôt est signalé, jamais lu avec le plan du dépôt parent', async () => {
    const root = tempDir();
    const mono = join(root, 'mono');
    await project(mono, 'mono');
    await project(join(mono, 'pkg-a'), 'pkg-a');
    rmSync(join(mono, 'pkg-a', '.git'), { recursive: true, force: true });
    const { code, out } = await cad(mono, 'session', 'start', '--all');
    const lines = out.split('\n');
    expect(lines).toContain('## pkg-a');
    expect(lines[lines.indexOf('## pkg-a') + 1]).toMatch(/^✗ .*dépôt/);
    expect(out).not.toContain('Travail mono');
    expect(code).toBe(2);
  });

  it('un sous-dossier illisible est signalé sans faire planter les autres (--depth 2)', async () => {
    const root = tempDir();
    await project(join(root, 'alpha'), 'alpha');
    const ferme = join(root, 'ferme');
    mkdirSync(ferme);
    chmodSync(ferme, 0o000);
    try {
      expect(() => findProjects(root, 2)).not.toThrow();
      const { out } = await cad(root, 'session', 'start', '--all', '--depth', '2');
      expect(out.split('\n')).toContain('## alpha');
    } finally {
      chmodSync(ferme, 0o755);
    }
  });
});
