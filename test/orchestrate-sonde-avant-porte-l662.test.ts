import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (1) : la sonde joue avant la première porte du programme, une seule porte entre l'écriture et la revue.
afterEach(cleanupTempDirs);

const GATE = { code: ['*.ts', '!*.spec.ts'], tests: ['*.spec.ts'], except: [], threshold: 1 };
const raw = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []);
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const ok: Handler = () => claudeOut(reviewReport());
/** Une écriture qui s'inscrit au journal des portes (« IMPLEMENT »), pour lire l'ordre avec les portes. */
const impl = (log: string, file = 'a.ts', over: Record<string, unknown> = {}): Handler => (call) => {
  const sha = commitFile(call.opts.cwd, file, `feat(L1): ${file}`);
  return claudeOut(workReport({ commits: [sha], ...over }));
};
const probe = (log: string, file = 'p.spec.ts'): Handler => (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, file, `probe(L1): ${file}`)] }));
const logOf = () => join(tempDir(), 'portes.log');
/** La porte : une ligne « GATE » par jeu, rouge tant que `fail` existe dans le dossier joué. */
const gate = (log: string) => `echo GATE >> ${log}`;

describe('L662 R1 — la sonde joue avant la porte, une seule porte avant la revue', () => {
  it('R1 — implement, probe, une seule porte (jouée après la sonde, sur ses commits), puis la revue', async () => {
    const log = logOf();
    const h = harness({ script: { implement: [impl(log)], probe: [probe(log)], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: gate(log) });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(raw(log).filter((x) => x === 'GATE')).toHaveLength(1);
    expect(c.lot.checks?.runs.some((r) => r.label === 'tests' && r.code === 0)).toBe(true);
  });

  it('R1 — une sonde sans commit : la porte est jouée quand même, une seule fois', async () => {
    const log = logOf();
    const h = harness({ script: { implement: [impl(log)], probe: [(): ReturnType<Handler> => claudeOut(probeReport())], review: [ok] } });
    await runLot(h.lot('L1', {}, { probe: true, test: gate(log) }));
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(raw(log)).toEqual(['GATE']);
  });

  it('R1 — la porte « code sans test » lit les tests de la sonde : code seul à l\'écriture, test écrit par la sonde, aucune correction', async () => {
    const h = harness({ script: { implement: [impl('', 'a.ts')], probe: [probe('', 'a.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
  });

  it('R1 — le code reste sans test après la sonde : la porte « code sans test » envoie le lot en correction', async () => {
    const h = harness({ script: { implement: [impl('', 'a.ts')], probe: [(): ReturnType<Handler> => claudeOut(probeReport())], fix: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.spec.ts', 'test(L1): a.spec.ts')] }))], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
  });

  it('R1 — un rouge de la porte que la sonde n\'a pas causé (sonde sans commit) part en correction comme tests rouges, pas comme constat de la sonde', async () => {
    const log = logOf();
    const red = `echo GATE >> ${log}; [ "$(wc -l < ${log})" -gt 1 ]`;
    const h = harness({ script: { implement: [impl(log)], probe: [(): ReturnType<Handler> => claudeOut(probeReport())], fix: [impl(log, 'b.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: red });
    await runLot(c);
    expect(kinds(h).slice(0, 3)).toEqual(['implement', 'probe', 'fix']);
    const fixBrief = h.calls.find((x) => x.kind === 'fix')!.brief;
    expect(fixBrief).toContain('en échec');
    expect(fixBrief).not.toContain('sonde de cas limites :');
  });

  it('R2 — la session annonce un build rouge : la porte juge l\'annonce avant toute sonde (aucune sonde entre l\'écriture et la correction)', async () => {
    const h = harness({ script: { implement: [impl('', 'a.ts', { build: { commande: 'npm run build', resultat: 'KO', vert: false } })], fix: [impl('', 'b.ts')], probe: [probe('')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(c.lot.warnings.some((w) => w.startsWith('sonde de cas limites non jouée'))).toBe(true);
  });

  it('R3 — voie express : pas de sonde, la porte puis la conclusion', async () => {
    const log = logOf();
    const h = harness({ script: { implement: [impl(log)], probe: [probe(log)], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: gate(log) });
    c.lot.express = true;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement']);
    expect(raw(log)).toEqual(['GATE']);
  });
});
