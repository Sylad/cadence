import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';
import { RunStore, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { contexts } from '../src/orchestrate/execute.js';
import { depositIntegrations } from '../src/orchestrate/integration-vivante.js';

// L610 — une vague reprise ne joue que les lots qu'elle a repris : un lot rendu à l'intégration qu'elle ne joue pas ne peut pas y recevoir de demande (elle l'écarterait en « lot inconnu »).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const wave = (playing?: string[]): WaveState => ({ id: 'w1', created: 'x', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: 1, lots: ['a:L1', 'a:L2'], ...(playing ? { playing } : {}) });
const handedBack = (lot: string): LotState => ({ project: 'a', lot, status: 'handed-back', next: 'integrate', outcome: 'rendu', steps: [] }) as unknown as LotState;

function run(playing?: string[]) {
  const s = new RunStore(tempDir(), 'w1');
  s.writeWave(wave(playing));
  s.writeLot(handedBack('L1'));
  s.writeLot(handedBack('L2'));
  const err: string[] = [];
  const out: string[] = [];
  const code = depositIntegrations([{ lot: 'L2' }], { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } as never, s);
  return { s, code, err: err.join('\n'), out: out.join('\n') };
}

describe('L610 — dépôt d\'une intégration dans une vague reprise', () => {
  it('lot rendu que la vague ne joue pas → refus 2 sur-le-champ, avec le geste de reprise après la vague, file vide', () => {
    const r = run(['a:L1']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:L2');
    expect(r.err).toContain('ne joue pas');
    expect(r.err).toContain('cadence orchestrate --resume --wave w1 --integrate a:L2');
    expect(r.s.integrateQueue()).toEqual([]);
  });
  it('lot que la vague joue → accepté (le refus ne vise que les lots absents de la liste)', () => {
    const r = run(['a:L1', 'a:L2']);
    expect(r.err).not.toContain('ne joue pas');
  });
  it('vague sans liste (lancée avant L610) → pas de refus nouveau', () => {
    const r = run(undefined);
    expect(r.err).not.toContain('ne joue pas');
  });
  it('liste vide : la vague ne joue rien → refus', () => {
    expect(run([]).err).toContain('ne joue pas');
  });
});

describe('L610 — la vague écrit les lots qu\'elle joue', () => {
  it('contexts inscrit les lots joués dans la vague et l\'enregistre ; seul L1 repris → L2 absent', () => {
    const w = wave(['a:L1', 'a:L2']);
    let saved = 0;
    const ctxs = contexts([handedBack('L1')], [{ config: {}, loadPlan: () => ({}) } as never], { saveWave: () => saved++ } as never, w);
    expect(ctxs).toHaveLength(1);
    expect(w.playing).toEqual(['a:L1']);
    expect(saved).toBe(1);
  });
});
