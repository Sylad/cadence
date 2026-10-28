import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lotsDuPlanReel, readsRealPlanDirectly } from './plan-reel.js';

const dir = import.meta.dirname;

describe('lecture du plan réel par les tests (L404)', () => {
  it('R1 — lotsDuPlanReel rend les lots archivés comme les actifs (B1 est archivé, L404 est actif)', () => {
    const ids = lotsDuPlanReel().map((l) => l.id);
    expect(ids).toContain('L186');
    expect(ids).toContain('L404');
  });

  it('R2 — le détecteur refuse un test qui lit le vrai .cadence/raf.yaml, et laisse passer les autres', () => {
    expect(readsRealPlanDirectly("parse(readFileSync(join(ROOT, '.cadence', 'raf.yaml'), 'utf8'))")).toBe(true);
    expect(readsRealPlanDirectly("readFileSync(join(root, '.cadence/raf.yaml'), 'utf8')")).toBe(true);
    expect(readsRealPlanDirectly("readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')")).toBe(false); // un dépôt jetable
    expect(readsRealPlanDirectly("readFileSync(join(h.repo, '.cadence/raf.yaml'), 'utf8')")).toBe(false);
    expect(readsRealPlanDirectly("// readFileSync(join(ROOT, '.cadence', 'raf.yaml'))\nlotsDuPlanReel()")).toBe(false);
  });

  it('R3 — aucun test du dépôt ne relit le plan réel sans le chargeur', () => {
    const fautifs = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'plan-reel.ts' && f !== 'plan-reel-garde.test.ts')
      .filter((f) => readsRealPlanDirectly(readFileSync(join(dir, f), 'utf8')));
    expect(fautifs, 'utiliser lotsDuPlanReel (test/plan-reel.ts)').toEqual([]);
  });
});
