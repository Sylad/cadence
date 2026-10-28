import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());

describe('L397 — la porte de la vague enregistre l\'arbre contrôlé', () => {
  it('R9 — checks porte le sha et l\'arbre git de ce sha, que verify --gate compare avant de reprendre le verdict', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true', build: 'true' });
    await runLot(c);
    const { head, tree } = c.lot.checks!;
    const dir = c.lot.repo;
    const real = execFileSync('git', ['rev-parse', `${head}^{tree}`], { cwd: dir, encoding: 'utf8' }).trim();
    expect(tree).toBe(real);
  });
});
