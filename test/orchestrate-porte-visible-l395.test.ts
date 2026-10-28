import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { lotSlug, newLot, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { renderTable } from '../src/orchestrate/table.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());

describe('L395 — la porte de tests est une étape visible de l\'état du lot', () => {
  /** Une commande de porte qui range l'état du lot tel qu'il est PENDANT qu'elle tourne (une ligne par appel). */
  const spy = (state: string, log: string, label: string, code = 0) => `printf '${label} ' >> ${log}; tr -d '\\n ' < ${state} >> ${log}; echo >> ${log}; exit ${code}`;
  const seen = (log: string): { label: string; gate?: { label: string; started: string } }[] =>
    readFileSync(log, 'utf8').trim().split('\n').map((line) => {
      const [label, json] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
      return { label, gate: (JSON.parse(json) as LotState).gate };
    });

  it('R1 — pendant le build puis les tests de la porte, l\'état du lot nomme la porte en cours et son départ', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const log = join(tempDir(), 'porte.log');
    const state = join(h.store.dir, `${lotSlug('demo', 'L1')}.json`);
    const c = h.lot('L1', {}, { build: spy(state, log, 'build'), test: spy(state, log, 'tests') });
    await runLot(c);
    const lines = seen(log);
    expect(lines.map((l) => l.label)).toEqual(['build', 'tests']);
    expect(lines.map((l) => l.gate?.label)).toEqual(['build', 'tests']);
    for (const l of lines) expect(Number.isNaN(Date.parse(l.gate!.started))).toBe(false);
  });

  it('R2 — la porte finie, verte ou rouge, l\'état du lot ne la porte plus', async () => {
    const h = harness({ script: { implement: [impl], fix: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')] }))], review: [ok] } });
    const log = join(tempDir(), 'porte.log');
    const state = join(h.store.dir, `${lotSlug('demo', 'L1')}.json`);
    // verte au départ, rouge une fois a.txt écrit par l'implémentation, verte quand la correction a écrit b.txt
    const c = h.lot('L1', {}, { test: `if [ -f a.txt ] && [ ! -f b.txt ]; then echo ' FAIL  test/a.test.ts > rouge'; ${spy(state, log, 'tests', 1)}; else ${spy(state, log, 'tests')}; fi` });
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement', 'fix', 'review']);
    expect(seen(log).length).toBeGreaterThanOrEqual(2);
    expect(c.lot.gate).toBeUndefined();
    expect(JSON.parse(readFileSync(state, 'utf8')).gate).toBeUndefined();
  });
});

describe('L395 — le tableau dit la porte au lieu de « implémentation » sans session', () => {
  const wave = (status: WaveState['status']): WaveState => ({ id: 'w1', created: '2026-10-28T08:30:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status, pid: 1, lots: ['demo:L1'] });
  const lot = (): LotState => {
    const l = newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    l.status = 'implementing';
    l.next = 'review';
    l.gate = { label: 'tests', started: new Date(Date.now() - 5 * 60_000).toISOString() };
    return l;
  };

  it('R3 — vague vivante : l\'état du lot est « porte tests » avec sa durée', () => {
    const row = renderTable(wave('running'), [lot()])[1];
    expect(row).toMatch(/porte tests \(5 min\)/);
    expect(row).not.toContain('implémentation');
  });

  it('R4 — vague arrêtée : une porte restée dans l\'état (processus tué) n\'est pas présentée comme en cours', () => {
    const row = renderTable(wave('interrupted'), [lot()])[1];
    expect(row).not.toContain('porte');
    expect(row).toContain('implémentation');
  });
});
