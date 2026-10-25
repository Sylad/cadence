import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PJournal } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';
const at = (day: string, time: string) => `${day}T${time}`;

function ctx() {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', at('2026-10-01', '08:00:00'));
  return { root, runs };
}
async function perf(root: string, ...args: string[]) {
  const out: string[] = [];
  await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return out;
}
const pre = (model: string, from: string, to: string, over: Record<string, unknown> = {}) => ({ kind: 'precheck', model, started: at(CUR, from), ended: at(CUR, to), ...over });
const impl = (counted: number) => ({ kind: 'implement', started: at(CUR, '10:00:00'), ended: at(CUR, '10:30:00'), counted });

function lots(c: ReturnType<typeof ctx>, defs: [string, PJournal][]): void {
  for (const [lot, j] of defs) writeJournal(c.runs, 'w1', 'alpha', lot, j);
}

describe('L322 R7 — cadence perf mesure le précheck', () => {
  it('R7 — la répartition oui / partiel / non des lots rendus, par fenêtre', async () => {
    const c = ctx();
    lots(c, [
      ['L1', { precheck: 'oui', status: 'handed-back', steps: [pre('local', '08:00:00', '08:05:00')] }],
      ['L2', { precheck: 'partiel', steps: [pre('local', '08:00:00', '08:05:00'), impl(1000)] }],
      ['L3', { precheck: 'non', steps: [pre('local', '08:00:00', '08:05:00'), impl(1000)] }],
      ['L4', { precheck: 'non', steps: [{ ...pre('local', '08:00:00', '08:05:00'), ended: at(PREV, '08:05:00') }, impl(1000)] }],
    ]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.verdicts.current).toEqual({ oui: 1, partiel: 1, non: 2 });
    expect(data.precheck.verdicts.previous).toEqual({ oui: 0, partiel: 0, non: 0 });
  });

  it('R7 — durée et tokens du précheck local et de son repli sur Sonnet, échecs du local comptés', async () => {
    const c = ctx();
    lots(c, [
      ['L1', { precheck: 'non', steps: [pre('local', '08:00:00', '08:10:00', { status: 'failed' }), pre('sonnet', '08:10:00', '08:12:00', { counted: 20000 }), impl(1000)] }],
      ['L2', { precheck: 'non', steps: [pre('local', '09:00:00', '09:02:00'), impl(1000)] }],
    ]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.cost.current.local).toEqual({ runs: 2, failed: 1, minutes: 12 });
    expect(data.precheck.cost.current.sonnet).toEqual({ runs: 1, minutes: 2, tokens: 20000 });
  });

  it('R7 — le gain des « oui » : sessions d\'implémentation évitées, tokens estimés par la médiane des implémentations de la fenêtre', async () => {
    const c = ctx();
    lots(c, [
      ['L1', { precheck: 'oui', status: 'handed-back', steps: [pre('local', '08:00:00', '08:05:00'), pre('sonnet', '08:05:00', '08:06:00', { counted: 15000 })] }],
      ['L2', { precheck: 'non', steps: [pre('local', '08:00:00', '08:05:00'), impl(100000)] }],
      ['L3', { precheck: 'non', steps: [pre('local', '08:00:00', '08:05:00'), impl(300000)] }],
    ]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.cost.current.avoided).toEqual({ sessions: 1, tokens: 200000 });
  });

  it('R7 — un rapport local illisible est un échec du local, même si son étape finit ok (repli sur Sonnet) ; un « oui » local confirmé par Sonnet n\'en est pas un', async () => {
    const c = ctx();
    lots(c, [
      ['L1', { precheck: 'non', warnings: ['contrôle préalable : rapport du modèle local illisible (structured_output de mauvaise forme), repli sur Sonnet'], steps: [pre('local', '08:00:00', '08:03:00'), pre('sonnet', '08:03:00', '08:05:00', { counted: 20000 }), impl(1000)] }],
      ['L2', { precheck: 'oui', status: 'handed-back', warnings: ['contrôle préalable : « oui » du modèle local, confirmé par Sonnet'], steps: [pre('local', '09:00:00', '09:02:00'), pre('sonnet', '09:02:00', '09:03:00', { counted: 15000 })] }],
      ['L3', { precheck: 'non', steps: [pre('local', '10:00:00', '10:02:00'), impl(1000)] }],
    ]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.cost.current.local).toEqual({ runs: 3, failed: 1, minutes: 7 });
    expect(data.precheck.lots.find((l: { lot: string }) => l.lot === 'L1').local.status).toBe('illisible');
    expect(data.precheck.lots.find((l: { lot: string }) => l.lot === 'L2').local.status).toBe('ok');
    const text = (await perf(c.root)).join('\n');
    expect(text).toContain('précheck local : 3 sessions, 1 échec, 7 min');
    expect(text).toContain('alpha:L1 · non · local échec 3 min · Sonnet 2 min, 20 k tokens');
    expect(text).toContain('alpha:L3 · non · local ok 2 min');
  });

  it('R7 — le tableau écrit n/d pour le gain en tokens quand la fenêtre n\'a aucune implémentation', async () => {
    const c = ctx();
    lots(c, [['L1', { precheck: 'oui', status: 'handed-back', steps: [pre('local', '08:00:00', '08:05:00')] }]]);
    const text = (await perf(c.root)).join('\n');
    expect(text).toContain('gain des « oui » : 1 session d\'implémentation évitée (gain en tokens : n/d)');
  });

  it('R7 — sans aucune implémentation dans la fenêtre, le gain en tokens est n/d (null), jamais 0', async () => {
    const c = ctx();
    lots(c, [['L1', { precheck: 'oui', status: 'handed-back', steps: [pre('local', '08:00:00', '08:05:00')] }]]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.cost.current.avoided).toEqual({ sessions: 1, tokens: null });
  });

  it('R7 — une ligne par lot de la fenêtre courante : verdict, durée et tokens du précheck, local puis repli', async () => {
    const c = ctx();
    lots(c, [['L1', { precheck: 'non', steps: [pre('local', '08:00:00', '08:10:00', { status: 'failed' }), pre('sonnet', '08:10:00', '08:12:00', { counted: 20000 }), impl(1000)] }]]);
    const data = JSON.parse((await perf(c.root, '--json')).join('\n'));
    expect(data.precheck.lots).toEqual([{ project: 'alpha', lot: 'L1', verdict: 'non', local: { status: 'failed', minutes: 10 }, sonnet: { minutes: 2, tokens: 20000 } }]);
  });

  it('R7 — le tableau imprime la répartition, le coût local / Sonnet, le gain et une ligne par lot', async () => {
    const c = ctx();
    lots(c, [
      ['L1', { precheck: 'oui', status: 'handed-back', steps: [pre('local', '08:00:00', '08:05:00')] }],
      ['L2', { precheck: 'non', steps: [pre('local', '08:00:00', '08:10:00', { status: 'failed' }), pre('sonnet', '08:10:00', '08:12:00', { counted: 20000 }), impl(100000)] }],
    ]);
    const text = (await perf(c.root)).join('\n');
    expect(text).toContain('précheck : oui 1 · partiel 0 · non 1');
    expect(text).toContain('précheck local : 2 sessions, 1 échec, 15 min');
    expect(text).toContain('précheck Sonnet : 1 session, 20 k tokens, 2 min');
    expect(text).toContain('gain des « oui » : 1 session d\'implémentation évitée (≈ 100 k tokens)');
    expect(text).toContain('alpha:L2 · non · local échec 10 min · Sonnet 2 min, 20 k tokens');
  });

  it('R7 — sans précheck dans la fenêtre, aucune ligne de détail (rien n\'est inventé)', async () => {
    const c = ctx();
    lots(c, [['L1', { steps: [impl(1000)] }]]);
    const text = (await perf(c.root)).join('\n');
    expect(text).not.toContain('précheck local');
    expect(text).not.toContain('gain des « oui »');
  });
});
