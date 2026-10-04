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

describe('Plan — titre public', () => {
  it('écrit le titre public à add, juste après title, et le relit', () => {
    const p = fresh();
    p.add('Titre technique', T, { visible: true, public: 'Une page Nouveautés' });
    p.save();
    const yaml = readFileSync(p.path, 'utf8');
    expect(yaml).toMatch(/title: Titre technique\n\s+public: Une page Nouveautés\n\s+status: todo/);
    expect(Plan.load(p.path).lot('L1').public).toBe('Une page Nouveautés');
  });

  it('setPublic pose, remplace puis efface le titre public, sans toucher au reste', () => {
    const p = fresh();
    p.add('A', T);
    p.setPublic('L1', 'Premier', );
    p.save();
    expect(Plan.load(p.path).lot('L1').public).toBe('Premier');
    const q = Plan.load(p.path);
    q.setPublic('L1', 'Second: avec deux-points');
    q.save();
    expect(Plan.load(p.path).lot('L1').public).toBe('Second: avec deux-points');
    const r = Plan.load(p.path);
    r.setPublic('L1', null);
    r.save();
    expect(Plan.load(p.path).lot('L1').public).toBeUndefined();
    expect(readFileSync(p.path, 'utf8')).not.toContain('public');
  });

  it('setPublic insère la clé juste après title et laisse le reste du lot, et les autres lots, inchangés', () => {
    const p = fresh();
    p.add('A', T, { estimate: 2, quickwin: true });
    p.add('B', T);
    p.addTask('L1', 'sub');
    p.save();
    const avant = readFileSync(p.path, 'utf8');
    const q = Plan.load(p.path);
    q.setPublic('L1', 'Public A');
    q.save();
    const apres = readFileSync(p.path, 'utf8');
    expect(apres).toMatch(/title: A\n\s+public: Public A\n\s+status: todo/);
    expect(apres.replace(/\n\s+public: Public A/, '')).toBe(avant);
    expect(Plan.load(p.path).lot('L2')).not.toHaveProperty('public');
  });

  it('refuse un lot inconnu, une sous-tâche et un titre vide', () => {
    const p = fresh();
    p.add('A', T);
    p.addTask('L1', 's');
    expect(() => p.setPublic('L9', 'x')).toThrow(/lot inconnu/);
    expect(() => p.setPublic('L1/t1', 'x')).toThrow(/sous-tâche/);
    expect(() => p.setPublic('L1', '   ')).toThrow(/vide/);
  });

  it('lit un titre public écrit à la main', () => {
    const p = fresh();
    p.add('A', T);
    p.save();
    writeFileSync(p.path, readFileSync(p.path, 'utf8').replace('title: A', 'title: A\n    public: "Écrit à la main"'));
    expect(Plan.load(p.path).lot('L1').public).toBe('Écrit à la main');
  });
});

describe('extractRefs', () => {
  it('finds whole-word ids and sub-tasks', () => {
    expect(extractRefs('feat(L3): x — voir L12/t2', 'L')).toEqual([{ lot: 'L3' }, { lot: 'L12', task: 't2' }]);
  });
  it('ignores ids glued to other words', () => {
    expect(extractRefs('HTML5 XL3 L3x path/L3', 'L')).toEqual([]);
  });
  it('does not take « L1.4 » for lot L1 — same right guard as the ids of a read-only plan', () => {
    expect(extractRefs('feat(L1.4): x', 'L')).toEqual([]);
    expect(extractRefs('feat(L1.4): x — suite de L12.3 et de L2.b', 'L')).toEqual([]);
    expect(extractRefs('voir L1.4/t1', 'L')).toEqual([]);
  });
  it('still reads an id that ends a sentence, or sits before punctuation', () => {
    expect(extractRefs('fin de L1. Suite : L2, L3; (L4) L5/t2. L6.', 'L')).toEqual([
      { lot: 'L1' },
      { lot: 'L2' },
      { lot: 'L3' },
      { lot: 'L4' },
      { lot: 'L5', task: 't2' },
      { lot: 'L6' },
    ]);
  });
  it('supports a custom prefix', () => {
    expect(extractRefs('fix R16/t1', 'R')).toEqual([{ lot: 'R16', task: 't1' }]);
  });
});
