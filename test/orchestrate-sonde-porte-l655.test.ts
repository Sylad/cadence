import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { gateReaches } from '../src/testgate.js';
import { claudeOut, commitFile, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const root = join(import.meta.dirname, '..');
const GATE = { code: ['*.ts', '!*.spec.ts'], tests: ['*.spec.ts'], except: ['types.ts'], threshold: 1 };
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const probe: Handler = (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, 'p.spec.ts', 'probe(L1): p.spec.ts')] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const NOT_REACHED = 'sonde de cas limites non jouée : le diff du lot ne touche aucun fichier de code que la porte (orchestrate.testGate.code) atteint';

describe('la sonde ne joue pas sur un diff que la porte n\'atteint pas (L655, issue #49)', () => {
  it('R1 — gateReaches : un fichier de code hors exception, jamais un test ni une exception, ni rien', () => {
    expect(gateReaches(GATE, new Set(['a.ts']))).toBe(true);
    expect(gateReaches(GATE, new Set())).toBe(false);
    expect(gateReaches(GATE, new Set(['style.css', 'run.sh']))).toBe(false);
    expect(gateReaches(GATE, new Set(['types.ts']))).toBe(false);
    expect(gateReaches(GATE, new Set(['a.spec.ts']))).toBe(false);
    expect(gateReaches(GATE, new Set(['style.css', 'b.ts']))).toBe(true);
  });

  it('R2 — un lot CSS seul : 0 sonde, un warning qui dit pourquoi, la revue part', async () => {
    const h = harness({ script: { implement: [impl('app.css')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings).toContain(NOT_REACHED);
  });

  it('R2 — un lot de banc seul (script hors des motifs de code) : 0 sonde', async () => {
    const h = harness({ script: { implement: [impl('run.sh')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings).toContain(NOT_REACHED);
  });

  it('R2 — un fichier de code dispensé par `except` seul : 0 sonde', async () => {
    const h = harness({ script: { implement: [impl('types.ts')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R3 — un diff qui touche du code (avec son test) : la sonde joue', async () => {
    const h = harness({ script: { implement: [impl('a.ts', 'a.spec.ts')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings).not.toContain(NOT_REACHED);
  });

  it('R3 — code et CSS ensemble : la sonde joue', async () => {
    const h = harness({ script: { implement: [impl('app.css', 'a.ts', 'a.spec.ts')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
  });

  it('R4 — sans orchestrate.testGate, rien ne dit ce que la porte atteint : la sonde joue comme avant', async () => {
    const h = harness({ script: { implement: [impl('app.css')], probe: [probe], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
  });

  it('R5 — le brief et la documentation de l\'étape disent la condition', () => {
    expect(readFileSync(join(root, 'docs/orchestrate-gate.md'), 'utf8')).toContain('does not reach');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('L655');
  });
});
