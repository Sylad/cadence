import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeArchived } from '../src/archive.js';
import { Plan, type Lot } from '../src/plan.js';
import { fileIds } from './archive-helpers.js';
import { tempDir } from './helpers.js';

// L536 — plan.idPattern : un lot archivé garde sa place dans l'ordre du plan, même quand son id n'est pas <préfixe><n>.
const PATTERN = '[A-Z]{1,3}-?\\d+(?:\\.\\d+)*';
const lot = (id: string) => ({ id }) as unknown as Lot;
const ids = (lots: { id: string }[]) => lots.map((l) => l.id);

/** Un plan à ids libres, dans l'ordre donné ; `done` : ceux qui sont terminés. */
function planWith(order: string[], done: string[], today = '2026-11-02') {
  const dir = tempDir();
  const file = join(dir, '.cadence/raf.yaml');
  Plan.create(file, 'demo', 'L', '2026-01-01');
  const plan = Plan.load(file, { idPattern: PATTERN });
  for (const id of order) plan.add(`lot ${id}`, '2026-01-01', { id });
  for (const id of done) plan.setStatus(id, 'done', today, { force: true });
  plan.save();
  return { file, load: () => Plan.load(file, { idPattern: PATTERN }) };
}

describe('L536 — raf archive garde l’ordre d’un plan à ids libres', () => {
  it('L536 — X3, AB-1, L7 : archiver X3 le laisse en tête (le nombre final de l’id ne décide pas)', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], ['X3']);
    const before = ids(p.load().lots());
    expect(before).toEqual(['X3', 'AB-1', 'L7']);
    p.load().archive('2026-11-02');
    expect(fileIds(p.file)).toEqual(['AB-1', 'L7']);
    expect(ids(p.load().lots())).toEqual(before);
  });

  it('L536 — un lot du milieu, deux lots consécutifs archivés d’un coup, puis le prédécesseur archivé plus tard', () => {
    const p = planWith(['AB-1', 'X3', 'Y2', 'L7', 'AB-9'], ['X3', 'Y2']);
    const before = ids(p.load().lots());
    p.load().archive('2026-11-02');
    expect(ids(p.load().lots())).toEqual(before);
    const again = p.load();
    again.setStatus('AB-1', 'done', '2026-11-03', { force: true });
    again.archive('2026-11-03');
    expect(fileIds(p.file)).toEqual(['L7', 'AB-9']);
    expect(ids(p.load().lots())).toEqual(before);
  });

  it('L536 — un lot rouvert revient à la fin du plan sans traîner son rang', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], ['X3']);
    p.load().archive('2026-11-02');
    const reopened = p.load();
    reopened.putBack('X3', '2026-11-04', 'rouvert', () => 0);
    reopened.save();
    expect(ids(p.load().lots())).toEqual(['AB-1', 'L7', 'X3']);
    expect(fileIds(p.file).includes('X3')).toBe(true);
    expect(readFileSync(p.file, 'utf8')).not.toContain('place:');
  });

  it('L536 — mergeArchived : rang absent (archive d’avant) → numéro ; rang vide → en tête ; rang inconnu → à la fin', () => {
    expect(ids(mergeArchived([lot('L1')], [lot('L2')], new Map()))).toEqual(['L1', 'L2']);
    expect(ids(mergeArchived([lot('X9')], [lot('AB-1'), lot('L7')], new Map([['X9', '']])))).toEqual(['X9', 'AB-1', 'L7']);
    expect(ids(mergeArchived([lot('X9')], [lot('AB-1'), lot('L7')], new Map([['X9', 'ZZ-0']])))).toEqual(['AB-1', 'L7', 'X9']);
  });
});
