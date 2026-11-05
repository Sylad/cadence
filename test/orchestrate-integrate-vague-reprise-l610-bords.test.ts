import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';
import { RunStore, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { depositIntegrations } from '../src/orchestrate/integration-vivante.js';

// L610 (bords) — le refus « la vague ne joue pas ce lot » : lot de deux projets, lot nu, lot déposé en lot avec un lot joué, deux fois le même lot.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const wave = (playing?: string[]): WaveState => ({ id: 'w1', created: 'x', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: 1, lots: ['a:L1', 'a:L2', 'b:L2'], ...(playing ? { playing } : {}) });
const handedBack = (project: string, lot: string): LotState => ({ project, lot, status: 'handed-back', next: 'integrate', outcome: 'rendu', steps: [] }) as unknown as LotState;

function run(playing: string[] | undefined, targets: { project?: string; lot: string }[]) {
  const s = new RunStore(tempDir(), 'w1');
  s.writeWave(wave(playing));
  for (const [p, l] of [['a', 'L1'], ['a', 'L2'], ['b', 'L2']] as const) s.writeLot(handedBack(p, l));
  const err: string[] = [];
  const out: string[] = [];
  const code = depositIntegrations(targets, { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } as never, s);
  return { s, code, err: err.join('\n'), out: out.join('\n') };
}

describe('L610 — bords du refus', () => {
  it('deux projets portent L2, la vague ne joue que b:L2 : a:L2 refusé nommé, rien en file', () => {
    const r = run(['b:L2'], [{ project: 'a', lot: 'L2' }]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:L2');
    expect(r.err).toContain('ne joue pas');
    expect(r.s.integrateQueue()).toEqual([]);
  });
  it('deux lots dont un seul joué : refus de la demande entière, rien déposé pour le lot joué', () => {
    const r = run(['a:L1'], [{ project: 'a', lot: 'L1' }, { project: 'a', lot: 'L2' }]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:L2');
    expect(r.s.integrateQueue()).toEqual([]);
  });
  it('le même lot nommé deux fois et non joué : refus (code 2), rien en file', () => {
    const r = run(['a:L1'], [{ project: 'a', lot: 'L2' }, { project: 'a', lot: 'L2' }]);
    expect(r.code).toBe(2);
    expect(r.s.integrateQueue()).toEqual([]);
  });
  it('le refus nomme la commande à lancer avec le projet du lot refusé', () => {
    const r = run(['a:L1'], [{ project: 'b', lot: 'L2' }]);
    expect(r.err).toContain('cadence orchestrate --resume --wave w1 --integrate b:L2');
  });
});
