import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeArchived } from '../src/archive.js';
import { Plan, type Lot } from '../src/plan.js';
import { fileIds } from './archive-helpers.js';
import { tempDir } from './helpers.js';

// Sonde L536 — les bords de la clé `place:` d'un lot archivé à id libre.
const PATTERN = '[A-Z]{1,3}-?\\d+(?:\\.\\d+)*';
const lot = (id: string) => ({ id }) as unknown as Lot;
const ids = (lots: { id: string }[]) => lots.map((l) => l.id);

function planWith(order: string[], done: Record<string, string>, pattern: string | undefined = PATTERN) {
  const dir = tempDir();
  const file = join(dir, '.cadence/raf.yaml');
  Plan.create(file, 'demo', 'L', '2026-01-01');
  const open = () => Plan.load(file, pattern ? { idPattern: pattern } : {});
  const plan = open();
  for (const id of order) plan.add(`lot ${id}`, '2026-01-01', pattern ? { id } : {});
  for (const [id, day] of Object.entries(done)) plan.setStatus(id, 'done', day, { force: true });
  plan.save();
  return { file, load: open };
}
const archiveFile = (file: string, year: string) => join(dirname(file), 'archive', `${year}.yaml`);

describe('sonde L536 — place: bords', () => {
  it('cycle de rangs (A↔B) et rang sur soi-même : ni boucle ni perte', () => {
    const r = mergeArchived([lot('X1'), lot('X2'), lot('X3')], [lot('AB-1')], new Map([['X1', 'X2'], ['X2', 'X1'], ['X3', 'X3']]));
    expect(ids(r).sort()).toEqual(['AB-1', 'X1', 'X2', 'X3']);
  });

  it('deux lots au même rang restent dans l’ordre d’archivage', () => {
    const r = mergeArchived([lot('X1'), lot('X2')], [lot('AB-1'), lot('L7')], new Map([['X1', 'AB-1'], ['X2', 'AB-1']]));
    expect(ids(r)).toEqual(['AB-1', 'X1', 'X2', 'L7']);
  });

  it('chaîne de rangs écrite à l’envers dans la liste archivée', () => {
    const r = mergeArchived([lot('X2'), lot('X1')], [lot('AB-1'), lot('L7')], new Map([['X1', 'AB-1'], ['X2', 'X1']]));
    expect(ids(r)).toEqual(['AB-1', 'X1', 'X2', 'L7']);
  });

  it('rang vide posé sur deux lots : tête, ordre conservé', () => {
    const r = mergeArchived([lot('X1'), lot('X2')], [lot('AB-1')], new Map([['X1', ''], ['X2', '']]));
    expect(ids(r)).toEqual(['X1', 'X2', 'AB-1']);
  });

  it('premier lot du fichier : place: vide écrit, relu en tête', () => {
    const p = planWith(['X3', 'AB-1'], { X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    expect(readFileSync(archiveFile(p.file, '2026'), 'utf8')).toMatch(/place: (""|'')/);
    expect(ids(p.load().lots())).toEqual(['X3', 'AB-1']);
  });

  it('--dry-run n’écrit ni archive ni place:', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], { X3: '2026-11-02' });
    const before = readFileSync(p.file, 'utf8');
    p.load().archive('2026-11-02', { dryRun: true });
    expect(readFileSync(p.file, 'utf8')).toBe(before);
    expect(existsSync(join(dirname(p.file), 'archive'))).toBe(false);
  });

  it('archiver deux fois : le second passage ne bouge rien', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], { X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    const snap = readFileSync(archiveFile(p.file, '2026'), 'utf8');
    const second = p.load().archive('2026-11-02');
    expect(second.moved).toHaveLength(0);
    expect(readFileSync(archiveFile(p.file, '2026'), 'utf8')).toBe(snap);
    expect(ids(p.load().lots())).toEqual(['X3', 'AB-1', 'L7']);
  });

  it('plan à ids ordinaires <préfixe><n> : aucune clé place: écrite', () => {
    const p = planWith(['L1', 'L2', 'L3'], { L2: '2026-11-02' }, '');
    p.load().archive('2026-11-02');
    expect(readFileSync(archiveFile(p.file, '2026'), 'utf8')).not.toContain('place:');
    expect(ids(p.load().lots())).toEqual(['L1', 'L2', 'L3']);
  });

  it('id libre qui commence par le préfixe (L12-bis) : garde sa place', () => {
    const p = planWith(['L1', 'L12-bis', 'L2'], { 'L12-bis': '2026-11-02' }, '[A-Z]{1,3}-?\\d+(?:-[a-z]+)?');
    p.load().archive('2026-11-02');
    expect(ids(p.load().lots())).toEqual(['L1', 'L12-bis', 'L2']);
  });

  it('rangs sur deux années : le prédécesseur est dans un autre fichier d’année', () => {
    const p = planWith(['AB-1', 'X3', 'L7'], { 'AB-1': '2025-12-01', X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    expect(readdirSync(join(dirname(p.file), 'archive')).sort()).toEqual(['2025.yaml', '2026.yaml']);
    expect(ids(p.load().lots())).toEqual(['AB-1', 'X3', 'L7']);
  });

  it('place: écrit à la main avec un type faux (nombre, liste) : ignoré, aucun lot perdu', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], { X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    const f = archiveFile(p.file, '2026');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/place: (""|'')/, 'place: [1, 2]'));
    expect(ids(p.load().lots()).sort()).toEqual(['AB-1', 'L7', 'X3']);
  });

  it('place: vide (null YAML, `place:` sans valeur) lu comme « en tête »', () => {
    const p = planWith(['X3', 'AB-1', 'L7'], { X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    const f = archiveFile(p.file, '2026');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/place: (""|'')/, 'place:'));
    expect(ids(p.load().lots())).toEqual(['X3', 'AB-1', 'L7']);
  });

  it('prédécesseur archivé dans le même passage et lui-même à id ordinaire', () => {
    const p = planWith(['L5', 'X3', 'L6'], { L5: '2026-11-02', X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    expect(fileIds(p.file)).toEqual(['L6']);
    expect(ids(p.load().lots())).toEqual(['L5', 'X3', 'L6']);
  });

  it('rouvrir le prédécesseur : le lot à rang ne disparaît pas et reste présenté une seule fois', () => {
    const p = planWith(['AB-1', 'X3', 'L7'], { 'AB-1': '2026-11-02', X3: '2026-11-02' });
    p.load().archive('2026-11-02');
    const re = p.load();
    re.putBack('AB-1', '2026-11-04', 'rouvert', () => 0);
    re.save();
    // X3 suivait AB-1 : il garde sa place (en tête) quand AB-1 part en fin de plan.
    expect(ids(p.load().lots())).toEqual(['X3', 'L7', 'AB-1']);
  });

  it('raf archive --before : un lot à id libre sans finished: reste, sans place: écrit', () => {
    const p = planWith(['X3', 'AB-1'], { X3: '2026-11-02' });
    p.load().archive('2026-11-02', { before: '2026-01-01' });
    expect(fileIds(p.file)).toEqual(['X3', 'AB-1']);
  });
});

// L536 (escalade) — `placeRanked` doit tenir à l'échelle d'un plan à ids libres (maritime-atlas : 685 lots) : les lots archivés
// forment une seule chaîne de `place:`, et l'ancien algorithme (un tour par maillon, `out.some` sur tout le plan) coûtait k²·n.
// Mesure sans horloge : les lectures de `.id`, comptées par un accesseur, bornées à un multiple du nombre de lots.
describe('sonde L536 — place: à l’échelle', () => {
  it('1000 lots dont 800 archivés en chaîne : lectures d’id linéaires, ordre du plan conservé', () => {
    let reads = 0;
    const counted = (id: string) => ({ get id() { reads++; return id; } }) as unknown as Lot;
    const order = Array.from({ length: 1000 }, (_, i) => `AB-${i + 1}`);
    const isArchived = (i: number) => i % 5 !== 0;
    const archived = order.filter((_, i) => isArchived(i)).map(counted);
    const active = order.filter((_, i) => !isArchived(i)).map(counted);
    const places = new Map<string, string>(order.flatMap((id, i) => (isArchived(i) ? [[id, order[i - 1] ?? '']] : [])));
    const r = mergeArchived(archived, active, places);
    expect(ids(r)).toEqual(order);
    expect(reads).toBeLessThan(50 * order.length);
  });
});
