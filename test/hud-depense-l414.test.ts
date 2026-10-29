import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { COLLECTOR: string };

// L414 : le collecteur Python joué pour de vrai — ce que le panneau des lots lit du budget et de la durée d'un lot en cours.

type Lot = Record<string, unknown>;
function collect(lotFile: Record<string, unknown>): Lot {
  const root = mkdtempSync(join(tmpdir(), 'depense-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(join(home, 'waves'), { recursive: true });
    const dir = join(cwd, '.cadence', 'runs', 'vague');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'wave.json'), JSON.stringify({ id: 'vague', status: 'implementing' }));
    writeFileSync(join(dir, 'ol--L5.json'), JSON.stringify({ project: 'ol', lot: 'L5', status: 'implementing', ...lotFile }));
    writeFileSync(join(home, 'waves', `${process.pid}.json`), JSON.stringify({ wave: 'vague', pid: process.pid, cwd }));
    const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } });
    expect(run.status).toBe(0);
    return (JSON.parse(run.stdout) as { waves: { lots: Lot[] }[] }).waves[0]!.lots[0]!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const step = (kind: string, started: string | undefined, ended: string | undefined, counted?: number, status = 'ok') => ({ n: 1, kind, status, started, ended, ...(counted === undefined ? {} : { tokens: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, counted } }) });

it('L414 R1 — le collecteur rend, par lot, le budget, la part réservée à l’escalade, l’estimate, les tokens comptés (somme des étapes), le premier début et la dernière fin', () => {
  const lot = collect({
    budget: 775_000, escalationReserve: 175_000, estimate: 0.5,
    steps: [step('precheck', '2026-10-29T19:10:00.000Z', '2026-10-29T19:11:00.000Z', 10_000), step('implement', '2026-10-29T19:11:00.000Z', '2026-10-29T19:40:00.000Z', 200_000), step('review', '2026-10-29T19:40:00.000Z', '2026-10-29T19:50:00.000Z', 50_000)],
  });
  expect(lot).toMatchObject({ budget: 775_000, escalationReserve: 175_000, estimate: 0.5, consumed: 260_000, since: '2026-10-29T19:10:00.000Z', until: '2026-10-29T19:50:00.000Z', spec: false, escalated: false });
});

it('L414 R2 — une étape en cours (sans fin) : `until` est nul, la durée court jusqu’à maintenant ; une étape sans tokens ne compte rien', () => {
  const lot = collect({ steps: [step('implement', '2026-10-29T19:11:00.000Z', '2026-10-29T19:40:00.000Z', 5), step('fix', '2026-10-29T19:41:00.000Z', undefined, undefined, 'running')] });
  expect(lot).toMatchObject({ consumed: 5, since: '2026-10-29T19:11:00.000Z', until: null });
});

it('L414 R3 — un état sans budget, sans estimate ni étape : champs absents ou nuls, jamais d’erreur du collecteur ; `spec` vrai dès une étape de la chaîne spec, `escalated` dès une escalade posée', () => {
  expect(collect({ steps: [] })).toMatchObject({ consumed: 0, since: null, until: null, budget: null, estimate: null, spec: false });
  expect(collect({ steps: [step('spec', '2026-10-29T19:11:00.000Z', '2026-10-29T19:12:00.000Z', 1)], escalation: { model: 'fable', stage: 'fix' } })).toMatchObject({ spec: true, escalated: true });
});
