import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const yaml = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
const lots = (dir: string): Record<string, any>[] => parse(yaml(dir)).lots;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

/** Un plan avec L1 (doing, estimate), L2 (doing) et L3 (todo). */
function setup(): string {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  raf(dir, 'add', 'A', '--estimate', '2');
  raf(dir, 'add', 'B');
  raf(dir, 'add', 'C');
  raf(dir, 'start', 'L1');
  raf(dir, 'start', 'L2');
  return dir;
}

describe('raf todo', () => {
  it('R1 — lot doing sans commit : status todo, started absent, note datée avec la raison', () => {
    const dir = setup();
    const r = raf(dir, 'todo', 'L1', '--reason', 'vague rendue');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('L1 → todo');
    const show = raf(dir, 'show', 'L1');
    expect(show.out).toContain('todo');
    expect(show.out).toContain('remis en attente : vague rendue');
    const lot = lots(dir)[0];
    expect(lot.status).toBe('todo');
    expect(lot).not.toHaveProperty('started');
    expect(lot.notes).toEqual([{ date: '2026-09-28', text: 'remis en attente : vague rendue' }]);
  });

  it('R1 — les autres clés du lot et les autres lots sont inchangés', () => {
    const dir = setup();
    const before = lots(dir);
    raf(dir, 'todo', 'L1');
    const after = lots(dir);
    expect(after[0]).toEqual({ ...before[0], status: 'todo', started: undefined, notes: [{ date: '2026-09-28', text: 'remis en attente' }] });
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);
    expect(raf(dir, 'list').out).toMatch(/L2 +doing/);
    expect(raf(dir, 'list').out).toMatch(/L3 +todo/);
  });

  it('R2 — un commit feat(Lx) existe : refus avec le nombre de commits, plan intact', () => {
    const dir = setup();
    commit(dir, 'feat(L1): un', '2026-09-28T10:00:00');
    commit(dir, 'fix(L1): deux', '2026-09-28T11:00:00');
    const before = yaml(dir);
    const r = raf(dir, 'todo', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('L1 a 2 commit(s) qui le citent : le remettre en attente perdrait leur lien — raf drop ou le laisser doing');
    expect(yaml(dir)).toBe(before);
  });

  it('R2 — un commit de plan seul (isPlanOnly) qui cite le lot ne bloque pas', () => {
    const dir = setup();
    git(dir, 'add', '.cadence/raf.yaml');
    commit(dir, 'chore(plan) L1: démarrage');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
  });

  it('R3 — lot todo : « est déjà todo »', () => {
    const dir = setup();
    const r = raf(dir, 'todo', 'L3');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('L3 est déjà todo');
  });

  it('R3 — lot done et lot dropped : refus, plan intact', () => {
    const dir = setup();
    raf(dir, 'done', 'L1');
    raf(dir, 'drop', 'L2');
    const before = yaml(dir);
    expect(raf(dir, 'todo', 'L1').err).toContain('L1 est done ; le rouvrir à la main dans le YAML si c\'est voulu');
    expect(raf(dir, 'todo', 'L2').err).toContain('L2 est dropped ; le rouvrir à la main dans le YAML si c\'est voulu');
    expect(yaml(dir)).toBe(before);
  });

  it('R3 — un lot done qui a des commits reçoit le refus de statut, pas celui des commits', () => {
    const dir = setup();
    commit(dir, 'feat(L1): un');
    raf(dir, 'done', 'L1', '--force');
    expect(raf(dir, 'todo', 'L1').err).toContain('le rouvrir à la main');
  });

  it('R4 — L1/t1 : refus avec le message', () => {
    const dir = setup();
    raf(dir, 'add', 'tâche', '--parent', 'L1');
    const r = raf(dir, 'todo', 'L1/t1');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('raf todo se pose sur un lot, pas une sous-tâche : L1/t1');
  });

  it('R4 — lot inconnu : « lot inconnu : L99 »', () => {
    const dir = setup();
    const r = raf(dir, 'todo', 'L99');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('lot inconnu : L99');
  });

  it('R4 — sans id : usage', () => {
    const dir = setup();
    const r = raf(dir, 'todo');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('todo <id>');
  });

  it('R6 — sans --reason : note « remis en attente »', () => {
    const dir = setup();
    raf(dir, 'todo', 'L1');
    expect(lots(dir)[0].notes).toEqual([{ date: '2026-09-28', text: 'remis en attente' }]);
  });

  it('R6 — --reason « vague rendue » : note « remis en attente : vague rendue »', () => {
    const dir = setup();
    raf(dir, 'todo', 'L1', '--reason', 'vague rendue');
    expect(lots(dir)[0].notes[0].text).toBe('remis en attente : vague rendue');
  });

  it('R7 — un lot doing avec une sous-tâche done : elle reste done', () => {
    const dir = setup();
    raf(dir, 'add', 'tâche', '--parent', 'L1');
    raf(dir, 'done', 'L1/t1');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
    expect(lots(dir)[0].tasks[0].status).toBe('done');
  });

  it('R8 — commit de plan seul citant le lot : la remise en attente passe', () => {
    const dir = setup();
    writeFileSync(join(dir, '.cadence/raf.yaml'), `${yaml(dir)}\n# retouche\n`);
    git(dir, 'add', '.cadence/raf.yaml');
    commit(dir, 'chore(L1): plan seul');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
  });

  it('R8 — commit de version citant le lot : passe', () => {
    const dir = setup();
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
    git(dir, 'add', 'CHANGELOG.md');
    commit(dir, 'chore(L1): release');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
  });
});
