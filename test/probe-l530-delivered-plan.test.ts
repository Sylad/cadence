import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourRow } from '../src/lead.js';
import { readPlanConfig } from '../src/config.js';
import { gitRepo } from './helpers.js';

const { deliveriesOf } = (await import(new URL('../plugins/cadence-hud/hooks/deliveries.ts', import.meta.url).href)) as { deliveriesOf: (last: never[], board: unknown, at: number) => { undelivered: string[] }[] };
const { parseLotsBoard } = (await import(new URL('../plugins/cadence-hud/hooks/lots.ts', import.meta.url).href)) as { parseLotsBoard: (stdout: string) => unknown };

const foreign = (fields: string, entries: string): string => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'suivi'));
  writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  path: suivi/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, finished: livre_le${fields} }\n  statuses: { todo: prevu, done: [deploye, valide] }\n`);
  writeFileSync(join(dir, 'suivi/taches.yaml'), `taches:\n${entries}`);
  return dir;
};
const E = (v: string, extra = '') => `  - { id: T1, titre: A, etat: deploye, livre_le: 2026-10-20, deploye_le: ${v}${extra} }\n`;

describe('probe L530 — delivered lu dans plan.fields.delivered', () => {
  it('jour inexistant au calendrier (2026-02-30) : ne livre rien', () => {
    expect(tourRow(foreign(', delivered: deploye_le', E('2026-02-30')), '2026-10-30').closed).toEqual([{ id: 'T1', finished: '2026-10-20' }]);
  });
  it('clé delivered donnée en chaîne simple (pas une liste) : fonctionne', () => {
    expect(tourRow(foreign(', delivered: deploye_le', E('2026-10-21')), '2026-10-30').closed![0]).toHaveProperty('delivered', true);
  });
  it('plusieurs clés : la première qui porte un jour l’emporte, une première vide est sautée', () => {
    const dir = foreign(', delivered: [vide, deploye_le]', E('2026-10-21', ', vide: ""'));
    expect(tourRow(dir, '2026-10-30').closed![0]).toHaveProperty('delivered', true);
  });
  it('clé delivered liste vide : rien n’est livré', () => {
    expect(tourRow(foreign(', delivered: []', E('2026-10-21')), '2026-10-30').closed).toEqual([{ id: 'T1', finished: '2026-10-20' }]);
  });
  it('valeur nombre / null / tableau : ne livre rien, sans planter', () => {
    for (const v of ['12345', 'null', '[2026-10-21]', '{ a: 1 }', '~']) {
      expect(tourRow(foreign(', delivered: deploye_le', E(v)), '2026-10-30').closed, v).toEqual([{ id: 'T1', finished: '2026-10-20' }]);
    }
  });
  it('lot non clos (état prevu) avec jour de livraison : absent de closed', () => {
    const dir = foreign(', delivered: deploye_le', '  - { id: T1, titre: A, etat: prevu, deploye_le: 2026-10-21 }\n');
    expect(tourRow(dir, '2026-10-30').closed).toBeUndefined();
  });
  it('horodatage avec espace (« 2026-10-21 08:00 ») : accepté ou refusé, mais jamais une exception', () => {
    expect(() => tourRow(foreign(', delivered: deploye_le', E('"2026-10-21 08:00"')), '2026-10-30')).not.toThrow();
  });
  it('plan.fields.delivered avec champ inconnu voisin : message d’erreur cite delivered dans les attendus', () => {
    const dir = foreign(', bogus: x', E('2026-10-21'));
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'), dir)).toThrow(/delivered/);
  });
  it('plan.fields.delivered non-liste non-chaîne (objet) : erreur de config, pas une exception brute', () => {
    const dir = foreign(', delivered: { a: 1 }', E('2026-10-21'));
    let err: unknown;
    try { readPlanConfig(join(dir, 'cadence.yaml'), dir); } catch (e) { err = e; }
    expect(err === undefined || (err as Error).constructor.name === 'RafError').toBe(true);
  });
});

describe('probe L530 — panneau HUD', () => {
  const NOW = Date.parse('2026-11-04T10:00:00Z');
  const last = { project: 'p', sha: 'abcdef1234', day: '2026-10-30', status: 'verte', green: '2026-10-30' } as never;
  it('delivered non booléen (« true », 1, objet) est ignoré par parseLotsBoard', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [{ id: 'A', finished: '2026-11-01', delivered: 'true' }, { id: 'B', finished: '2026-11-01', delivered: 1 }, { id: 'C', finished: '2026-11-01', delivered: {} }] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual(['A', 'B', 'C']);
  });
  it('delivered: true sur un lot sans livraison dans les sorties : pas de plantage, closed vide → []', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual([]);
  });
  it('closed doublon (même id deux fois, un livré un non) : l’id non livré reste signalé', () => {
    const b = parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [{ id: 'A', finished: '2026-11-01', delivered: true }, { id: 'A', finished: '2026-11-02' }] }]));
    expect(deliveriesOf([last], b, NOW)[0]!.undelivered).toEqual(['A']);
  });
  it('closed entrée null / non-objet : ignorée sans exception', () => {
    expect(() => parseLotsBoard(JSON.stringify([{ project: 'p', lots: [], closed: [null, 3, 'x', { id: 'A', finished: '2026-11-01', delivered: true }] }]))).not.toThrow();
  });
});
