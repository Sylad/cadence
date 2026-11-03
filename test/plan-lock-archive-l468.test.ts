import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Plan } from '../src/plan.js';
import { repoWithPlan } from './archive-helpers.js';

// L468 (M6) — le refus « plan modifié depuis sa lecture » vaut aussi pour les fichiers d'année que save() réécrit.
describe('R2 — un fichier d\'année changé par une autre session depuis sa lecture n\'est pas écrasé', () => {
  it('R2 — deux sessions notent deux lots archivés de la même année : la seconde écriture est refusée, la note de la première gardée', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const s1 = Plan.load(r.plan);
    const s2 = Plan.load(r.plan);
    s1.note('L2', 'note de la session 1', '2026-10-28');
    s2.note('L3', 'note de la session 2', '2026-10-28');
    s1.save();
    expect(() => s2.save()).toThrow(/modifié par une autre session depuis sa lecture/);
    const year = readFileSync(r.archive('2026'), 'utf8');
    expect(year).toContain('note de la session 1');
    expect(year).not.toContain('note de la session 2');
  });

  it('R2 — un fichier d\'année créé par une autre session pendant ce temps n\'est pas écrasé non plus', async () => {
    const r = repoWithPlan();
    const s1 = Plan.load(r.plan);
    s1.lots(); // lit les fichiers d'année : aucun encore
    mkdirSync(dirname(r.archive('2026')), { recursive: true });
    writeFileSync(r.archive('2026'), 'version: 1\nlots: []\n# posé ailleurs\n');
    expect(() => s1.archive('2026-10-28')).toThrow(/modifié par une autre session depuis sa lecture/);
    expect(readFileSync(r.archive('2026'), 'utf8')).toContain('posé ailleurs');
    expect(existsSync(r.archive('2025'))).toBe(false);
  });

  it('R2 — la même session écrit deux fois de suite sans être refusée', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const s = Plan.load(r.plan);
    s.note('L2', 'une', '2026-10-28');
    s.save();
    s.note('L2', 'deux', '2026-10-28');
    s.save();
    expect(readFileSync(r.archive('2026'), 'utf8')).toContain('deux');
  });

  it('R2 — plan.onWrite en échec : la session peut réécrire ensuite, son fichier d\'année étant revenu tel qu\'avant', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const s = Plan.load(r.plan, { onWrite: { command: 'test -e ' + r.dir + '/ok', files: [], cwd: r.dir } });
    s.note('L2', 'une', '2026-10-28');
    expect(() => s.save()).toThrow(/plan\.onWrite en échec/);
    expect(readFileSync(r.archive('2026'), 'utf8')).not.toContain('une');
    writeFileSync(r.dir + '/ok', '');
    s.save();
    expect(readFileSync(r.archive('2026'), 'utf8')).toContain('une');
  });
});
