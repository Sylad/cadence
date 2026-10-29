import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PStep } from './perf-helpers.js';

const TODAY = '2026-10-16';
const DAY = '2026-10-14';
const at = (time: string, day = DAY) => `${day}T${time}`;

function root(lots: { id: string; estimate: number }[]): { dir: string; runs: string } {
  const dir = tempDir();
  const runs = join(dir, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', at('08:00:00', '2026-10-01'));
  mkdirSync(join(dir, 'alpha', '.cadence'), { recursive: true });
  const body = lots.map((l) => `  - id: ${l.id}\n    title: "t"\n    status: done\n    estimate: ${l.estimate}`).join('\n');
  writeFileSync(join(dir, 'alpha', '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body}\n`);
  return { dir, runs };
}
/** Un lot rendu dont la première étape commence à `from` et la dernière finit à `to` (heures du jour DAY). */
function lot(runs: string, id: string, from: string, to: string, extra: PStep[] = []): void {
  const steps: PStep[] = [{ kind: 'implement', started: at(from), ended: at('09:00:00'), counted: 1000 }, ...extra, { kind: 'review', started: at('09:30:00'), ended: at(to), counted: 1000 }];
  writeJournal(runs, 'w1', 'alpha', id, { status: 'ready', steps });
}
async function perf(dir: string) {
  const out: string[] = [];
  const code = await run(['perf', '--json'], { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, data: JSON.parse(out.join('\n')) as any };
}

describe('cadence perf — durée de mur d’un lot par taille (L414)', () => {
  it('R1 — la médiane de la durée de mur d’un lot rendu (début de sa première étape → fin de sa dernière), par estimate, comme tokens.byEstimate', async () => {
    const { dir, runs } = root([{ id: 'L1', estimate: 0.5 }, { id: 'L2', estimate: 0.5 }, { id: 'L3', estimate: 0.5 }, { id: 'L4', estimate: 1 }]);
    lot(runs, 'L1', '08:00:00', '10:00:00'); // 120 min
    lot(runs, 'L2', '08:00:00', '09:40:00'); // 100 min
    lot(runs, 'L3', '08:00:00', '10:20:00'); // 140 min
    lot(runs, 'L4', '08:00:00', '12:00:00'); // 240 min
    const { code, data } = await perf(dir);
    expect(code).toBe(0);
    expect(data.lotMinutes['0.5'].current).toBe(120);
    expect(data.lotMinutes['0.5'].lots.current).toBe(3);
    expect(data.lotMinutes['1'].current).toBe(240);
    expect(Object.keys(data.lotMinutes).sort()).toEqual(Object.keys(data.tokens.byEstimate).sort());
  });

  it('R2 — un lot passé par la chaîne spec est une classe à part (« 0.5+spec »), comme pour les tokens', async () => {
    const { dir, runs } = root([{ id: 'L1', estimate: 0.5 }, { id: 'L2', estimate: 0.5 }]);
    lot(runs, 'L1', '08:00:00', '10:00:00');
    lot(runs, 'L2', '08:00:00', '11:00:00', [{ kind: 'spec', started: at('08:10:00'), ended: at('08:20:00'), counted: 10 }]);
    const { data } = await perf(dir);
    expect(data.lotMinutes['0.5'].current).toBe(120);
    expect(data.lotMinutes['0.5+spec'].current).toBe(180);
  });

  it('R3 — un journal sans date de début lisible n’entre pas dans la médiane', async () => {
    const { dir, runs } = root([{ id: 'L1', estimate: 0.5 }, { id: 'L2', estimate: 0.5 }]);
    lot(runs, 'L1', '08:00:00', '10:00:00');
    writeJournal(runs, 'w1', 'alpha', 'L2', { status: 'ready', steps: [{ kind: 'implement', ended: at('09:00:00'), counted: 5 }] });
    const { data } = await perf(dir);
    expect(data.lotMinutes['0.5'].current).toBe(120);
    expect(data.lotMinutes['0.5'].lots.current).toBe(1);
  });

  it('R4 — un journal dont la dernière fin précède le premier début n’entre pas dans la médiane', async () => {
    const { dir, runs } = root([{ id: 'L1', estimate: 0.5 }, { id: 'L2', estimate: 0.5 }]);
    lot(runs, 'L1', '08:00:00', '10:00:00');
    writeJournal(runs, 'w1', 'alpha', 'L2', { status: 'ready', steps: [{ kind: 'implement', started: at('11:00:00'), ended: at('09:00:00'), counted: 5 }] });
    const { data } = await perf(dir);
    expect(data.lotMinutes['0.5'].lots.current).toBe(1);
  });

  it('R5 — une durée n’a ni ⚠ ni jumeau qualité : `warn` faux et `twin` nul pour chaque classe, même quand la médiane monte de plus de 25 % sur 5 lots dans chaque fenêtre', async () => {
    const ids = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'];
    const { dir, runs } = root(ids.map((id) => ({ id, estimate: 0.5 })));
    ids.forEach((id, i) => {
      const old = i < 5;
      const day = old ? '2026-10-08' : DAY;
      writeJournal(runs, 'w1', 'alpha', id, { status: 'ready', steps: [{ kind: 'implement', started: at('08:00:00', day), ended: at(old ? '08:30:00' : '10:00:00', day), counted: 1000 }] });
    });
    const { data } = await perf(dir);
    expect(data.lotMinutes['0.5']).toMatchObject({ current: 120, previous: 30, lots: { current: 5, previous: 5 }, warn: false, twin: null });
    expect(data.tokens.byEstimate['0.5'].twin).toBe('corrections.firstTime');
  });
});
