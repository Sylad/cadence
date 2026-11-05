import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { registerWave, updateWaveRepos } from '../src/orchestrate/registry.js';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { COLLECTOR: string };

// L589 : le collecteur Python joué pour de vrai, contre un registre écrit par le vrai `registry.ts` — `lanes` est le seul lien entre
// ce que `cadence orchestrate --status` compte (un créneau par lot joué en worktree) et ce que la bande affiche ; sans lui, la bande
// retombe sur les dépôts tenus et affiche « 2 libres » quand --status dit 0 sur 3 (04-11).

type Out = { waves: { id: string; repos: number; lanes: number | null }[] };
function collect(lanes: number | undefined): Out['waves'][number] {
  const root = mkdtempSync(join(tmpdir(), 'lanes-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    const dir = join(cwd, '.cadence', 'runs', 'vague');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'wave.json'), JSON.stringify({ id: 'vague', status: 'implementing' }));
    // inscrite par le registre lui-même, pas par un JSON écrit à la main : une clé renommée dans registry.ts rougit ce test
    registerWave(home, { pid: process.pid, wave: 'vague', started: '2026-11-04T12:00:00.000Z', cwd, repos: [cwd], cap: 3 });
    updateWaveRepos(home, process.pid, [cwd], lanes);
    const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } });
    expect(run.status).toBe(0);
    const wave = (JSON.parse(run.stdout) as Out).waves[0];
    expect(wave).toBeDefined();
    return wave!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('L589 R1 — le collecteur rend `lanes` du registre : une vague à 1 dépôt qui joue 3 lots en worktrees porte lanes: 3 (--status dit 0 sur 3, la bande aussi)', () => {
  expect(collect(3)).toMatchObject({ id: 'vague', repos: 1, lanes: 3 });
  expect(collect(0)).toMatchObject({ repos: 1, lanes: 0 });
});

it('L589 R2 — sans `lanes` au registre (hors worktree, ou cadence plus ancien), le collecteur rend lanes: null et la bande compte les dépôts tenus', () => {
  expect(collect(undefined)).toMatchObject({ repos: 1, lanes: null });
});
