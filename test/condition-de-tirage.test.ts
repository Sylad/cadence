import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateProgress, nextUp } from '../src/audit.js';
import { audit } from '../src/audit.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

type L = { id: string; status?: string; spec?: boolean; screen?: string; visible?: boolean; after?: string[]; gate?: unknown; every?: number };

/** Plan écrit à la main (le champ gate n'a pas d'option de raf add) puis relu. */
function planOf(lots: L[]): Plan {
  const dir = tempDir();
  const path = join(dir, 'raf.yaml');
  const body = lots
    .map((l) => {
      const f = [`  - id: ${l.id}`, `    title: Lot ${l.id}`, `    status: ${l.status ?? 'todo'}`];
      if (l.spec) f.push('    spec: true');
      if (l.screen) f.push('    visible: true', `    screen: ${l.screen}`);
      if (l.after) f.push(`    after: [${l.after.join(', ')}]`);
      if (l.every) f.push(`    every: ${l.every}`);
      if (l.gate !== undefined) f.push(`    gate: ${JSON.stringify(l.gate)}`);
      return f.join('\n');
    })
    .join('\n');
  writeFileSync(path, `project: demo\nprefix: L\nlots:\n${body}\n`);
  return Plan.load(path);
}

const specs = (n: number, status = 'done'): L[] => Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, status, spec: true }));

describe('condition de tirage — compte (L219)', () => {
  it('R1 — 2 lots done spec: true sur 8 : compte 2, condition non remplie', () => {
    const lots = [...specs(2), ...Array.from({ length: 6 }, (_, i) => ({ id: `X${i}`, status: 'done' })), { id: 'G', gate: { count: 8, spec: true } }];
    const plan = planOf(lots);
    const g = gateProgress(plan.lots(), plan.lots().find((l) => l.id === 'G')!);
    expect(g).toMatchObject({ count: 2, n: 8, label: 'spec: true', met: false });
  });

  it('R1 — un lot spec: true doing ou dropped ne compte pas', () => {
    const plan = planOf([...specs(1), { id: 'D', status: 'doing', spec: true }, { id: 'P', status: 'dropped', spec: true }, { id: 'T', spec: true }, { id: 'G', gate: { count: 2, spec: true } }]);
    expect(gateProgress(plan.lots(), plan.lots().find((l) => l.id === 'G')!)).toMatchObject({ count: 1, met: false });
  });

  it('R1 — critère screen: page ne compte pas un lot screen: component done', () => {
    const plan = planOf([{ id: 'A', status: 'done', screen: 'page' }, { id: 'B', status: 'done', screen: 'component' }, { id: 'G', gate: { count: 2, screen: 'page' } }]);
    expect(gateProgress(plan.lots(), plan.lots().find((l) => l.id === 'G')!)).toMatchObject({ count: 1, n: 2, label: 'screen: page', met: false });
  });

  it('R1 — un lot récurrent done spec: true est compté (le compte porte sur tous les lots du plan)', () => {
    const plan = planOf([{ id: 'R', status: 'done', spec: true, every: 7 }, { id: 'G', gate: { count: 1, spec: true } }]);
    expect(gateProgress(plan.lots(), plan.lots().find((l) => l.id === 'G')!)).toMatchObject({ count: 1, met: true });
  });

  it('R3 — compte 8 sur 8 : le lot est prêt', () => {
    const plan = planOf([...specs(8), { id: 'G', gate: { count: 8, spec: true } }]);
    const { ready, blocked } = nextUp(plan.lots());
    expect(ready.map((l) => l.id)).toEqual(['G']);
    expect(blocked).toEqual([]);
  });
});

describe('condition de tirage — nextUp (L219)', () => {
  it('R2 — nextUp : le lot est dans blocked et absent de ready', () => {
    const plan = planOf([...specs(2), { id: 'G', gate: { count: 8, spec: true } }, { id: 'N' }]);
    const { ready, blocked } = nextUp(plan.lots());
    expect(blocked.map((l) => l.id)).toEqual(['G']);
    expect(ready.map((l) => l.id)).toEqual(['N']);
  });

  it('R4 — after levé mais condition non remplie : lot en attente', () => {
    const plan = planOf([{ id: 'A', status: 'done' }, { id: 'G', after: ['A'], gate: { count: 1, spec: true } }]);
    expect(nextUp(plan.lots()).blocked.map((l) => l.id)).toEqual(['G']);
  });

  it('R4 — condition remplie mais after ouvert : lot en attente', () => {
    const plan = planOf([...specs(1), { id: 'A' }, { id: 'G', after: ['A'], gate: { count: 1, spec: true } }]);
    const { ready, blocked } = nextUp(plan.lots());
    expect(blocked.map((l) => l.id)).toEqual(['G']);
    expect(ready.map((l) => l.id)).toEqual(['A']);
  });

  it('R5 — plan sans gate : nextUp identique à la sortie d\'avant', () => {
    const plan = planOf([{ id: 'A', status: 'doing' }, { id: 'B' }, { id: 'C', after: ['B'] }, { id: 'D', status: 'done' }]);
    const { doing, ready, blocked } = nextUp(plan.lots());
    expect([doing, ready, blocked].map((x) => x.map((l) => l.id))).toEqual([['A'], ['B'], ['C']]);
    expect(gateProgress(plan.lots(), plan.lots()[1]!)).toBeUndefined();
  });
});

describe('condition de tirage — gate mal formé (L219)', () => {
  const bad: [string, unknown][] = [
    ['count: 0', { count: 0, spec: true }],
    ['count « huit »', { count: 'huit', spec: true }],
    ['count absent', { spec: true }],
    ['non objet', 'beaucoup'],
    ['critère absent', { count: 2 }],
    ['critère double', { count: 2, spec: true, screen: 'page' }],
  ];
  it.each(bad)('R7 — %s : problème signalé par raf check', (_n, gate) => {
    const plan = planOf([{ id: 'G', gate }]);
    expect(plan.lots()[0]!.problems.join()).toContain('gate invalide');
    const msgs = audit(plan, tempDir(), tempDir(), '2026-10-15').map((i) => i.message);
    expect(msgs).toContain('G : gate invalide : count: entier ≥ 1 et un critère spec: true ou screen: page attendus');
  });

  it.each([['spec: false', { count: 1, spec: false }], ['screen: component', { count: 1, screen: 'component' }]])('R7 — critère inconnu (%s) : lot non tirable', (_n, gate) => {
    const plan = planOf([...specs(5), { id: 'G', gate }]);
    const { ready, blocked } = nextUp(plan.lots());
    expect(ready).toEqual([]);
    expect(blocked.map((l) => l.id)).toEqual(['G']);
  });

  it('R5 — plan sans gate : raf check sans nouveau problème', () => {
    const plan = planOf([{ id: 'A' }, { id: 'B', status: 'done', spec: true }]);
    expect(audit(plan, tempDir(), tempDir(), '2026-10-15').filter((i) => i.message.includes('gate'))).toEqual([]);
  });
});
