import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

function rafOn(today: string, dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${today}T09:30:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const raf = (dir: string, ...argv: string[]) => rafOn('2026-09-28', dir, ...argv);
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
    const text = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
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

  it('refuse un argument positionnel en trop (la raison sans --reason) et montre la forme attendue, sans toucher au plan', () => {
    const dir = repo();
    commit(dir, 'chore: a', '2026-09-28T10:00:00');
    const avant = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    const r = raf(dir, 'ignore', head(dir).slice(0, 7), 'outillage');
    expect(r.code).toBe(2);
    expect(r.err).toContain('un seul commit attendu ; la raison se passe par --reason "texte"');
    expect(r.err).not.toContain('aucun commit ne correspond');
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(avant);
    expect(raf(dir, 'ignore', head(dir).slice(0, 7), '--reason', 'outillage').code).toBe(0);
  });

  it('refuse un commit ou un sujet introuvable, sans argument, et ne touche pas au plan', () => {
    const dir = repo();
    const avant = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    expect(raf(dir, 'ignore', 'inexistant').code).toBe(2);
    expect(raf(dir, 'ignore').code).toBe(2);
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(avant);
  });

  it('acquitter deux fois le même commit n\'ajoute pas de seconde ligne', () => {
    const dir = repo();
    commit(dir, 'chore: nettoyage', '2026-09-28T10:00:00');
    raf(dir, 'ignore', 'chore: nettoyage', '--reason', 'outillage');
    const r = raf(dir, 'ignore', 'chore: nettoyage');
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
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
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toContain('subject: other');
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

  it('R1 — un commit qui cite un lot connu sans y travailler, acquitté, ne le fait plus compter comme commencé', () => {
    const dir = repo();
    commit(dir, 'plan: crée L1 (réglage cité)', '2026-09-28T10:00:00');
    const sha = head(dir);
    expect(raf(dir, 'check').out).toContain('L1 a 1 commit(s) mais est encore todo');
    expect(raf(dir, 'ignore', sha, '--reason', 'création de lots').code).toBe(0);
    expect(raf(dir, 'check')).toMatchObject({ code: 0, out: expect.stringContaining('plan et historique cohérents') });
    expect(raf(dir, 'check', '--ignored').out).toContain('création de lots');
  });

  it('R2 — le même commit acquitté ne rend pas non plus un lot terminé « postérieur à sa revue »', () => {
    const dir = repo();
    raf(dir, 'review', 'enable');
    raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): travail', '2026-09-28T10:00:00');
    expect(raf(dir, 'review', 'L1', 'conforme').code).toBe(0);
    rafOn('2026-09-29', dir, 'done', 'L1');
    rafOn('2026-09-29', dir, 'add', 'Deux');
    rafOn('2026-09-29', dir, 'start', 'L2');
    commit(dir, 'plan: crée L2 (L1 cité en réglage)', '2026-09-29T11:00:00');
    expect(rafOn('2026-09-30', dir, 'check').out).toContain('L1 est terminé avec 1 commit(s) postérieur(s) à sa revue de code');
    rafOn('2026-09-30', dir, 'ignore', head(dir), '--reason', 'création de lots');
    expect(rafOn('2026-09-30', dir, 'check').out).toContain('plan et historique cohérents');
    expect(raf(dir, 'commits', 'L1').out).not.toContain('plan: crée L2');
  });

  it('R3 — n\'acquitte que ce commit : le suivant qui cite le lot compte de nouveau', () => {
    const dir = repo();
    commit(dir, 'plan: crée L1', '2026-09-28T10:00:00');
    raf(dir, 'ignore', head(dir));
    commit(dir, 'feat(L1): travail', '2026-09-28T11:00:00');
    expect(raf(dir, 'check').out).toContain('L1 a 1 commit(s) mais est encore todo');
  });
});
