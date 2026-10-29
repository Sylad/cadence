import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const { COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { COLLECTOR: string };

type Out = { waves: { id: string; lots: { lot: string; trail: { kind: string; status: string; started: string; ended?: string }[] }[] }[]; ended: { id: string; lots: { lot: string; trail: unknown[] }[] }[] };

it('L413 R13 — le collecteur rend, pour chaque lot, la liste de ses pas (genre, statut, début, fin), vague vivante ou finie ; un pas sans genre ni date est écarté, un lot sans pas a une liste vide', () => {
  const root = mkdtempSync(join(tmpdir(), 'cycle-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(join(home, 'waves'), { recursive: true });
    const run = (id: string) => {
      mkdirSync(join(cwd, '.cadence', 'runs', id), { recursive: true });
      return join(cwd, '.cadence', 'runs', id);
    };
    const vivant = run('vivant');
    writeFileSync(join(vivant, 'wave.json'), JSON.stringify({ id: 'vivant', status: 'implementing' }));
    writeFileSync(
      join(vivant, 'ol--L6.json'),
      JSON.stringify({
        project: 'ol',
        lot: 'L6',
        status: 'reviewing',
        steps: [
          { n: 1, kind: 'implement', status: 'ok', started: '2026-10-29T10:00:00Z', ended: '2026-10-29T10:10:00Z', tokens: { counted: 5 } },
          { n: 2, kind: 'review', status: 'running', started: '2026-10-29T10:10:00Z', pid: 99999999 },
          { n: 3, status: 'ok' },
        ],
      }),
    );
    writeFileSync(join(vivant, 'ol--L7.json'), JSON.stringify({ project: 'ol', lot: 'L7', status: 'queued' }));
    const fini = run('fini');
    writeFileSync(join(fini, 'wave.json'), JSON.stringify({ id: 'fini', status: 'done' }));
    writeFileSync(join(fini, 'ol--L5.json'), JSON.stringify({ project: 'ol', lot: 'L5', status: 'ready', steps: [{ kind: 'fix', status: 'failed', started: '2026-10-29T09:00:00Z', ended: '2026-10-29T09:05:00Z' }] }));
    writeFileSync(join(home, 'waves', `${process.pid}.json`), JSON.stringify({ wave: 'vivant', pid: process.pid, cwd }));
    const r = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Out;
    const lots = out.waves[0]!.lots;
    expect(lots.find((l) => l.lot === 'L6')!.trail).toEqual([
      { kind: 'implement', status: 'ok', started: '2026-10-29T10:00:00Z', ended: '2026-10-29T10:10:00Z' },
      { kind: 'review', status: 'running', started: '2026-10-29T10:10:00Z' },
    ]);
    expect(lots.find((l) => l.lot === 'L7')!.trail).toEqual([]);
    expect(out.ended[0]!.lots[0]!.trail).toEqual([{ kind: 'fix', status: 'failed', started: '2026-10-29T09:00:00Z', ended: '2026-10-29T09:05:00Z' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
