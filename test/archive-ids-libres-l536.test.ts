import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeArchived } from '../src/archive.js';
import { readPlanConfig } from '../src/config.js';
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

  it('L536 — un lot à id ordinaire L7 parmi des ids libres garde sa place (le nombre de son id ne décide pas)', () => {
    const a = planWith(['L7', 'AB-1'], ['L7']);
    a.load().archive('2026-11-02');
    expect(ids(a.load().lots())).toEqual(['L7', 'AB-1']);
    const b = planWith(['L5', 'AB-9', 'L7'], ['L7']);
    b.load().archive('2026-11-02');
    expect(ids(b.load().lots())).toEqual(['L5', 'AB-9', 'L7']);
    const c = planWith(['L7', 'X3', 'AB-1'], ['L7', 'X3']);
    c.load().archive('2026-11-02');
    expect(ids(c.load().lots())).toEqual(['L7', 'X3', 'AB-1']);
  });

  it('L536 — deux lots archivés à des passages différents gardent l’ordre du plan, même si le plus tardif est dans un fichier d’année lu avant', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], []);
    // X3 fini en 2027, AB-1 fini en 2026 mais archivé après.
    const first = p.load();
    first.setStatus('X3', 'done', '2027-01-05', { force: true });
    first.save();
    first.archive('2027-01-06');
    const second = p.load();
    second.setStatus('AB-1', 'done', '2026-12-20', { force: true });
    second.save();
    p.load().archive('2027-01-07');
    expect(ids(p.load().lots())).toEqual(['X3', 'AB-1', 'L7']);
  });

  it('L536 — [A1, X3, B2, C4] : un prédécesseur commun ne fait pas passer B2 devant X3', () => {
    const p = planWith(['A1', 'X3', 'B2', 'C4'], []);
    const f = p.load();
    f.setStatus('X3', 'done', '2027-01-05', { force: true });
    f.save();
    f.archive('2027-01-06');
    const g = p.load();
    g.setStatus('B2', 'done', '2026-12-20', { force: true });
    g.save();
    p.load().archive('2027-01-07');
    expect(ids(p.load().lots())).toEqual(['A1', 'X3', 'B2', 'C4']);
  });
  it('L536 — rouvrir un lot archivé ne déplace pas les lots archivés qui le suivaient (seul le rouvert va en fin de plan)', () => {
    const p = planWith(['L1', 'L2', 'L3', 'L4'], ['L2', 'L3']);
    p.load().archive('2026-11-02');
    const re = p.load();
    re.putBack('L2', '2026-11-04', 'rouvert', () => 0);
    re.save();
    // Sans idPattern on lirait L1, L3, L4, L2 : la même chose ici, L3 reste derrière L1.
    expect(ids(p.load().lots())).toEqual(['L1', 'L3', 'L4', 'L2']);
    expect(fileIds(p.file)).toEqual(['L1', 'L4', 'L2']);
    const year = readFileSync(join(dirname(p.file), 'archive', '2026.yaml'), 'utf8');
    expect(year).toMatch(/id: L3[\s\S]*place: L1/);
  });

  it('L536 — rouvrir deux lots qui se suivent : leur successeur archivé suit le prédécesseur resté archivé', () => {
    const p = planWith(['A1', 'X3', 'B2', 'C4', 'D5'], ['X3', 'B2', 'C4']);
    p.load().archive('2026-11-02');
    const re = p.load();
    re.putBack('X3', '2026-11-04', 'rouvert', () => 0);
    re.putBack('B2', '2026-11-04', 'rouvert', () => 0);
    re.save();
    expect(ids(p.load().lots())).toEqual(['A1', 'C4', 'D5', 'X3', 'B2']);
  });

  it('L536 — rouvrir un lot archivé sans place: (archive d’avant idPattern) : son successeur à rang suit le lot qui précédait le rouvert', () => {
    const p = planWith(['L1', 'L2', 'X3', 'L4'], ['L2']);
    const noPattern = Plan.load(p.file, {});
    noPattern.archive('2026-11-02');
    const later = p.load();
    later.setStatus('X3', 'done', '2026-11-03', { force: true });
    later.archive('2026-11-03');
    expect(ids(p.load().lots())).toEqual(['L1', 'L2', 'X3', 'L4']);
    const re = p.load();
    re.putBack('L2', '2026-11-04', 'rouvert', () => 0);
    re.save();
    expect(ids(p.load().lots())).toEqual(['L1', 'X3', 'L4', 'L2']);
  });

  it('L536 — place est une clé de raf (écrite par raf archive, effacée à la réouverture) : plan.extras.place est refusé', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  idPattern: '${PATTERN}'\n  extras:\n    place: {}\n`);
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'))).toThrow(/plan\.extras\.place.*champ de raf/);
  });
});
