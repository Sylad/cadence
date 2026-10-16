import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournals, readRuns } from '../src/corrections.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

function fixture() {
  const runs = tempDir();
  writeWave(runs, 'w1');
  writeJournal(runs, 'w1', 'alpha', 'L1', { status: 'ready', budget: 450_000, steps: [{ kind: 'implement', counted: 300_000, ended: '2026-10-10T08:00:00.000Z' }, { kind: 'review', constats: ['bug'], ended: '2026-10-10T09:00:00.000Z' }, { kind: 'fix', counted: 20_000, ended: '2026-10-10T10:00:00.000Z' }] });
  writeJournal(runs, 'w1', 'alpha', 'L2', { status: 'failed', steps: [{ kind: 'implement', status: 'failed', ended: '2026-10-10T08:00:00.000Z' }] });
  return runs;
}

describe('lecteur partagé des journaux (R23)', () => {
  it('R23 — le lecteur partagé rend status, budget, tokens.counted et ended d\'un journal, et la date de fin de l\'étape fix d\'une passe', () => {
    const [l1] = readJournals(fixture());
    expect(l1).toMatchObject({ project: 'alpha', lot: 'L1', status: 'ready', budget: 450_000, waveReadable: true, waveCreated: '2026-10-01T08:00:00.000Z', implemented: true });
    expect(l1!.steps.map((s) => [s.kind, s.status, s.counted, s.ended])).toEqual([
      ['implement', 'ok', 300_000, '2026-10-10T08:00:00.000Z'],
      ['review', 'ok', undefined, '2026-10-10T09:00:00.000Z'],
      ['fix', 'ok', 20_000, '2026-10-10T10:00:00.000Z'],
    ]);
    expect(l1!.passes.map((p) => [p.key, p.findings, p.fixEnded])).toEqual([['w1/alpha--L1/3', ['bug'], '2026-10-10T10:00:00.000Z']]);
  });

  it('R23 — le lecteur rend aussi un lot failed dès l\'implement, que readRuns écarte comme avant', () => {
    const runs = fixture();
    expect(readJournals(runs).map((j) => [j.lot, j.status, j.implemented])).toEqual([['L1', 'ready', true], ['L2', 'failed', false]]);
    expect(readRuns(runs)).toEqual({
      lots: [{ project: 'alpha', lot: 'L1', visible: false, fixes: 1 }],
      passes: [{ key: 'w1/alpha--L1/3', project: 'alpha', lot: 'L1', visible: false, findings: ['bug'], commits: [] }],
    });
  });

  it('R23 — seul un wave.json illisible est signalé (waveReadable) ; un journal sans steps lisible est écarté', () => {
    const runs = fixture();
    writeWave(runs, 'w2', null);
    writeJournal(runs, 'w2', 'beta', 'L9', { steps: [{ kind: 'implement' }] });
    writeFileSync(join(runs, 'w2', 'beta--L10.json'), JSON.stringify({ project: 'beta', lot: 'L10', status: 'ready' }));
    const w2 = readJournals(runs).filter((j) => j.wave === 'w2');
    expect(w2.map((j) => [j.lot, j.waveReadable, j.waveCreated])).toEqual([['L9', false, undefined]]);
  });
});

describe('lecteur partagé des journaux — modèle, début et compteurs (R16)', () => {
  const step = (kind: string, extra: Record<string, unknown>) => ({ kind, ended: '2026-10-10T08:30:00.000Z', started: '2026-10-10T08:00:00.000Z', ...extra });

  it('R16 — une étape rend model, started et les quatre compteurs', () => {
    const runs = tempDir();
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step('implement', { model: 'opus', tokens: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40, counted: 70 } })] });
    const [s] = readJournals(runs)[0]!.steps;
    expect(s).toMatchObject({ model: 'opus', started: '2026-10-10T08:00:00.000Z', counted: 70, usage: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40 } });
  });

  it('R16 — une étape sans compteurs input/output rend counted seul', () => {
    const runs = tempDir();
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step('implement', { tokens: { counted: 500 } })] });
    const [s] = readJournals(runs)[0]!.steps;
    expect(s!.counted).toBe(500);
    expect(s!.usage).toBeUndefined();
  });

  it('R16 — une étape locale rend ses quatre compteurs et counted 0', () => {
    const runs = tempDir();
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step('review', { model: 'local', tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, counted: 0 } })] });
    const [s] = readJournals(runs)[0]!.steps;
    expect(s).toMatchObject({ model: 'local', counted: 0, usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } });
  });

  it('R16 — readRuns donne la même sortie qu\'avant sur les mêmes journaux, quels que soient model, started et compteurs', () => {
    const runs = tempDir();
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [step('implement', { tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, counted: 7 } }), { kind: 'review', constats: ['bug'], ended: '2026-10-10T09:00:00.000Z' }, { kind: 'fix', ended: '2026-10-10T10:00:00.000Z' }] });
    expect(readRuns(runs)).toEqual({
      lots: [{ project: 'alpha', lot: 'L1', visible: false, fixes: 1 }],
      passes: [{ key: 'w1/alpha--L1/3', project: 'alpha', lot: 'L1', visible: false, findings: ['bug'], commits: [] }],
    });
  });
});
