import { describe, expect, it } from 'vitest';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { harness } from './orchestrate-harness.js';

/** L620 — une intégration déposée passe avant les lots en file : bords du placement. */
function setup() {
  const hs = [harness(), harness(), harness(), harness()];
  const wave = hs[0].wave;
  const mk = (i: number, project: string, next?: 'integrate'): LotCtx => {
    const c: LotCtx = { ...hs[i].lot('L1'), wave };
    c.lot.project = project;
    if (next) c.lot.next = next;
    return c;
  };
  return { mk };
}

describe('L620 — intégration déposée devant la file', () => {
  it('deux intégrations prises au même tour gardent leur ordre de prise, devant la file', async () => {
    const { mk } = setup();
    const queued = [mk(0, 'q1'), mk(1, 'q2')];
    const i1 = mk(2, 'i1', 'integrate');
    const i2 = mk(3, 'i2', 'integrate');
    let given = false;
    const settled: LotCtx[] = [];
    await runPool(queued, 1, [], (c) => settled.push(c), () => false, { pollMs: 5, take: () => (given ? [] : ((given = true), [i1, i2])) });
    expect(settled.slice(0, 2)).toEqual([i1, i2]);
    expect(settled).toHaveLength(4);
  });

  it("une intégration prise avec une réponse passe devant, la réponse reste derrière la file", async () => {
    const { mk } = setup();
    const queued = [mk(0, 'q1')];
    const answer = mk(1, 'ans');
    const integ = mk(2, 'integ', 'integrate');
    let given = false;
    const settled: LotCtx[] = [];
    await runPool(queued, 1, [], (c) => settled.push(c), () => false, { pollMs: 5, take: () => (given ? [] : ((given = true), [answer, integ])) });
    expect(settled[0]).toBe(integ);
    expect(settled.indexOf(answer)).toBeGreaterThan(settled.indexOf(queued[0]));
  });

  it('un take vide ne change rien : ordre de la file conservé', async () => {
    const { mk } = setup();
    const queued = [mk(0, 'q1'), mk(1, 'q2')];
    const settled: LotCtx[] = [];
    await runPool(queued, 1, [], (c) => settled.push(c), () => false, { pollMs: 5, take: () => [] });
    expect(settled).toEqual(queued);
  });
});
