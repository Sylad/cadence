import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PJournal } from './perf-helpers.js';

const TODAY = '2026-10-26';
const CUR = '2026-10-22';
const PREV = '2026-10-15';
const step = (day: string) => ({ kind: 'implement', model: 'sonnet', started: `${day}T10:00:00`, ended: `${day}T10:30:00`, counted: 1000 });

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

describe('L354 R6 — cadence perf compte les tests « instables sous charge »', () => {
  const defs = (): [string, PJournal][] => [
    ['L1', { instables: ['test/a.test.ts > x', 'test/b.test.ts > y'], steps: [step(CUR)] }],
    ['L2', { instables: ['test/a.test.ts > x'], steps: [step(CUR)] }],
    ['L3', { steps: [step(CUR)] }],
    ['L4', { instables: ['test/c.test.ts > z'], steps: [step(PREV)] }],
  ];
  it('R6 — lots touchés et tests instables de chaque fenêtre, en --json', async () => {
    const data = JSON.parse((await perf(ctx(defs()), '--json')).join('\n'));
    expect(data.instables.current).toEqual({ lots: 2, tests: 3 });
    expect(data.instables.previous).toEqual({ lots: 1, tests: 1 });
  });
  it('R6 — le rapport lisible les dit, et ne dit rien sans test instable', async () => {
    const text = (await perf(ctx(defs()))).join('\n');
    expect(text).toMatch(/tests instables sous charge : 3 tests dans 2 lots/);
    const none = (await perf(ctx([['L3', { steps: [step(CUR)] }]]))).join('\n');
    expect(none).not.toContain('instables sous charge');
  });
  it('R6 — docs/perf.md liste la clé instables de --json', () => {
    const line = readFileSync(join(__dirname, '..', 'docs', 'perf.md'), 'utf8').split('\n').find((l) => l.startsWith('- **`--json`**')) ?? '';
    expect(line).toMatch(/[ ,]instables[:,} ]/);
  });
});
