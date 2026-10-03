import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

async function raf(dir: string, ...argv: string[]) {
  return rafOn('2026-09-28', dir, ...argv);
}

async function rafOn(today: string, dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const planOf = (dir: string) => readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');

describe('revue de code', () => {
  it('inactive sans reviewSince : un lot à commits se ferme sans revue, check ne dit rien', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): cache');
    expect((await raf(dir, 'done', 'L1')).code).toBe(0);
    expect((await raf(dir, 'check')).out).toBe('✓ plan et historique cohérents');
    expect(planOf(dir)).not.toContain('review');
  });

  it('active : done refusé sans verdict pour un lot à commits, accepté après raf review ; check le signale', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    const enabled = await raf(dir, 'review', 'enable');
    expect(enabled.code).toBe(0);
    expect(enabled.out).toBe('revue de code obligatoire pour les lots à commits à partir du 2026-09-28');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'add', 'Sans commit');
    await raf(dir, 'add', 'Relu avant de fermer');
    for (const id of ['L1', 'L2', 'L3']) await raf(dir, 'start', id);
    commit(dir, 'feat(L1): cache');
    commit(dir, 'fix(L1): cache vidé au redémarrage');
    commit(dir, 'feat(L3): relu');

    const refused = await raf(dir, 'done', 'L1');
    expect(refused.code).toBe(2);
    expect(refused.err).toBe('raf: L1 a 2 commit(s) : revue de code attendue avant done — raf review L1 "verdict" (--force pour passer outre)');
    expect(planOf(dir)).not.toContain('status: done');
    // Un lot sans commit n'a rien à faire relire.
    expect((await raf(dir, 'done', 'L2')).code).toBe(0);

    expect((await raf(dir, 'review', 'L3', 'conforme')).code).toBe(0);
    expect((await raf(dir, 'done', 'L3')).code).toBe(0);

    expect((await rafOn('2026-09-29', dir, 'done', 'L1', '--force')).code).toBe(0);
    const check = await raf(dir, 'check');
    expect(check.code).toBe(1);
    expect(check.out).toContain('✗ L1 est terminé avec 2 commit(s) sans revue de code — raf review L1 "verdict"');
    expect(check.out).not.toContain('L2 est terminé');
    expect(check.out).not.toContain('L3 est terminé');

    expect((await raf(dir, 'review', 'L1', 'conforme', 'après', '1', 'correction')).code).toBe(0);
    const yaml = planOf(dir);
    expect(yaml).toContain('reviewSince: 2026-09-28');
    expect(yaml.indexOf('reviewSince:')).toBeLessThan(yaml.indexOf('lots:'));
    expect(yaml).toContain('review: { date: 2026-09-28, verdict: conforme après 1 correction }');
    expect((await raf(dir, 'check')).out).toBe('✓ plan et historique cohérents');
  });

  it('un lot terminé le jour de l’activation n’est pas un écart', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): cache');
    await raf(dir, 'done', 'L1');
    await raf(dir, 'review', 'enable');
    expect((await raf(dir, 'check')).out).not.toContain('revue de code');
  });

  it('un commit qui ne touche que le plan ne donne rien à relire', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'review', 'enable');
    await raf(dir, 'add', 'Publier');
    await raf(dir, 'start', 'L1');
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'chore(plan): L1 publier'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-28T10:00:00', GIT_COMMITTER_DATE: '2026-09-28T10:00:00' } });
    expect((await rafOn('2026-09-29', dir, 'done', 'L1')).code).toBe(0);
    expect((await raf(dir, 'check')).out).not.toContain('revue de code');
  });

  it('la porte UX et la porte de revue de code se cumulent', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'ux', 'enable');
    await raf(dir, 'review', 'enable');
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): écran');
    expect((await raf(dir, 'done', 'L1')).err).toContain('raf ux L1');
    await raf(dir, 'ux', 'L1', 'conforme');
    expect((await raf(dir, 'done', 'L1')).err).toContain('raf review L1');
    await raf(dir, 'review', 'L1', 'conforme');
    expect((await raf(dir, 'done', 'L1')).code).toBe(0);
    expect(planOf(dir)).toMatch(/uxSince: 2026-09-28\nreviewSince: 2026-09-28\nlots:/);
  });

  it('review enable est idempotent ; review exige un verdict, un lot connu, pas une sous-tâche', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'review', 'enable');
    expect((await rafOn('2026-09-30', dir, 'review', 'enable')).out).toBe('revue de code déjà active depuis le 2026-09-28');
    expect(planOf(dir)).toContain('reviewSince: 2026-09-28');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'add', 'partie', '--parent', 'L1');
    expect((await raf(dir, 'review')).code).toBe(2);
    expect((await raf(dir, 'review', 'L1')).code).toBe(2);
    expect((await raf(dir, 'review', 'L9', 'ok')).err).toBe('raf: lot inconnu : L9');
    const task = await raf(dir, 'review', 'L1/t1', 'ok');
    expect(task.code).toBe(2);
    expect(task.err).toBe('raf: la revue de code se note sur un lot, pas une sous-tâche');
    expect(planOf(dir)).not.toContain('review:');
  });

  it('un verdict vide ou blanc est refusé et n’ouvre pas la porte', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'review', 'enable');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): cache');
    for (const blank of [[''], ['   '], ['', ' \t']]) {
      const r = await raf(dir, 'review', 'L1', ...blank);
      expect(r.code).toBe(2);
      expect(r.err).toBe('raf: verdict vide : la revue de code attend son verdict — raf review L1 "verdict"');
    }
    expect(planOf(dir)).not.toContain('review:');
    expect((await raf(dir, 'done', 'L1')).code).toBe(2);
    expect(() => Plan.load(join(dir, 'docs/plan/raf.yaml')).recordReview('L1', ' ', '2026-09-28')).toThrow(/verdict vide/);
  });

  it('un verdict écrit à la main dans le YAML est lu', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'review', 'enable');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): cache');
    const path = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(path, planOf(dir).replace('    status: doing\n', '    status: doing\n    review: { date: 2026-09-28, verdict: conforme }\n'));
    expect((await raf(dir, 'done', 'L1')).code).toBe(0);
  });

  it('l’aide cite la porte de revue de code à côté de la porte UX', async () => {
    const help = (await raf(gitRepo(), '--help')).out;
    expect(help).toContain('raf review enable');
    expect(help).toContain('raf review <id> "verdict"');
    expect(help).toContain('agent code-reviewer');
  });
});

describe('raf commits', () => {
  const planCommit = (dir: string, message: string) => {
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-28T12:00:00', GIT_COMMITTER_DATE: '2026-09-28T12:00:00' } });
  };

  it('liste les commits que la porte compte pour le lot, du plus ancien au plus récent', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    const path = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(path, planOf(dir).replace('lots:', "ignore: ['^auto: ']\nlots:"));
    await raf(dir, 'review', 'enable');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'add', 'Autre');
    await raf(dir, 'add', 'Sans commit');
    await raf(dir, 'add', 'partie', '--parent', 'L1');
    await raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): brouillon d’avant le plan', '2026-09-01T10:00:00');
    commit(dir, 'feat(L1): cache', '2026-09-28T10:00:00');
    commit(dir, 'feat(L2): autre', '2026-09-28T10:30:00');
    commit(dir, 'auto: synchro L1', '2026-09-28T10:45:00');
    commit(dir, 'fix(L1/t1): cache vidé au redémarrage\n\ncorps du message', '2026-09-28T11:00:00');
    planCommit(dir, 'chore(plan): L1 en cours');

    const listed = await raf(dir, 'commits', 'L1');
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/^[0-9a-f]{7} feat\(L1\): cache\n[0-9a-f]{7} fix\(L1\/t1\): cache vidé au redémarrage$/);
    // Le même ensemble que celui que « raf done » compte.
    await raf(dir, 'done', 'L1/t1');
    expect((await raf(dir, 'done', 'L1')).err).toContain('L1 a 2 commit(s)');
    expect((await raf(dir, 'commits', 'L2')).out).toMatch(/^[0-9a-f]{7} feat\(L2\): autre$/);

    const none = await raf(dir, 'commits', 'L3');
    expect(none).toEqual({ code: 0, out: '', err: '' });
  });

  it('exige un lot connu, pas une sous-tâche', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Cache');
    await raf(dir, 'add', 'partie', '--parent', 'L1');
    expect(await raf(dir, 'commits')).toEqual({ code: 2, out: '', err: 'raf: usage : raf commits <lot>' });
    expect(await raf(dir, 'commits', 'L9')).toEqual({ code: 2, out: '', err: 'raf: lot inconnu : L9' });
    expect(await raf(dir, 'commits', 'L1/t1')).toEqual({ code: 2, out: '', err: 'raf: les commits se listent par lot, pas par sous-tâche : L1/t1' });
  });

  it('plan en lecture seule : NC2 ne prend pas les commits de NC2.4, le fichier ne change pas', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: suivi/taches.yaml\n  since: 2026-09-01\n  lots: taches\n  fields: { title: titre, status: etat }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\n');
    const taches = 'taches:\n- { id: NC2, titre: Socle, etat: en_cours }\n- { id: NC2.4, titre: Scores, etat: en_cours }\n';
    mkdirSync(join(dir, 'suivi'));
    writeFileSync(join(dir, 'suivi/taches.yaml'), taches);
    commit(dir, 'feat(NC2): socle', '2026-09-28T10:00:00');
    commit(dir, 'feat(NC2.4): scores', '2026-09-28T11:00:00');
    commit(dir, 'fix(api): suite de NC2.', '2026-09-28T12:00:00');
    execFileSync('git', ['add', 'suivi/taches.yaml'], { cwd: dir });
    commit(dir, 'plan: NC2 et NC2.4 en cours', '2026-09-28T13:00:00');

    expect((await raf(dir, 'commits', 'NC2')).out).toMatch(/^[0-9a-f]{7} feat\(NC2\): socle\n[0-9a-f]{7} fix\(api\): suite de NC2\.$/);
    expect((await raf(dir, 'commits', 'NC2.4')).out).toMatch(/^[0-9a-f]{7} feat\(NC2\.4\): scores$/);
    expect(readFileSync(join(dir, 'suivi/taches.yaml'), 'utf8')).toBe(taches);
  });

  it('l’aide la cite', async () => {
    expect((await raf(gitRepo(), '--help')).out).toContain('raf commits <id>');
  });
});
