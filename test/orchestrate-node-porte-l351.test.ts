import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());

/** Un dossier de liens `node-bin` dont le node répond `v24.0.0` : la porte ne passe que si elle le voit en tête du PATH. */
function fakeLink(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'node-bin', 'v24.0.0'), { recursive: true });
  const node = join(dir, 'node-bin', 'v24.0.0', 'node');
  writeFileSync(node, '#!/bin/sh\necho v24.0.0\n');
  chmodSync(node, 0o755);
  return join(dir, 'node-bin', 'v24.0.0');
}
const WANTS_24 = 'test "$(node --version)" = v24.0.0 || { echo " FAIL  porte > node $(node --version)"; exit 1; }';

describe('la porte tourne avec le Node du .nvmrc (L351, issue #17)', () => {
  it('R1 — orchestrate.test et orchestrate.build voient le lien node-bin du lot en tête du PATH', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const link = fakeLink();
    const c = h.lot('L1', { node: { version: 'v24.0.0', wanted: '24', bin: '/nope', link } }, { test: WANTS_24, build: WANTS_24 });
    await runLot(c);
    expect(c.lot.checks!.runs.map((r) => [r.label, r.code])).toEqual([['build', 0], ['tests', 0]]);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement', 'review']);
  });

  it('R2 — la ligne de base joue aussi sous ce Node : le départ n\'est pas rougi par le Node par défaut', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const link = fakeLink();
    const c = h.lot('L1', { node: { version: 'v24.0.0', wanted: '24', bin: '/nope', link } }, { test: `${WANTS_24}; echo ' FAIL  ancien > cas'; exit 1`, build: WANTS_24 });
    await runLot(c);
    expect(c.lot.baseline?.failures).toEqual(['ancien > cas']);
  });

  it('R3 — sans .nvmrc (pas de lien), le PATH de la porte est inchangé', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: `test "$PATH" = "${process.env.PATH}"` });
    await runLot(c);
    expect(c.lot.checks!.runs.map((r) => [r.label, r.code])).toEqual([['tests', 0]]);
  });
});
