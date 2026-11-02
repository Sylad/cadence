import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, reviewReport } from './orchestrate-harness.js';
import { fake, meeting, run, setup, WAVE, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L529 — le tableau imprimé à la fin d'une vague lancée, puis à la fin d'une reprise, porte la colonne € et le total, lus dans le cadence.yaml du dossier de lancement.
const PRICES = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n    opus: { input: 15, output: 75, cacheRead: 1.5 }\n    haiku: { input: 1, output: 5, cacheRead: 0.1 }\n';
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Le tableau : l'en-tête (colonne €), une ligne par lot (`a:L1  ready …`) et la ligne de la vague. */
const tableRows = (text: string) => text.split('\n').filter((x) => /^a:L\d+  \S/.test(x));

describe('L529 — coût en euros au tableau de fin de vague et de reprise', () => {
  it('R12 — la fin d\'une vague lancée imprime la colonne € de chaque lot et le total, quand le dossier de lancement a une grille', async () => {
    const { parent } = setup();
    writeFileSync(join(parent, 'cadence.yaml'), PRICES);
    const r = await run(parent, ['a:L1', 'a:L2'], fake());
    expect(r.code).toBe(0);
    const rows = tableRows(r.out);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(/\d+,\d\d €/);
    expect(r.out).toMatch(/^vague .*\d+,\d\d €/m);
  });

  it('R12 bis — sans grille au dossier de lancement, la fin de vague n\'a pas d\'euros', async () => {
    const { parent } = setup();
    const r = await run(parent, ['a:L1', 'a:L2'], fake());
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('€');
  });

  it('R13 — la fin d\'une reprise imprime aussi la colonne € et le total', async () => {
    const { parent } = setup();
    writeFileSync(join(parent, 'cadence.yaml'), PRICES);
    const first = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
    expect(first.code).toBe(3);
    const g = fake({ review: async () => claudeOut(reviewReport()) });
    const again = await run(parent, ['--resume', WAVE, '--budget', '5M'], g);
    expect(again.code).toBe(0);
    const rows = tableRows(again.out);
    for (const row of rows) expect(row).toMatch(/\d+,\d\d €/);
    expect(rows).toHaveLength(2);
    expect(again.out).toMatch(/^vague .*\d+,\d\d €/m);
  });

  it('R13 bis — une reprise dont --drop retire le seul lot à rejouer (rien à relancer) imprime aussi la colonne € et le total', async () => {
    const { parent } = setup();
    writeFileSync(join(parent, 'cadence.yaml'), PRICES);
    const first = await run(parent, ['a:L1', '--budget', '1000'], fake({ implement: writes(meeting(1)) }));
    expect(first.code).toBe(3);
    const g = fake();
    const again = await run(parent, ['--resume', WAVE, '--drop', 'a:L1', '--budget', '5M'], g);
    expect(again.code).toBe(1);
    expect(g.calls).toHaveLength(0); // aucune session rejouée : le tableau vient de la branche de reprise sans lot vivant
    const rows = tableRows(again.out);
    expect(rows).toHaveLength(1);
    for (const row of rows) expect(row).toMatch(/\d+,\d\d €/);
    expect(again.out).toMatch(/^vague .*\d+,\d\d €/m);
  });
});
