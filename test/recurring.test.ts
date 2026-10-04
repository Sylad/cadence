import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { dueLine, dueDays } from '../src/recurring.js';
import { schedule } from '../src/schedule.js';
import { gitRepo, tempDir } from './helpers.js';

function raf(dir: string, today: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: today },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date(`${today}T09:30:00`),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const fresh = () => Plan.create(join(tempDir(), 'docs/plan/raf.yaml'), 'demo');

describe('lot récurrent — modèle', () => {
  it('add --every pose la périodicité ; did pose last et une note', () => {
    const p = fresh();
    p.add('Nettoyer', '2026-09-01', { every: 7 });
    p.save();
    expect(Plan.load(p.path).lot('L1')).toMatchObject({ every: 7, status: 'todo' });
    const q = Plan.load(p.path);
    q.did('L1', '2026-09-10', 'fait');
    q.save();
    const lot = Plan.load(p.path).lot('L1');
    expect(lot.last).toBe('2026-09-10');
    expect(lot.notes.at(-1)).toEqual({ date: '2026-09-10', text: 'fait' });
  });

  it('refuse une périodicité invalide, un lot non récurrent, une sous-tâche', () => {
    const p = fresh();
    expect(() => p.add('A', '2026-09-01', { every: 0 })).toThrow(/périodicité/);
    expect(() => p.add('A', '2026-09-01', { every: 1.5 })).toThrow(/périodicité/);
    p.add('B', '2026-09-01');
    p.add('C', '2026-09-01', { every: 3 });
    p.addTask('L2', 's');
    expect(() => p.did('L1', '2026-09-02')).toThrow(/pas récurrent/);
    expect(() => p.did('L2/t1', '2026-09-02')).toThrow(/sous-tâche/);
  });

  it('ignore un every illisible écrit à la main et signale un last mal formé', () => {
    const p = fresh();
    p.add('A', '2026-09-01');
    p.save();
    writeFileSync(p.path, readFileSync(p.path, 'utf8').replace('title: A', 'title: A\n    every: soon\n    last: hier'));
    const lot = Plan.load(p.path).lot('L1');
    expect(lot.every).toBeUndefined();
    expect(lot.problems.join()).toMatch(/last/);
  });
});

describe('échéance', () => {
  const base = { id: 'L1', title: 'x', status: 'todo' as const, every: 7, created: '2026-09-01', notes: [] };
  it('part de last, sinon created ; compte le retard en jours', () => {
    expect(dueDays({ ...base, last: '2026-09-10' } as never, '2026-09-20')).toBe(3);
    expect(dueDays(base as never, '2026-09-08')).toBe(0);
    expect(dueDays(base as never, '2026-09-05')).toBe(-3);
  });
  it('formule le message', () => {
    expect(dueLine({ ...base, last: '2026-09-10' } as never, '2026-09-20')).toBe('dû depuis 3 j');
    expect(dueLine(base as never, '2026-09-08')).toBe('dû aujourd\'hui');
    expect(dueLine(base as never, '2026-09-05')).toBe('prochain dans 3 j');
  });
});

describe('raf — lots récurrents', () => {
  it('raf now liste « Récurrent » avec le retard et les sort de « À suivre »', () => {
    const dir = gitRepo();
    raf(dir, '2026-09-01', 'init', '--project', 'demo');
    raf(dir, '2026-09-01', 'add', 'Nettoyer', '--every', '7');
    raf(dir, '2026-09-01', 'add', 'Un lot');
    const now = raf(dir, '2026-09-11', 'now').out;
    expect(now).toMatch(/Récurrent\n\s+L1\s+Nettoyer.*dû depuis 3 j/);
    const suivre = now.split('À suivre')[1].split('Récurrent')[0];
    expect(suivre).toContain('L2');
    expect(suivre).not.toContain('L1');
  });

  it('raf did remet le compteur à zéro ; refus d\'un lot non récurrent', () => {
    const dir = gitRepo();
    raf(dir, '2026-09-01', 'init', '--project', 'demo');
    raf(dir, '2026-09-01', 'add', 'Nettoyer', '--every', '7');
    raf(dir, '2026-09-01', 'add', 'Un lot');
    expect(raf(dir, '2026-09-11', 'did', 'L1', 'passé').code).toBe(0);
    expect(raf(dir, '2026-09-12', 'now').out).toMatch(/L1.*prochain dans 6 j/);
    expect(raf(dir, '2026-09-12', 'did', 'L2').code).toBe(2);
    expect(raf(dir, '2026-09-12', 'add', 'x', '--every', 'abc').code).toBe(2);
  });

  it('raf done met fin à la récurrence ; plus listé', () => {
    const dir = gitRepo();
    raf(dir, '2026-09-01', 'init', '--project', 'demo');
    raf(dir, '2026-09-01', 'add', 'N', '--every', '7');
    raf(dir, '2026-09-02', 'done', 'L1');
    expect(raf(dir, '2026-09-20', 'now').out).not.toContain('Récurrent');
  });

  it('session start liste le lot récurrent avec son retard, hors des propositions', () => {
    const dir = gitRepo();
    raf(dir, '2026-09-01', 'init', '--project', 'demo');
    raf(dir, '2026-09-01', 'add', 'Nettoyer', '--every', '7');
    const out = raf(dir, '2026-09-11', 'session', 'start', '--since', '2026-09-01').out;
    expect(out).toMatch(/Récurrent[\s\S]*L1\s+Nettoyer — dû depuis 3 j/);
    expect(out.split('Propositions')[1] ?? '').not.toContain('L1');
  });

  it('le planning ne place pas les lots récurrents dans la file', () => {
    const p = fresh();
    p.add('N', '2026-09-01', { every: 7 });
    p.add('B', '2026-09-01');
    const bars = schedule(p.lots(), new Map(), '2026-09-08');
    expect(bars.map((b) => b.lot.id)).toEqual(['L2']);
  });
});
