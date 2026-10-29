import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateIo } from '../src/orchestrate/command.js';
import { newLot, RunStore, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { renderDetail, renderTable } from '../src/orchestrate/table.js';
import { tempDir } from './helpers.js';

const wave: WaveState = { id: 'w1', created: '2026-10-30T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1', 'demo:L2'] };
const lot = (id: string, project = 'demo'): LotState => {
  const l = newLot({ project, repo: '/r', lot: id, title: 't', visible: true, small: false, model: 'sonnet', readOnlyPlan: false });
  l.status = 'ready';
  return l;
};
const loaded = (id = 'L1'): LotState => {
  const l = lot(id);
  l.goal = 'objectif précis';
  l.uxCaptures = '/runs/w1/playwright';
  l.baseline = { sha: 'abcdef1234', verified: true, failures: ['test/a.test.ts > rouge'] } as LotState['baseline'];
  l.choix = ['SQLite plutôt que PostgreSQL'];
  l.hypotheses = ['R3 : champ'];
  l.proposals = ['[mineur code] a.txt:1 — nommage'];
  l.uxVerdict = 'conforme';
  return l;
};

describe('L441 — renderTable compact', () => {
  it('R1 — le tableau compact garde une ligne par lot et le total, sans choix, propositions, captures, base de tests, hypothèses, objectif ni verdict UX', () => {
    const out = renderTable(wave, [loaded()], { compact: true }).join('\n');
    expect(out).toContain('demo:L1');
    expect(out).toContain('vague w1 :');
    for (const gone of ['choix fait', 'proposé :', 'captures Playwright', 'déjà rouge', 'hypothèse de la fiche', 'objectif donné', 'verdict UX pour']) expect(out).not.toContain(gone);
  });

  it('R2 — le tableau compact renvoie à --status --detail et nomme les lots qui ont un détail', () => {
    const out = renderTable(wave, [loaded('L1'), lot('L2')], { compact: true });
    const hint = out.filter((x) => x.includes('--status --detail'));
    expect(hint).toHaveLength(1);
    expect(hint[0]).toContain('demo:L1');
    expect(hint[0]).not.toContain('demo:L2');
  });

  it('R3 — sans lot détaillé, aucune ligne de renvoi', () => {
    expect(renderTable(wave, [lot('L1')], { compact: true }).join('\n')).not.toContain('--detail');
  });

  it('R4 — les signaux restent au tableau compact : avertissement et escalade', () => {
    const l = lot('L1');
    l.warnings = ['dépôt sale'];
    l.escalation = { model: 'opus', stage: 'fix' };
    const out = renderTable(wave, [l], { compact: true }).join('\n');
    expect(out).toContain('demo:L1 — ⚠ dépôt sale');
    expect(out).toContain('demo:L1 — escalade opus');
  });

  it('R5 — le tableau complet (fin de vague) garde tout le détail et ne renvoie à rien', () => {
    const out = renderTable(wave, [loaded()]).join('\n');
    for (const kept of ['choix fait', 'proposé :', 'captures Playwright', 'déjà rouge', 'hypothèse de la fiche', 'objectif donné', 'verdict UX pour']) expect(out).toContain(kept);
    expect(out).not.toContain('--status --detail');
  });
});

describe('L441 — renderDetail', () => {
  it('R6 — donne les lignes de détail du lot demandé, pas celles des autres', () => {
    const other = loaded('L2');
    other.choix = ['un autre choix'];
    const out = renderDetail([loaded('L1'), other], 'demo:L1').join('\n');
    expect(out).toContain('choix fait : SQLite plutôt que PostgreSQL');
    expect(out).toContain('captures Playwright : /runs/w1/playwright');
    expect(out).not.toContain('un autre choix');
  });

  it('R7 — le nom seul du lot suffit quand il est unique', () => {
    expect(renderDetail([loaded('L1'), lot('L2')], 'L1').join('\n')).toContain('choix fait');
  });

  it('R8 — un lot inconnu ou ambigu est refusé en nommant les lots de la vague', () => {
    expect(() => renderDetail([loaded('L1')], 'L9')).toThrow(/inconnu.*demo:L1/);
    expect(() => renderDetail([lot('L1', 'a'), lot('L1', 'b')], 'L1')).toThrow(/ambigu.*a:L1.*b:L1/);
    expect(() => renderDetail([lot('L1')], 'autre:L1')).toThrow(/inconnu/);
  });

  it('R9 — un lot sans détail le dit au lieu de ne rien imprimer', () => {
    expect(renderDetail([lot('L1')], 'demo:L1')).toEqual([expect.stringContaining('aucun détail')]);
  });
});

describe('L441 — cadence orchestrate --status --detail', () => {
  const home = process.env.CADENCE_HOME;
  beforeEach(() => {
    process.env.CADENCE_HOME = tempDir();
  });
  afterEach(() => {
    process.env.CADENCE_HOME = home;
  });
  const run = async (dir: string, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const i: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-10-30' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-30T14:00:00') };
    let error: unknown;
    let code: number | undefined;
    try {
      code = await orchestrate(argv, i, {} as never);
    } catch (e) {
      error = e;
    }
    return { code, out: out.join('\n'), err: err.join('\n'), error: error as Error | undefined };
  };
  const stored = () => {
    const dir = tempDir();
    const store = new RunStore(dir, 'w1');
    store.writeWave(wave);
    store.writeLot(loaded('L1'));
    store.writeLot(lot('L2'));
    return dir;
  };

  it('R10 — --status est compact : le détail n\'y est pas, le renvoi y est', async () => {
    const r = await run(stored(), ['--status']);
    expect(r.out).toContain('demo:L1');
    expect(r.out).not.toContain('choix fait');
    expect(r.out).toContain('--status --detail');
  });

  it('R11 — --status --detail <lot> imprime le détail du lot, lu dans la vague', async () => {
    const r = await run(stored(), ['--status', '--detail', 'demo:L1']);
    expect(r.out).toContain('choix fait : SQLite plutôt que PostgreSQL');
    expect(r.out).not.toContain('vague w1 :');
  });

  it('R12 — --status <vague> --detail <lot> vise la vague nommée', async () => {
    const r = await run(stored(), ['--status', 'w1', '--detail', 'L1']);
    expect(r.out).toContain('proposé : [mineur code]');
  });

  it('R13 — lot inconnu : refus avec la liste des lots', async () => {
    const r = await run(stored(), ['--status', '--detail', 'demo:L9']);
    expect(r.error?.message).toMatch(/inconnu.*demo:L1.*demo:L2/);
  });

  it('R14 — --detail sans valeur, sans --status ou avec --watch est refusé', async () => {
    expect(() => parseOrchestrateArgs(['--status', '--detail'])).toThrow(/attend une valeur/);
    expect((await run(stored(), ['--detail', 'L1'])).error?.message).toMatch(/--detail s'utilise avec --status/);
    expect((await run(stored(), ['--status', '--watch', '--detail', 'L1'])).error?.message).toMatch(/--watch/);
  });

  it('R15 — le tableau de --status --watch est compact aussi', async () => {
    const dir = stored();
    const out: string[] = [];
    const i: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-10-30' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-30T14:00:00') };
    expect(await orchestrate(['--status', '--watch'], i, {} as never)).toBe(0);
    expect(out.join('\n')).not.toContain('choix fait');
  });
});
