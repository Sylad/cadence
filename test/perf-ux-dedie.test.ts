import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PStep } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';

let seq = 0;
interface Ctx { root: string; runs: string }
function ctx(): Ctx {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', '2026-10-01T08:00:00');
  return { root, runs };
}

/** Un journal rendu le `day` : implement puis les étapes données. */
function lot(c: Ctx, day: string, o: { visible?: boolean; small?: boolean; steps?: string[] }): void {
  const steps: PStep[] = [{ kind: 'implement', ended: `${day}T09:00:00` }, ...(o.steps ?? []).map((kind): PStep => ({ kind, ended: `${day}T10:00:00` }))];
  writeJournal(c.runs, 'w1', 'alpha', `L${++seq}`, { status: 'ready', visible: o.visible, small: o.small, steps });
}

async function perf(root: string, ...args: string[]) {
  const out: string[] = [];
  await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return { text: out.join('\n'), out };
}
const json = async (root: string) => JSON.parse((await perf(root, '--json')).text);

describe('cadence perf — UX des petits lots visibles (L283)', () => {
  it('R1 — « sessions ux par lot visible » compte la review-small d\'un petit lot visible comme une session ux', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: true, steps: ['review-small'] });
    lot(c, CUR, { visible: true, small: true, steps: ['review-small', 'fix', 'review-small'] });
    expect((await json(c.root)).interventions.ux.current).toBe(1.5);
  });

  it('R2 — la review-small d\'un lot visible qui n\'est pas petit (revue courte après les mineurs) ne voit pas l\'application : non comptée', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: false, steps: ['review', 'ux', 'review-small'] });
    lot(c, CUR, { visible: true, steps: ['review-small'] }); // journal ancien, sans `small`
    expect((await json(c.root)).interventions.ux.current).toBe(0.5);
  });

  it('R3 — la review-small d\'un lot non visible n\'est pas une session ux', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: true, steps: ['review-small'] });
    lot(c, CUR, { visible: false, small: true, steps: ['review-small'] });
    expect((await json(c.root)).interventions.ux.current).toBe(1);
  });

  it('R4 — une review-small échouée ou sautée n\'est pas une session ux', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'LX', { visible: true, small: true, steps: [{ kind: 'implement', ended: `${CUR}T09:00:00` }, { kind: 'review-small', status: 'failed', ended: `${CUR}T10:00:00` }, { kind: 'review-small', status: 'skipped', ended: `${CUR}T11:00:00` }] });
    expect((await json(c.root)).interventions.ux.current).toBe(0);
  });

  it('R5 — part des lots visibles revus par une étape ux dédiée : 1 lot sur 4 ici, les petits lots visibles et les lots non visibles ne la gonflent pas', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: false, steps: ['review', 'ux'] });
    lot(c, CUR, { visible: true, small: true, steps: ['review-small'] });
    lot(c, CUR, { visible: true, small: true, steps: ['review-small'] });
    lot(c, CUR, { visible: true, small: false, steps: ['review'] });
    lot(c, CUR, { visible: false, steps: ['ux'] });
    const d = await json(c.root);
    expect(d.interventions.dedicatedUx.current).toBe(0.25);
    expect(d.interventions.dedicatedUx.lots.current).toBe(4);
  });

  it('R6 — un lot visible à deux étapes ux compte une fois dans la part ; une étape ux non aboutie ne compte pas', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: false, steps: ['review', 'ux', 'ux'] });
    writeJournal(c.runs, 'w1', 'alpha', 'LY', { visible: true, small: false, steps: [{ kind: 'implement', ended: `${CUR}T09:00:00` }, { kind: 'ux', status: 'skipped', ended: `${CUR}T10:00:00` }] });
    expect((await json(c.root)).interventions.dedicatedUx.current).toBe(0.5);
  });

  it('R7 — sans lot visible dans la fenêtre, la part est n/d (null), jamais 0', async () => {
    const c = ctx();
    lot(c, CUR, { visible: false, steps: ['review'] });
    expect((await json(c.root)).interventions.dedicatedUx.current).toBeNull();
  });

  it('R8 — l\'indicateur est une information : jamais de ⚠ ni de jumeau, même quand la part baisse de moitié', async () => {
    const c = ctx();
    for (let i = 0; i < 6; i++) lot(c, PREV, { visible: true, small: false, steps: ['review', 'ux'] });
    for (let i = 0; i < 6; i++) lot(c, CUR, { visible: true, small: i > 0, steps: i === 0 ? ['review', 'ux'] : ['review-small'] });
    const d = await json(c.root);
    expect(d.interventions.dedicatedUx.previous).toBe(1);
    expect(d.interventions.dedicatedUx.warn).toBe(false);
    expect(d.interventions.dedicatedUx.twin).toBeNull();
  });

  it('R9 — le texte imprime la ligne sous « Interventions du lead », avec son pourcentage', async () => {
    const c = ctx();
    lot(c, CUR, { visible: true, small: false, steps: ['review', 'ux'] });
    lot(c, CUR, { visible: true, small: true, steps: ['review-small'] });
    const { out } = await perf(c.root);
    const i = out.findIndex((l) => l === 'Interventions du lead');
    expect(i).toBeGreaterThan(-1);
    expect(out[i + 3]).toContain('part des lots visibles revus par une étape ux : 50 %');
    expect(out[i + 2]).toContain('sessions ux par lot visible : 1');
  });
});
