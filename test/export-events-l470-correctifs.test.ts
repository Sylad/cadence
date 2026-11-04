import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// L470 — correctifs de la revue : ordre réel des changements d'état d'un même jour, merges, commits d'entretien du plan.
const PLAN = '.cadence/raf.yaml';
const CONFIG = `plan:
  states: { a_faire: todo, code: doing, bloque: doing, teste: doing, termine: done, abandonne: dropped }
  doneState: termine
`;
function raf(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: process.env.TEST_DAY, GIT_AUTHOR_DATE: process.env.TEST_DAY } }).trim();
}
function commit(dir: string, stamp: string, message: string, ...paths: string[]) {
  process.env.TEST_DAY = stamp;
  git(dir, 'add', '--', ...paths);
  git(dir, 'commit', '-q', '-m', message, '--', ...paths);
  return git(dir, 'rev-parse', 'HEAD');
}
function project(lots = 1) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  // Adoption avant les jours des commits d'essai : sinon `raf commits` les écarte comme antérieurs au plan.
  writeFileSync(join(dir, PLAN), readFileSync(join(dir, PLAN), 'utf8').replace(/^since: \S+/m, 'since: 2026-10-01'));
  for (let i = 1; i <= lots; i++) raf(dir, 'add', `Lot ${i}`);
  commit(dir, '2026-10-10T08:00:00', 'plan', PLAN, 'cadence.yaml');
  return dir;
}
const events = (dir: string) => JSON.parse(raf(dir, 'events', '--json').out).events as Record<string, unknown>[];

describe('L470 — correctifs de la revue', () => {
  it('rejoue — deux changements d\'état d\'un même lot le même jour restent dans l\'ordre des commits, pas de l\'alphabet', () => {
    const dir = project();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'code');
    commit(dir, '2026-10-11T08:00:00', 'plan: code', PLAN);
    raf(dir, 'status', 'L1', 'bloque');
    const a = commit(dir, '2026-10-11T09:00:00', 'plan: bloque', PLAN);
    raf(dir, 'status', 'L1', 'code');
    const b = commit(dir, '2026-10-11T15:00:00', 'plan: code', PLAN);
    const etats = events(dir).filter((e) => e.type === 'etat');
    expect(etats.map((e) => e.sha).slice(-2)).toEqual([a, b]);
    expect(etats.at(-1)).toMatchObject({ from: 'bloque', to: 'code' });
  });
  it('merge — un commit de merge ne fabrique pas d\'événement etat pour un lot qu\'une autre branche a changé', () => {
    const dir = project(2);
    raf(dir, 'start', 'L1');
    raf(dir, 'start', 'L2');
    commit(dir, '2026-10-10T09:00:00', 'plan: démarrage', PLAN);
    const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'br');
    raf(dir, 'status', 'L1', 'teste');
    commit(dir, '2026-10-11T09:00:00', 'plan: L1 teste', PLAN);
    git(dir, 'checkout', '-q', main);
    raf(dir, 'status', 'L2', 'teste');
    const l2 = commit(dir, '2026-10-12T09:00:00', 'plan: L2 teste', PLAN);
    process.env.TEST_DAY = '2026-10-13T09:00:00';
    git(dir, 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'Merge br', 'br');
    const etats = events(dir).filter((e) => e.type === 'etat' && String(e.day) >= '2026-10-11');
    expect(etats.find((e) => e.sha === l2)).toMatchObject({ lot: 'L2', to: 'teste' });
    expect(etats.filter((e) => e.lot === 'L1' && e.from === 'teste')).toEqual([]);
    expect(etats.filter((e) => e.lot === 'L1' && e.to === 'teste')).toHaveLength(1);
  });
  it('commits — un commit du seul plan et un commit acquitté (raf ignore) ne donnent pas d\'événement commit, comme raf commits', () => {
    const dir = project();
    raf(dir, 'start', 'L1');
    commit(dir, '2026-10-11T09:00:00', 'plan: L1 démarré', PLAN);
    writeFileSync(join(dir, 'a.txt'), 'x');
    const ignored = commit(dir, '2026-10-11T10:00:00', 'chore(L1): outillage', 'a.txt');
    raf(dir, 'ignore', ignored, '--reason', 'outillage');
    writeFileSync(join(dir, 'b.txt'), 'x');
    const work = commit(dir, '2026-10-11T11:00:00', 'feat(L1): du travail', 'b.txt');
    const shas = events(dir).filter((e) => e.type === 'commit').map((e) => e.sha);
    expect(shas).toEqual([work]);
    expect(raf(dir, 'commits', 'L1').out).toContain(work.slice(0, 7));
  });
});
