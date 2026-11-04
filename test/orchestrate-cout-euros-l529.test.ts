import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { renderTable } from '../src/orchestrate/table.js';
import { RunStore, newLot, type LotState, type StepState, type WaveState } from '../src/orchestrate/state.js';
import type { PriceGrid } from '../src/perf-config.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { git } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const GRID: PriceGrid = { sonnet: { input: 3, output: 15, cacheRead: 0.3 }, opus: { input: 15, output: 75, cacheRead: 1.5 } };
const wave: WaveState = { id: 'w1', created: '2026-11-02T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1', 'demo:L2'] };

const step = (model: string, t?: { input: number; cacheWrite: number; cacheRead: number; output: number }): StepState =>
  ({ n: 1, kind: 'implement', model, status: 'ok', started: '2026-11-02T10:00:00Z', ended: '2026-11-02T10:05:00Z', ...(t ? { tokens: { ...t, counted: t.input + t.cacheWrite + t.output } } : {}) }) as StepState;
const lot = (id: string, steps: StepState[]): LotState => {
  const l = newLot({ project: 'demo', repo: '/r', lot: id, title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  l.status = 'ready';
  l.steps = steps;
  return l;
};
const tableOf = (lots: LotState[], prices?: PriceGrid | null) => renderTable(wave, lots, { lotCommits: () => [], isAncestor: () => false, ...(prices !== undefined ? { prices } : {}) });

describe('L529 — coût réel en euros au tableau de fin de vague et de --status', () => {
  it('R1 — une colonne € donne le coût de chaque lot (entrée + écriture × prix d\'entrée, sortie, lecture de cache) au prix du modèle de chaque étape', () => {
    // sonnet : (1 M + 0) × 3 + 0,1 M × 15 + 1 M × 0,3 = 4,80 ; opus : 0,2 M × 15 = 3,00
    const l1 = lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 1e6, output: 1e5 })]);
    const l2 = lot('L2', [step('opus', { input: 2e5, cacheWrite: 0, cacheRead: 0, output: 0 })]);
    const out = tableOf([l1, l2], GRID);
    expect(out[0]).toMatch(/\scoût\s/);
    expect(out.find((x) => x.startsWith('demo:L1'))).toContain('4,80');
    expect(out.find((x) => x.startsWith('demo:L2'))).toContain('3,00');
  });

  it('R2 — la ligne de la vague donne le total en euros, somme des lots', () => {
    const l1 = lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 1e6, output: 1e5 })]);
    const l2 = lot('L2', [step('opus', { input: 2e5, cacheWrite: 0, cacheRead: 0, output: 0 })]);
    expect(tableOf([l1, l2], GRID).find((x) => x.startsWith('vague w1'))).toContain('7,80');
  });

  it('R3 — sans grille de prix : ni colonne ni total, le tableau est celui d\'avant', () => {
    const l1 = lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 })]);
    for (const none of [undefined, null]) {
      const out = tableOf([l1], none);
      expect(out.join('\n')).not.toContain('€');
    }
  });

  it('R4 — un modèle sans prix dans la grille donne « n/d » pour son lot, et le total le dit sans l\'additionner', () => {
    const l1 = lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 })]); // 3,00
    const l2 = lot('L2', [step('haiku', { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 })]); // haiku absent de la grille
    const out = tableOf([l1, l2], GRID);
    expect(out.find((x) => x.startsWith('demo:L2'))).toContain('n/d');
    const total = out.find((x) => x.startsWith('vague w1'))!;
    expect(total).toContain('3,00');
    expect(total).toMatch(/n\/d pour 1 lot/);
  });

  it('R5 — une étape locale coûte 0 €, un lot sans étape ni jetons aussi', () => {
    const l1 = lot('L1', [step('local', { input: 5e6, cacheWrite: 0, cacheRead: 0, output: 5e6 })]);
    const l2 = lot('L2', []);
    const out = tableOf([l1, l2], GRID);
    expect(out.find((x) => x.startsWith('demo:L1'))).toContain('0,00');
    expect(out.find((x) => x.startsWith('demo:L2'))).toContain('0,00');
    expect(out.find((x) => x.startsWith('vague w1'))).toContain('0,00');
  });

  it('R5 bis — un lot qui n\'a pas encore de jetons (étape en cours) ne casse pas la somme', () => {
    const l1 = lot('L1', [step('sonnet')]);
    expect(tableOf([l1], GRID).find((x) => x.startsWith('vague w1'))).toContain('0,00');
  });
});

describe('L529 — estimation en euros du --dry-run', () => {
  /** `perf` : le cadence.yaml du dossier de lancement (le parent), comme pour `cadence perf` ; le projet garde le sien. */
  function world(perf: string) {
    const parent = tempDir();
    const dir = join(parent, 'a');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
    plan.add('un lot', '2026-10-01', { estimate: 1 });
    plan.add('un autre lot', '2026-10-01', { estimate: 0.25 });
    plan.setStatus('L1', 'doing', '2026-10-01');
    plan.setStatus('L2', 'doing', '2026-10-01');
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    if (perf) writeFileSync(join(parent, 'cadence.yaml'), perf);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    return parent;
  }
  const dry = async (parent: string, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const i: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T14:00:00') };
    const code = await orchestrate(argv, i, { claude: async () => { throw new Error('rien ne doit être lancé'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR } as unknown as OrchestrateDeps);
    return { code, text: out.join('\n'), err: err.join('\n') };
  };
  const PRICED = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n';

  it('R6 — --dry-run annonce, à côté du budget du lot, son estimation en euros, et le total de la vague', async () => {
    const r = await dry(world(PRICED), ['a:L1', 'a:L2', '--dry-run']);
    try {
      // L1 : 750 000 comptés × (0,9 × 3 + 0,1 × 15) / 1 M = 3,15 ; L2 : 600 000 → 2,52 ; total 5,67
      expect(r.text).toContain('budget du lot : 750000 tokens comptés');
      expect(r.text).toMatch(/estimation du lot : 3,15/);
      expect(r.text).toMatch(/estimation du lot : 2,52/);
      expect(r.text).toMatch(/estimation de la vague : 5,67/);
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R7 — sans perf.prices, la simulation ne parle pas d\'euros', async () => {
    const r = await dry(world(''), ['a:L1', '--dry-run']);
    try {
      expect(r.text).not.toContain('€');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R8 — une grille mal formée n\'interdit pas la simulation : un avertissement, pas d\'euros', async () => {
    const r = await dry(world('perf:\n  prices:\n    sonnet: { input: -1, output: 15, cacheRead: 0.3 }\n'), ['a:L1', '--dry-run']);
    try {
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/perf\.prices/);
      expect(r.text).not.toContain('€');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R9 — un modèle du lot sans prix dans la grille : « n/d » pour ce lot', async () => {
    const r = await dry(world(PRICED), ['a:L1@haiku', '--dry-run']);
    try {
      expect(r.text).toMatch(/a:L1 — estimation du lot : n\/d/);
    } finally {
      removeDryRunBriefs(r.text);
    }
  });
});

describe('L529 — --status', () => {
  it('R10 — --status (tableau compact) affiche le coût réel en euros par lot et pour la vague', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n');
    const store = new RunStore(dir, 'w1');
    store.writeWave(wave);
    store.writeLot(lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 })]));
    const out: string[] = [];
    const i: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-02T14:00:00') };
    process.env.CADENCE_HOME = tempDir();
    await orchestrate(['--status'], i, {} as never);
    const text = out.join('\n');
    expect(text).toContain('3,00');
    expect(text.split('\n').find((x) => x.startsWith('vague w1'))).toContain('3,00');
  });

  it('R11 — une grille mal formée n\'interdit pas --status : un ⚠ et le tableau sans euros', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'perf:\n  prices:\n    sonnet: { input: -1, output: 15, cacheRead: 0.3 }\n');
    const store = new RunStore(dir, 'w1');
    store.writeWave(wave);
    store.writeLot(lot('L1', [step('sonnet', { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 })]));
    const out: string[] = [];
    const i: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-02T14:00:00') };
    process.env.CADENCE_HOME = tempDir();
    await orchestrate(['--status'], i, {} as never);
    const text = out.join('\n');
    expect(text).toMatch(/⚠ coût n\/d : .*perf\.prices/);
    expect(text).toContain('demo:L1');
    expect(text).not.toContain(' €');
  });
});
