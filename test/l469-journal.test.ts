import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendDelivery, lastDelivery, lastDeliveryFor, readDeliveries, readDeliveryLines } from '../src/state.js';
import { tempDir } from './helpers.js';

const journal = (...lines: string[]) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'deliveries.log'), lines.length ? `${lines.join('\n')}\n` : '');
  return dir;
};
const BLOCKS = ['api', 'web'];

describe('R22 — 3e champ optionnel : le bloc', () => {
  it('R22 — --block api écrit « jour sha api », sans --block « jour sha »', () => {
    const dir = tempDir();
    appendDelivery(dir, '2026-10-01', 'aaa', 'api');
    appendDelivery(dir, '2026-10-02', 'bbb');
    expect(readFileSync(join(dir, 'deliveries.log'), 'utf8')).toBe('2026-10-01 aaa api\n2026-10-02 bbb\n');
  });
  it('R22 — ligne ancienne à 2 champs : vaut pour tous les blocs', () => {
    const dir = journal('2026-10-01 aaa');
    expect(lastDeliveryFor(dir, 'api', BLOCKS)).toBe('aaa');
    expect(lastDeliveryFor(dir, 'web', BLOCKS)).toBe('aaa');
  });
  it('R22 — plage de api ignore la ligne d\'un autre bloc', () => {
    const dir = journal('2026-10-01 s0', '2026-10-02 s1 web');
    expect(lastDeliveryFor(dir, 'api', BLOCKS)).toBe('s0');
  });
  it('R22 — lastDeliveryFor(web) après une ligne api : rend la dernière ligne valant pour web, pas celle d\'api', () => {
    const dir = journal('2026-10-01 s0', '2026-10-02 s1 api');
    expect(lastDeliveryFor(dir, 'web', BLOCKS)).toBe('s0');
    expect(lastDeliveryFor(dir, 'api', BLOCKS)).toBe('s1');
  });
  it('R22 — un bloc jamais livré dans un journal de lignes d\'autres blocs : null', () => {
    expect(lastDeliveryFor(journal('2026-10-02 s1 api'), 'web', BLOCKS)).toBeNull();
  });
});

describe('R30 — les lecteurs ignorent le 3e champ', () => {
  it('R30 — lastDelivery lit le sha d\'une ligne à 3 champs', () => {
    expect(lastDelivery(journal('2026-10-01 aaa api'))).toBe('aaa');
  });
  it('R30 — readDeliveries lit le jour d\'une ligne à 3 champs', () => {
    expect(readDeliveries(journal('2026-10-01 aaa api'))).toEqual(['2026-10-01']);
  });
  it('R30 — journal mêlant lignes à 2 et 3 champs : jours et dernier sha corrects', () => {
    const dir = journal('2026-10-01 aaa', '2026-10-02 bbb web', '2026-10-03 ccc');
    expect(readDeliveries(dir)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(lastDelivery(dir)).toBe('ccc');
    expect(readDeliveryLines(dir).map((l) => l.block)).toEqual([undefined, 'web', undefined]);
  });
});

describe('R33 — livraison sans --block : plus ancienne des dernières lignes valant pour chaque bloc', () => {
  it('R33 — « j S1 api » après « j S0 » : part de S0 (celle qui valait pour web)', () => {
    expect(lastDeliveryFor(journal('2026-10-01 s0', '2026-10-02 s1 api'), undefined, BLOCKS)).toBe('s0');
  });
  it('R33 — api puis web : part de la ligne api (la plus ancienne des dernières)', () => {
    expect(lastDeliveryFor(journal('2026-10-01 s0', '2026-10-02 s1 api', '2026-10-03 s2 web'), undefined, BLOCKS)).toBe('s1');
  });
  it('R33 — journal sans ligne de bloc : plage depuis la dernière ligne, comme avant', () => {
    expect(lastDeliveryFor(journal('2026-10-01 s0', '2026-10-02 s1'), undefined, BLOCKS)).toBe('s1');
  });
  it('R33 — sans deliver.blocks : la dernière ligne, quel que soit son bloc', () => {
    expect(lastDeliveryFor(journal('2026-10-01 s0', '2026-10-02 s1 api'))).toBe('s1');
  });
  it('R33 — ligne d\'un bloc non déclaré : ignorée', () => {
    expect(lastDeliveryFor(journal('2026-10-01 s0', '2026-10-02 s1 ancien'), undefined, BLOCKS)).toBe('s0');
  });
});

describe('R34 — journal sans bloc : même sha qu\'avant', () => {
  it('R34 — absent ou vide : null comme lastDelivery', () => {
    expect(lastDeliveryFor(tempDir(), undefined, BLOCKS)).toBeNull();
    expect(lastDeliveryFor(journal(), 'api', BLOCKS)).toBeNull();
  });
  it('R34 — journal sans bloc : lastDeliveryFor rend le sha de lastDelivery', () => {
    const dir = journal('2026-10-01 s0', '2026-10-02 s1');
    expect(lastDeliveryFor(dir)).toBe(lastDelivery(dir));
    expect(lastDeliveryFor(dir, 'api', BLOCKS)).toBe(lastDelivery(dir));
  });
});
