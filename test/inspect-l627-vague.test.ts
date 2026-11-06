import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, reviewReport } from './orchestrate-harness.js';
import { fake, meeting, run, setup, store, WAVE, writes } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L627 — les branchements du comportement changé : le tableau de fin de vague (execute, resume) et le journal des portes (checks, ligne de base).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});
const journalOf = (parent: string) => readFileSync(join(store(parent).dir, 'journal.log'), 'utf8');

describe('cadence inspect (L627) — branchements', () => {
  it('R7 — une vague qui se termine imprime le tableau d\'inspection, et le journal note le début et la fin de la porte de chaque lot', async () => {
    const { parent } = setup(undefined, 'worktrees: true\ntest: "true"\n');
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake());
    expect(r.out).toContain(`inspection de la vague ${WAVE} : 2 lot(s)`);
    const journal = journalOf(parent);
    for (const lot of ['a:L1', 'a:L2']) {
      expect(journal).toMatch(new RegExp(`${lot} · porte : début\\n`));
      expect(journal).toMatch(new RegExp(`${lot} · porte : fin\\n`));
    }
  });

  it('R7 — la porte de la ligne de base écrit son début et sa fin, avec la ligne de base', async () => {
    const { parent } = setup([{ title: 'un' }], "worktrees: true\ntest: \"echo ' FAIL  a.test.ts > mon test'; exit 1\"\n");
    await run(parent, ['a:L1', '--max-sessions', '1'], fake());
    const journal = journalOf(parent);
    expect(journal).toMatch(/a:L1 · porte : début \(ligne de base [0-9a-f]{7}\)\n/);
    expect(journal).toMatch(/a:L1 · porte : fin \(ligne de base [0-9a-f]{7}\)\n/);
  });

  it('R7 — la reprise d\'une vague qui se termine imprime aussi le tableau d\'inspection', async () => {
    const { parent } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--budget', '2000'], fake({ implement: writes(meeting(2)) }));
    const again = await run(parent, ['--resume', WAVE, '--budget', '5M'], fake({ review: async () => claudeOut(reviewReport()) }));
    expect(again.out).toContain(`inspection de la vague ${WAVE} : 2 lot(s)`);
  });
});
