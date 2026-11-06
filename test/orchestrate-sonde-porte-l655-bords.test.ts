import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { gateReaches } from '../src/testgate.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const GATE = { code: ['src/**/*.ts'], tests: ['test/**'], except: [], threshold: 1 };
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const ok: Handler = () => claudeOut(reviewReport());

describe('bords de la sonde hors porte (L655)', () => {
  it('gateReaches : except vide et motif imbriqué, un test sous src/ n\'est jamais atteint', () => {
    expect(gateReaches(GATE, new Set(['src/a/b.ts']))).toBe(true);
    expect(gateReaches(GATE, new Set(['test/x.ts']))).toBe(false);
    expect(gateReaches({ ...GATE, tests: ['**/*.spec.ts'] }, new Set(['src/a.spec.ts']))).toBe(false);
  });

  it('sonde désactivée : aucun warning « non jouée » même sur du CSS seul', async () => {
    const h = harness({ script: { implement: [impl('app.css')], review: [ok] } });
    const c = h.lot('L1', {}, { testGate: GATE });
    await runLot(c);
    expect(c.lot.warnings.filter((w) => w.includes('sonde de cas limites non jouée'))).toEqual([]);
    expect(h.calls.map((x) => x.kind)).not.toContain('probe');
  });

  it('un lot CSS seul : le warning n\'est écrit qu\'une fois', async () => {
    const h = harness({ script: { implement: [impl('app.css')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(c.lot.warnings.filter((w) => w.includes('sonde de cas limites non jouée')).length).toBe(1);
  });
});
