import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
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
    ['L6', { status: 'failed', escalation: { model: 'fable', stage: 'done', issue: 'échec' }, steps: [step(CUR)] }],
    ['L4', { steps: [step(CUR)] }],
    ['L5', { escalation: { model: 'opus', stage: 'done', issue: 'conforme' }, steps: [step(PREV)] }],
  ];

  it('R10 — les lots escaladés de chaque fenêtre, par issue', async () => {
    const data = JSON.parse((await perf(ctx(defs()), '--json')).join('\n'));
    expect(data.escalations.current).toEqual({ lots: 4, conforme: 1, rendu: 1, nonJouee: 1, echec: 1 });
    expect(data.escalations.previous).toEqual({ lots: 1, conforme: 1, rendu: 0, nonJouee: 0, echec: 0 });
  });

  it('R10 — le rapport lisible dit le nombre d\'escalades et leur issue, rien sans escalade', async () => {
    const text = (await perf(ctx(defs()))).join('\n');
    expect(text).toMatch(/escalades de modèle : 4 lots · 1 conforme · 1 rendu malgré l'escalade · 1 non jouée · 1 en échec/);
    const none = (await perf(ctx([['L4', { steps: [step(CUR)] }]]))).join('\n');
    expect(none).not.toContain('escalades de modèle');
  });
  it('L338 — un lot retiré (--drop) pendant son escalade, sans issue, est compté parmi les lots mais pas « en échec »', async () => {
    const data = JSON.parse((await perf(ctx([['L7', { status: 'handed-back', escalation: { model: 'fable', stage: 'fix' }, steps: [step(CUR)] }]]), '--json')).join('\n'));
    expect(data.escalations.current).toEqual({ lots: 1, conforme: 0, rendu: 0, nonJouee: 0, echec: 0 });
  });
});

describe('L338 — docs/perf.md liste les clés de --json', () => {
  it('chaque clé de premier niveau de la sortie --json est dans la liste de docs/perf.md', async () => {
    const root = ctx([['L1', { steps: [step(CUR)] }]]);
    const keys = Object.keys(JSON.parse((await perf(root, '--json')).join('\n')));
    const line = readFileSync(join(__dirname, '..', 'docs', 'perf.md'), 'utf8').split('\n').find((l) => l.startsWith('- **`--json`**')) ?? '';
    const listed = line.slice(line.indexOf('{'), line.indexOf('}`; ') + 1);
    expect(keys).toContain('escalations');
    expect(keys).toContain('quality');
    for (const k of keys) expect(listed, k).toMatch(new RegExp(`[ ,]${k}[:,} ]`));
  });
});
