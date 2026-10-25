import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PJournal } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';
const step = (day: string, kind = 'implement', model = 'sonnet') => ({ kind, model, started: `${day}T10:00:00`, ended: `${day}T10:30:00`, counted: 1000 });

function ctx(defs: [string, PJournal][]) {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', '2026-10-01T08:00:00');
  for (const [lot, j] of defs) writeJournal(runs, 'w1', 'alpha', lot, j);
  return root;
}
async function perf(root: string, ...args: string[]) {
  const out: string[] = [];
  await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return out;
}

describe('L337 R10 — cadence perf compte les escalades et leur issue', () => {
  const defs = (): [string, PJournal][] => [
    ['L1', { escalation: { model: 'fable', stage: 'done', issue: 'conforme' }, steps: [step(CUR), step(CUR, 'fix', 'fable')] }],
    ['L2', { status: 'handed-back', escalation: { model: 'fable', stage: 'done', issue: 'rendu' }, steps: [step(CUR), step(CUR, 'fix', 'fable')] }],
    ['L3', { status: 'handed-back', escalation: { model: 'fable', stage: 'done', issue: 'non jouée' }, steps: [step(CUR)] }],
    ['L4', { steps: [step(CUR)] }],
    ['L5', { escalation: { model: 'opus', stage: 'done', issue: 'conforme' }, steps: [step(PREV)] }],
  ];

  it('R10 — les lots escaladés de chaque fenêtre, par issue', async () => {
    const data = JSON.parse((await perf(ctx(defs()), '--json')).join('\n'));
    expect(data.escalations.current).toEqual({ lots: 3, conforme: 1, rendu: 1, nonJouee: 1 });
    expect(data.escalations.previous).toEqual({ lots: 1, conforme: 1, rendu: 0, nonJouee: 0 });
  });

  it('R10 — le rapport lisible dit le nombre d\'escalades et leur issue, rien sans escalade', async () => {
    const text = (await perf(ctx(defs()))).join('\n');
    expect(text).toMatch(/escalades de modèle : 3 lots · 1 conforme · 1 rendu malgré l'escalade · 1 non jouée/);
    const none = (await perf(ctx([['L4', { steps: [step(CUR)] }]]))).join('\n');
    expect(none).not.toContain('escalades de modèle');
  });
});
