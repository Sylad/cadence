import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const head = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

function repo() {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  raf(dir, 'add', 'Un lot');
  return dir;
}

describe('raf ignore : acquitter un commit sans réécrire l\'historique', () => {
  it('un commit sans lot est signalé, puis ne l\'est plus une fois acquitté par son sha', () => {
    const dir = repo();
    commit(dir, 'chore: .gitignore', '2026-09-28T10:00:00');
    expect(raf(dir, 'check').code).toBe(1);
    const r = raf(dir, 'ignore', head(dir).slice(0, 7), '--reason', 'outillage');
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(text).toContain(`sha: ${head(dir)}`);
    expect(text).toContain('date: 2026-09-28');
    expect(text).toContain('reason: outillage');
    expect(raf(dir, 'check').out).toContain('plan et historique cohérents');
  });

  it('un sujet exact acquitte le commit qui le porte', () => {
    const dir = repo();
    commit(dir, 'chore: nettoyage', '2026-09-28T10:00:00');
    expect(raf(dir, 'ignore', 'chore: nettoyage').code).toBe(0);
    expect(raf(dir, 'check').code).toBe(0);
  });

  it('couvre aussi un identifiant cité inconnu', () => {
    const dir = repo();
    commit(dir, 'plan: cadence L95', '2026-09-28T10:00:00');
    expect(raf(dir, 'check').out).toContain('L95 inconnu');
    expect(raf(dir, 'ignore', head(dir)).code).toBe(0);
    expect(raf(dir, 'check').code).toBe(0);
  });

  it('n\'acquitte que ce commit : un autre commit sans lot reste signalé', () => {
    const dir = repo();
    commit(dir, 'chore: a', '2026-09-28T10:00:00');
    raf(dir, 'ignore', head(dir));
    commit(dir, 'chore: b', '2026-09-28T11:00:00');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('chore: b');
    expect(r.out).not.toContain('chore: a');
  });

  it('refuse un commit ou un sujet introuvable, sans argument, et ne touche pas au plan', () => {
    const dir = repo();
    const avant = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(raf(dir, 'ignore', 'inexistant').code).toBe(2);
    expect(raf(dir, 'ignore').code).toBe(2);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(avant);
  });

  it('acquitter deux fois le même commit n\'ajoute pas de seconde ligne', () => {
    const dir = repo();
    commit(dir, 'chore: nettoyage', '2026-09-28T10:00:00');
    raf(dir, 'ignore', 'chore: nettoyage', '--reason', 'outillage');
    const r = raf(dir, 'ignore', 'chore: nettoyage');
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(text.match(/chore: nettoyage/g)).toHaveLength(1);
    expect(text).toContain('reason: outillage');
  });

  it('un sujet d\'un seul mot qui porte aussi le nom d\'une branche s\'acquitte par le sujet', () => {
    const dir = repo();
    commit(dir, 'chore: avant', '2026-09-28T09:00:00');
    execFileSync('git', ['branch', 'other'], { cwd: dir });
    commit(dir, 'other', '2026-09-28T10:00:00');
    const r = raf(dir, 'ignore', 'other');
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('subject: other');
    expect(raf(dir, 'check').out).toContain('chore: avant');
  });

  it('raf check --ignored liste les exemptions avec date et motif', () => {
    const dir = repo();
    commit(dir, 'chore: .gitignore', '2026-09-28T10:00:00');
    raf(dir, 'ignore', head(dir), '--reason', 'outillage');
    const r = raf(dir, 'check', '--ignored');
    expect(r.code).toBe(0);
    expect(r.out).toContain(head(dir).slice(0, 7));
    expect(r.out).toContain('chore: .gitignore');
    expect(r.out).toContain('2026-09-28');
    expect(r.out).toContain('outillage');
  });

  it('raf check --ignored sans exemption le dit', () => {
    expect(raf(repo(), 'check', '--ignored').out).toContain('aucun');
  });
});
