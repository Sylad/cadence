import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from '../src/plan.js';
import { Plan } from '../src/plan.js';
import { candidates, decisionPending, parsePriority, parseUntil, priorityRank, readPriority, stopReason } from '../src/orchestrate/continue.js';
import { tempDir } from './helpers.js';

function project(parent: string, name: string, lots: { title: string; estimate?: number; after?: string[]; doing?: boolean; note?: string }[]) {
  const dir = join(parent, name);
  mkdirSync(dir);
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
  for (const l of lots) {
    const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, after: l.after });
    if (l.doing) plan.setStatus(id, 'doing', '2026-10-01');
    if (l.note) plan.note(id, l.note, '2026-10-02');
  }
  plan.save();
  return dir;
}

describe('--until', () => {
  const now = new Date('2026-10-09T15:40:00');
  it('HH:MM lu comme une heure d\'aujourd\'hui', () => {
    expect(parseUntil('18:00', now).getTime()).toBe(new Date('2026-10-09T18:00:00').getTime());
    expect(parseUntil('9:05', new Date('2026-10-09T07:00:00')).getHours()).toBe(9);
  });
  it('heure invalide ou déjà passée : refus', () => {
    expect(() => parseUntil('25:00', now)).toThrow(RafError);
    expect(() => parseUntil('18h', now)).toThrow(/--until/);
    expect(() => parseUntil('15:40', now)).toThrow(/déjà passée/);
  });
});

describe('priorité', () => {
  it('--priority : liste séparée par des virgules', () => {
    expect(parsePriority('cadence, maritime')).toEqual(['cadence', 'maritime']);
    expect(() => parsePriority(' , ')).toThrow(RafError);
  });
  it('lue dans le cadence.yaml du dossier parent (clé priority)', () => {
    const parent = tempDir();
    expect(readPriority(parent)).toEqual([]);
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: [cadence, maritime]\n');
    expect(readPriority(parent)).toEqual(['cadence', 'maritime']);
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: 3\n');
    expect(() => readPriority(parent)).toThrow(/priority/);
  });
  it('le rang : nom exact ou préfixe « nom- » ; les autres après, dans l\'ordre alphabétique', () => {
    const p = ['cadence', 'maritime'];
    expect(priorityRank('cadence', p)).toBe(0);
    expect(priorityRank('maritime-atlas', p)).toBe(1);
    expect(priorityRank('maritimeX', p)).toBe(2);
    expect(priorityRank('ol-companion', p)).toBe(2);
  });
});

describe('lots à décider', () => {
  it('« à décider avec » dans le titre ou une note exclut le lot', () => {
    const lot = (title: string, notes: string[] = []) => ({ title, notes: notes.map((text) => ({ date: '2026-10-01', text })) }) as never;
    expect(decisionPending(lot('X à décider avec Sylvain'))).toBe(true);
    expect(decisionPending(lot('X', ['À décider avec Sylvain avant']))).toBe(true);
    expect(decisionPending(lot('X décidé'))).toBe(false);
  });
  it('« (à décider) » en fin de titre, ou « À décider » sans « avec », exclut aussi le lot (insensible à la casse)', () => {
    const lot = (title: string, notes: string[] = []) => ({ title, notes: notes.map((text) => ({ date: '2026-10-01', text })) }) as never;
    expect(decisionPending(lot('Choisir la base (à décider)'))).toBe(true);
    expect(decisionPending(lot('X', ['À DÉCIDER par Sylvain']))).toBe(true);
    expect(decisionPending(lot('Décider de la base'))).toBe(false);
  });
});

describe('candidats', () => {
  it('prêts seulement, dans l\'ordre de priorité, sans les lots à décider, ceux de la vague ni ceux hors budget', () => {
    const parent = tempDir();
    project(parent, 'ol', [{ title: 'ol un' }]);
    project(parent, 'maritime-atlas', [{ title: 'm un' }, { title: 'm deux à décider avec Sylvain' }, { title: 'm trois', after: ['L1'] }]);
    project(parent, 'cadence', [{ title: 'c un', doing: true }, { title: 'c deux' }, { title: 'c gros', estimate: 5 }]);
    const found = candidates(parent, { priority: ['cadence', 'maritime'], exclude: new Set(['maritime-atlas:L1']), remaining: 1_000_000 });
    expect(found.map((c) => `${c.project}:${c.lot.id}`)).toEqual(['cadence:L2', 'ol:L1']);
  });
  it('un dossier de projet : lui seul', () => {
    const parent = tempDir();
    const dir = project(parent, 'cadence', [{ title: 'a' }, { title: 'b' }]);
    project(parent, 'ol', [{ title: 'c' }]);
    expect(candidates(dir, { priority: [], exclude: new Set(), remaining: 1e9 }).map((c) => c.lot.id)).toEqual(['L1', 'L2']);
  });
});

describe('arrêt', () => {
  const base = { now: new Date('2026-10-09T10:00:00'), quotaHit: false, questions: 0, streak: 0, interrupted: false, remaining: 1_000_000 };
  it('rien à dire tant qu\'aucune condition ne joue', () => {
    expect(stopReason(base)).toBeNull();
  });
  it.each([
    [{ until: new Date('2026-10-09T10:00:00') }, /fenêtre/],
    [{ remaining: 0 }, /budget/],
    [{ quotaHit: true }, /limite d'usage/],
    [{ questions: 1 }, /question/],
    [{ streak: 2 }, /deux lots rendus/],
    [{ interrupted: true }, /interrompue/],
    [{ stopRequested: true }, /arrêt demandé \(--stop-after-current\)/],
    [{ stopRequested: true, interrupted: true }, /arrêt demandé/], // la cause est la demande, pas « incident ou signal »
  ])('%j', (over, re) => {
    expect(stopReason({ ...base, ...over })).toMatch(re);
  });
});
