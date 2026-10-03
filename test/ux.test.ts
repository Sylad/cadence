import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

async function raf(dir: string, ...argv: string[]) {
  return rafOn('2026-09-28', dir, ...argv);
}

async function rafOn(today: string, dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('revue UX', () => {
  it('inactive sans uxSince : un lot visible se ferme sans revue', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'start', 'L1');
    expect((await raf(dir, 'done', 'L1')).code).toBe(0);
  });

  it('active : done refusé sans revue, accepté après raf ux ; check le signale', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    expect((await raf(dir, 'ux', 'enable')).code).toBe(0);
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'add', 'Interne');
    await raf(dir, 'start', 'L1');
    await raf(dir, 'start', 'L2');
    const refused = await raf(dir, 'done', 'L1');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('raf ux L1');
    expect((await raf(dir, 'done', 'L2')).code).toBe(0);

    await rafOn('2026-09-29', dir, 'done', 'L1', '--force');
    expect((await raf(dir, 'check')).out).toContain('L1 est visible et terminé sans revue UX');

    expect((await raf(dir, 'ux', 'L1', 'conforme', 'après', 'correction', 'du', 'contraste')).code).toBe(0);
    const yaml = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(yaml).toContain('uxSince: 2026-09-28');
    expect(yaml).toContain('ux: { date: 2026-09-28, verdict: conforme après correction du contraste }');
    expect((await raf(dir, 'check')).out).not.toContain('revue UX');
  });

  it('un lot visible terminé le jour de l’activation n’est pas un écart', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'start', 'L1');
    await raf(dir, 'done', 'L1');
    await raf(dir, 'ux', 'enable');
    expect((await raf(dir, 'check')).out).not.toContain('revue UX');
  });

  it('ux enable est idempotent et ux exige un verdict', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'ux', 'enable');
    expect((await raf(dir, 'ux', 'enable')).out).toContain('déjà');
    await raf(dir, 'add', 'Écran', '--visible');
    expect((await raf(dir, 'ux', 'L1')).code).toBe(2);
    expect((await raf(dir, 'ux', 'L9', 'ok')).err).toBe('raf: lot inconnu : L9');
  });

  it('un verdict vide ou blanc est refusé et n’ouvre pas la porte', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'ux', 'enable');
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'start', 'L1');
    for (const blank of [[''], ['   '], ['', ' \t']]) {
      const r = await raf(dir, 'ux', 'L1', ...blank);
      expect(r.code).toBe(2);
      expect(r.err).toBe('raf: verdict vide : la revue UX attend son verdict — raf ux L1 "verdict"');
    }
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('ux:');
    expect((await raf(dir, 'done', 'L1')).code).toBe(2);
  });

  it('la revue UX se note sur un lot : une sous-tâche est refusée avec ce message', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--no-hook');
    await raf(dir, 'add', 'Écran', '--visible');
    await raf(dir, 'add', 'partie', '--parent', 'L1');
    const r = await raf(dir, 'ux', 'L1/t1', 'ok');
    expect(r.code).toBe(2);
    expect(r.err).toBe('raf: la revue UX se note sur un lot, pas une sous-tâche');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('ux:');
  });
});
