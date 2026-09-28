import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractRefs, Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

const T = '2026-09-28';

function fresh(): Plan {
  return Plan.create(join(tempDir(), 'docs/plan/raf.yaml'), 'demo');
}

describe('Plan', () => {
  it('numbers lots and sub-tasks sequentially', () => {
    const p = fresh();
    expect(p.add('A', T)).toBe('L1');
    expect(p.add('B', T, { estimate: 2, quickwin: true, after: ['L1'] })).toBe('L2');
    expect(p.addTask('L2', 'sub')).toBe('L2/t1');
    expect(p.addTask('L2', 'sub 2')).toBe('L2/t2');
    p.save();
    const b = Plan.load(p.path).lot('L2');
    expect(b).toMatchObject({ estimate: 2, quickwin: true, after: ['L1'], status: 'todo', created: T });
    expect(b.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('rejects an unknown dependency', () => {
    expect(() => fresh().add('A', T, { after: ['L9'] })).toThrow(/dépendance inconnue/);
  });

  it('dates transitions and keeps the first start date', () => {
    const p = fresh();
    p.add('A', T);
    p.setStatus('L1', 'doing', '2026-09-01');
    p.setStatus('L1', 'done', '2026-09-03');
    expect(p.lot('L1')).toMatchObject({ status: 'done', started: '2026-09-01', finished: '2026-09-03' });
    expect(() => p.setStatus('L1', 'doing', T)).toThrow(/rouvrir/);
  });

  it('done straight from todo sets started too', () => {
    const p = fresh();
    p.add('A', T);
    p.setStatus('L1', 'done', T);
    expect(p.lot('L1')).toMatchObject({ started: T, finished: T });
  });

  it('refuses done while sub-tasks are open unless forced', () => {
    const p = fresh();
    p.add('A', T);
    p.addTask('L1', 'x');
    expect(() => p.setStatus('L1', 'done', T)).toThrow(/L1\/t1/);
    p.setStatus('L1', 'done', T, { force: true });
    expect(p.lot('L1').status).toBe('done');
  });

  it('updates a sub-task status', () => {
    const p = fresh();
    p.add('A', T);
    p.addTask('L1', 'x');
    p.setStatus('L1/t1', 'done', T);
    expect(p.lot('L1').tasks[0].status).toBe('done');
  });

  it('appends dated notes, tagged when aimed at a sub-task', () => {
    const p = fresh();
    p.add('A', T);
    p.addTask('L1', 'x');
    p.note('L1', 'décision : garder le cache', T);
    p.note('L1/t1', 'fait à moitié', T);
    expect(p.lot('L1').notes).toEqual([
      { date: T, text: 'décision : garder le cache' },
      { date: T, text: '[L1/t1] fait à moitié' },
    ]);
  });

  it('preserves hand-written comments across edits', () => {
    const p = fresh();
    p.add('A', T);
    p.save();
    writeFileSync(p.path, readFileSync(p.path, 'utf8').replace('  - id: L1', '  # à garder\n  - id: L1'));
    const q = Plan.load(p.path);
    q.setStatus('L1', 'doing', T);
    q.save();
    expect(readFileSync(p.path, 'utf8')).toContain('# à garder');
    expect(readFileSync(p.path, 'utf8')).toContain('Plan « reste à faire »');
  });

  it('keeps dates as plain strings in the file', () => {
    const p = fresh();
    p.add('A', T);
    p.save();
    expect(readFileSync(p.path, 'utf8')).toContain(`created: ${T}`);
  });
});

describe('extractRefs', () => {
  it('finds whole-word ids and sub-tasks', () => {
    expect(extractRefs('feat(L3): x — voir L12/t2', 'L')).toEqual([{ lot: 'L3' }, { lot: 'L12', task: 't2' }]);
  });
  it('ignores ids glued to other words', () => {
    expect(extractRefs('HTML5 XL3 L3x path/L3', 'L')).toEqual([]);
  });
  it('supports a custom prefix', () => {
    expect(extractRefs('fix R16/t1', 'R')).toEqual([{ lot: 'R16', task: 't1' }]);
  });
});
