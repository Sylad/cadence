import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { candidates, drawFilter, nonDrawable } from '../src/orchestrate/continue.js';
import { tempDir } from './helpers.js';

function project(parent: string, name: string, lots: { title: string; estimate?: number; note?: string }[], yaml?: string) {
  const dir = join(parent, name);
  mkdirSync(dir);
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
  for (const l of lots) {
    const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1 });
    if (l.note) plan.note(id, l.note, '2026-10-02');
  }
  plan.save();
  if (yaml) writeFileSync(join(dir, 'cadence.yaml'), yaml);
  return dir;
}
const draw = (parent: string, skipped?: string[]) => candidates(parent, { priority: [], exclude: new Set(), remaining: 1e9, skipped }).map((c) => `${c.project}:${c.lot.id}`);

describe('L390 — réglage de tirage par projet (orchestrate.continue)', () => {
  it('R1 — sans réglage, un gros lot sans spécification est tiré comme avant', () => {
    const parent = tempDir();
    project(parent, 'maritime', [{ title: 'Profils verticaux, coupes (10)', estimate: 3 }]);
    expect(draw(parent)).toEqual(['maritime:L1']);
  });

  it('R2 — continue.maxEstimate : un lot dont l\'estimate dépasse la valeur n\'est pas tiré, un lot égal l\'est', () => {
    const parent = tempDir();
    project(parent, 'maritime', [{ title: 'gros', estimate: 3 }, { title: 'limite', estimate: 1 }, { title: 'petit', estimate: 0.25 }], 'orchestrate:\n  continue:\n    maxEstimate: 1\n');
    expect(draw(parent)).toEqual(['maritime:L2', 'maritime:L3']);
  });

  it('R3 — continue.exclude : les lots listés ne sont pas tirés, les autres le sont', () => {
    const parent = tempDir();
    project(parent, 'maritime', [{ title: 'B6' }, { title: 'autre' }], 'orchestrate:\n  continue:\n    exclude: [L1]\n');
    expect(draw(parent)).toEqual(['maritime:L2']);
  });

  it('R4 — un lot marqué « non tirable » (titre ou note) n\'est jamais tiré', () => {
    const parent = tempDir();
    project(parent, 'a', [{ title: 'X (non tirable)' }, { title: 'Y', note: 'Non tirable par --continue : trop gros' }, { title: 'Z' }]);
    expect(draw(parent)).toEqual(['a:L3']);
    expect(nonDrawable({ title: 'Y', notes: [] })).toBe(false);
    expect(nonDrawable({ title: 'Y', notes: [{ date: '2026-10-01', text: 'NON TIRABLE' }] })).toBe(true);
  });

  it('R5 — le réglage est celui du projet : les autres projets du dossier ne sont pas touchés', () => {
    const parent = tempDir();
    project(parent, 'avec', [{ title: 'gros', estimate: 3 }], 'orchestrate:\n  continue:\n    maxEstimate: 1\n');
    project(parent, 'sans', [{ title: 'gros', estimate: 3 }]);
    expect(draw(parent)).toEqual(['sans:L1']);
  });

  it('R6 — chaque lot écarté par le réglage est rapporté avec sa cause (ce que le dry-run affiche)', () => {
    const parent = tempDir();
    project(parent, 'maritime', [{ title: 'B6', estimate: 3 }, { title: 'C', estimate: 1 }, { title: 'D (non tirable)' }, { title: 'E' }], 'orchestrate:\n  continue:\n    maxEstimate: 2\n    exclude: [L2]\n');
    const skipped: string[] = [];
    expect(draw(parent, skipped)).toEqual(['maritime:L4']);
    expect(skipped).toEqual([
      'maritime:L1 écarté du tirage : estimate 3 > continue.maxEstimate 2',
      'maritime:L2 écarté du tirage : listé dans continue.exclude',
      'maritime:L3 écarté du tirage : marqué « non tirable »',
    ]);
  });

  it('R7 — drawFilter rend null pour un lot tirable, et la cause sinon (exclude avant maxEstimate)', () => {
    const lot = { id: 'L9', title: 't', notes: [], estimate: 5 } as never;
    expect(drawFilter(lot, undefined)).toBeNull();
    expect(drawFilter(lot, { maxEstimate: 5, exclude: [] })).toBeNull();
    expect(drawFilter(lot, { exclude: ['L9'], maxEstimate: 1 })).toMatch(/continue\.exclude/);
  });

  it('R8 — la configuration lit continue.maxEstimate et continue.exclude, et refuse le reste', () => {
    const dir = tempDir();
    const file = join(dir, 'cadence.yaml');
    const read = (y: string) => { writeFileSync(file, y); return readOrchestrateConfig(file); };
    expect(read('orchestrate:\n  test: x\n').continue).toBeUndefined();
    expect(read('orchestrate:\n  continue: { maxEstimate: 0.5, exclude: [L1, " L2 "] }\n').continue).toEqual({ maxEstimate: 0.5, exclude: ['L1', 'L2'] });
    expect(read('orchestrate:\n  continue: { exclude: [L3] }\n').continue).toEqual({ exclude: ['L3'] });
    expect(() => read('orchestrate:\n  continue: { maxEstimate: 0 }\n')).toThrow(/continue\.maxEstimate/);
    expect(() => read('orchestrate:\n  continue: { maxEstimate: gros }\n')).toThrow(/continue\.maxEstimate/);
    expect(() => read('orchestrate:\n  continue: { exclude: L1 }\n')).toThrow(/continue\.exclude/);
    expect(() => read('orchestrate:\n  continue: { exclude: [""] }\n')).toThrow(/continue\.exclude/);
    expect(() => read('orchestrate:\n  continue: { max: 2 }\n')).toThrow(/continue\.max inconnu/);
    expect(() => read('orchestrate:\n  continue: 3\n')).toThrow(/continue doit être un objet/);
  });
});
