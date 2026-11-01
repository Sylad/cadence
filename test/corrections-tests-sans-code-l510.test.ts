import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readRuns } from '../src/corrections.js';
import { renderTestsSansCode, testsSansCode } from '../src/corrections-sans-code.js';
import { tempDir } from './helpers.js';

interface S { kind: string; commits?: string[]; constats?: string[] }

/** Un journal de lot ; les étapes `review` portent leurs constats dans un rapport, un `fix` ses commits (vides : passe terminée sans changement de code). */
function lot(runs: string, wave: string, id: string, steps: S[]) {
  const dir = join(runs, wave);
  mkdirSync(join(dir, `p--${id}`), { recursive: true });
  const rec = steps.map((s, i) => {
    const n = i + 1;
    const report = `${n}-${s.kind}.json`;
    if (s.constats) writeFileSync(join(dir, `p--${id}`, report), JSON.stringify({ structured: { constats: s.constats.map((texte) => ({ texte })) } }));
    return { n, kind: s.kind, status: 'ok', ended: '2026-10-30T08:00:00.000Z', report, commits: s.commits ?? [] };
  });
  writeFileSync(join(dir, `p--${id}.json`), JSON.stringify({ project: 'p', lot: id, status: 'ready', steps: rec }));
  writeFileSync(join(dir, 'wave.json'), JSON.stringify({ created: '2026-10-30T07:00:00.000Z' }));
}

const sansCode = (runs: string) => testsSansCode(readRuns(runs).passes);

describe('L510 R5 — cadence corrections mesure la part des passes lancées sur des tests terminées sans changement de code', () => {
  it('R5 — compte les passes sans constat (tests rouges) et, parmi elles, celles sans commit', () => {
    const runs = tempDir();
    lot(runs, 'w1', 'L1', [{ kind: 'implement' }, { kind: 'fix', commits: [] }, { kind: 'fix', commits: ['abc fix(L1): x'] }]); // 2 passes sur tests, 1 sans code
    lot(runs, 'w1', 'L2', [{ kind: 'implement' }, { kind: 'review', constats: ['c'] }, { kind: 'fix', commits: [] }]); // passe sur constat sans commit : pas une passe sur tests
    expect(sansCode(runs)).toEqual({ passes: 2, sansCode: 1 });
  });
  it('R5 — aucune passe sur tests : zéro sur zéro, et le rapport ne dit rien de plus', () => {
    const runs = tempDir();
    lot(runs, 'w1', 'L1', [{ kind: 'implement' }, { kind: 'review', constats: ['c'] }, { kind: 'fix', commits: ['abc x'] }]);
    expect(sansCode(runs)).toEqual({ passes: 0, sansCode: 0 });
    expect(renderTestsSansCode(sansCode(runs))).toEqual([]);
  });
  it('R5 — le rapport lisible donne le compte et la part, le --json la clé testsSansCode', async () => {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    lot(runs, 'w1', 'L1', [{ kind: 'implement' }, { kind: 'fix', commits: [] }, { kind: 'fix', commits: ['abc x'] }, { kind: 'fix', commits: [] }, { kind: 'fix', commits: [] }]);
    const out: string[] = [];
    const io = { cwd: root, env: {}, now: () => new Date('2026-11-01T10:00:00'), out: (l: string) => out.push(l), err: () => {} };
    expect(await run(['corrections'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/4 passes lancées sur des tests, 3 terminées sans changement de code \(75 %\)/);
    out.length = 0;
    await run(['corrections', '--json'], io);
    expect(JSON.parse(out.join('\n')).testsSansCode).toEqual({ passes: 4, sansCode: 3 });
  });
  it('R5 — les deux dernières fenêtres : --since/--until découpent les vagues, chaque fenêtre a sa part', async () => {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    lot(runs, 'w1', 'L1', [{ kind: 'implement' }, { kind: 'fix', commits: [] }]);
    lot(runs, 'w2', 'L2', [{ kind: 'implement' }, { kind: 'fix', commits: ['abc x'] }]);
    writeFileSync(join(runs, 'w2', 'wave.json'), JSON.stringify({ created: '2026-10-31T07:00:00.000Z' }));
    const out: string[] = [];
    const io = { cwd: root, env: {}, now: () => new Date('2026-11-01T10:00:00'), out: (l: string) => out.push(l), err: () => {} };
    await run(['corrections', '--json', '--until', '2026-10-30T23:00Z'], io);
    expect(JSON.parse(out.join('\n')).testsSansCode).toEqual({ passes: 1, sansCode: 1 });
    out.length = 0;
    await run(['corrections', '--json', '--since', '2026-10-30T23:00Z'], io);
    expect(JSON.parse(out.join('\n')).testsSansCode).toEqual({ passes: 1, sansCode: 0 });
  });
});
