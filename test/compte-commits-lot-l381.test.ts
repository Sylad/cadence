import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { changedFiles, preloadChangedFiles } from '../src/git.js';
import { commit, gitRepo } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n') };
}

/** L1 démarré, dont le seul commit est celui du plan (« plan: L1 démarré »). */
async function planOnlyLot() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Cache');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-27T09:00:00');
  await cad(dir, 'start', 'L1');
  git(dir, 'add', '.cadence');
  commit(dir, 'plan: L1 démarré', '2026-09-28T09:00:00');
  return dir;
}

const withWork = (dir: string) => {
  writeFileSync(join(dir, 'cache.ts'), 'export {};\n');
  git(dir, 'add', 'cache.ts');
  commit(dir, 'feat(L1): cache', '2026-09-28T10:00:00');
};

/** Le compte de commits de la barre d'un lot dans la page du gantt (colonne du tableau et infobulle lisent ce champ). */
async function ganttCount(dir: string, id: string): Promise<number> {
  const path = (await cad(dir, 'gantt')).out;
  const html = readFileSync(path, 'utf8');
  const m = html.match(new RegExp(`"id":"${id}"[^}]*?"commits":(\\d+)`));
  if (!m) throw new Error(`lot ${id} absent du gantt`);
  return Number(m[1]);
}

describe('raf gantt compte les commits de travail, comme raf commits (L381)', () => {
  it('R1 — raf gantt ne compte pas le commit de plan : « plan: L1 démarré » seul, 0 commit', async () => {
    const dir = await planOnlyLot();
    expect((await cad(dir, 'commits', 'L1')).out).toBe('');
    expect(await ganttCount(dir, 'L1')).toBe(0);
  });

  it('R2 — raf gantt compte un commit de travail une fois, comme raf commits', async () => {
    const dir = await planOnlyLot();
    withWork(dir);
    expect((await cad(dir, 'commits', 'L1')).out.split('\n')).toHaveLength(1);
    expect(await ganttCount(dir, 'L1')).toBe(1);
  });

  it('R3 — la lecture groupée des fichiers d’un commit rend ce que rend git diff-tree : noms accentués, commit vide, racine', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'été.ts'), 'a\n');
    writeFileSync(join(dir, 'b c.ts'), 'b\n');
    git(dir, 'add', '.');
    commit(dir, 'feat: deux fichiers');
    commit(dir, 'chore: vide');
    const shas = execFileSync('git', ['rev-list', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    const direct = shas.map((sha) => changedFiles(dir, sha));
    preloadChangedFiles(dir, shas);
    expect(shas.map((sha) => changedFiles(dir, sha))).toEqual(direct);
    expect(direct).toEqual([[], ['b c.ts', 'été.ts']]);
  });
});
