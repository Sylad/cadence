import { describe, expect, it } from 'vitest';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, harness, kindOf, reviewReport, workReport } from './orchestrate-harness.js';

/** Trois dépôts, deux lots dans le premier ; un lanceur qui mesure la concurrence. */
function setup(budget?: number) {
  const hs = [harness({ lots: [{ title: 'a1' }, { title: 'a2' }], budget }), harness(), harness()];
  const active = new Map<string, number>();
  let peak = 0;
  let peakRepo = 0;
  const log: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    active.set(o.cwd, (active.get(o.cwd) ?? 0) + 1);
    peakRepo = Math.max(peakRepo, active.get(o.cwd)!);
    peak = Math.max(peak, [...active.values()].reduce((a, b) => a + b, 0));
    log.push(`${o.cwd}:${kind}`);
    await new Promise((r) => setTimeout(r, 15));
    let out;
    if (kind === 'implement') {
      const lot = /on lot `(L\d)`/.exec(args[1])![1];
      out = claudeOut(workReport({ commits: [commitFile(o.cwd, `${lot}-${Math.random()}.txt`, `feat(${lot}): x`)] }));
    } else out = claudeOut(reviewReport());
    active.set(o.cwd, active.get(o.cwd)! - 1);
    return out;
  };
  const wave = { ...hs[0].wave, claude };
  const ctxs: LotCtx[] = [
    { ...hs[0].lot('L1'), wave },
    { ...hs[0].lot('L2'), wave },
    { ...hs[1].lot('L1'), wave },
    { ...hs[2].lot('L1'), wave },
  ];
  ctxs[1].lot.project = 'demo';
  ctxs[2].lot.project = 'b';
  ctxs[3].lot.project = 'c';
  return { ctxs, wave, peak: () => peak, peakRepo: () => peakRepo, log, hs };
}

describe('ordonnanceur', () => {
  it('jamais plus de deux sessions en même temps, jamais deux dans un dépôt', async () => {
    const s = setup();
    await runPool(s.ctxs);
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(s.peak()).toBeLessThanOrEqual(2);
    expect(s.peak()).toBe(2); // deux dépôts ont bien tourné ensemble
    expect(s.peakRepo()).toBe(1);
    // dans le dépôt a : L1 terminé (implement, review) avant le premier appel de L2
    const mine = s.log.filter((l) => l.startsWith(s.hs[0].repo));
    expect(mine.map((l) => l.split(':')[1])).toEqual(['implement', 'review', 'implement', 'review']);
  });

  it('le budget atteint : les lots suivants sont suspendus, aucune nouvelle session', async () => {
    const s = setup(2000);
    await runPool(s.ctxs);
    const statuses = s.ctxs.map((c) => c.lot.status);
    expect(statuses).toContain('suspended');
    expect(s.ctxs.filter((c) => c.lot.status === 'suspended').every((c) => c.lot.outcome === 'budget atteint')).toBe(true);
  });

  it('un lot qui dépend d\'un lot de la vague non prêt n\'est pas lancé', async () => {
    const s = setup();
    s.ctxs[0].lot.status = 'failed';
    s.ctxs[1].lot.dependsOn = ['L1'];
    await runPool([s.ctxs[0], s.ctxs[1]]);
    expect(s.ctxs[1].lot.status).toBe('handed-back');
    expect(s.ctxs[1].lot.outcome).toBe('dépendance non prête dans la vague : L1');
  });
});
