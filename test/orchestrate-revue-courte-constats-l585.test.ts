import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L585 — la revue courte du diff rebasé qui refuse l'intégration porte ses constats dans l'état du lot et au journal.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
const edit = (cwd: string, n: number, lot: string) => {
  writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
  git(cwd, 'add', '--', 'f.txt');
  git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
  return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
};

async function refusedBy(report: Record<string, unknown>) {
  const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      return edit(cwd, lot === 'L1' ? 4 : 7, lot);
    },
    'review-small': async () => claudeOut(report),
  });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  const lot = f.calls.find((c) => c.kind === 'review-small')!.lot;
  return { r, l: store(parent).readLot('a', lot)!, lot };
}

describe('L585 — constats de la revue courte', () => {
  it('R1 — un refus de la revue courte garde ses constats bloquants et majeurs dans l\'état du lot, sans les mineurs', async () => {
    const { l } = await refusedBy(
      reviewReport({
        bloquants: 1,
        majeurs: 1,
        mineurs: 1,
        constats: [
          { gravite: 'majeur', fichier: 'f.txt', ligne: 7, texte: 'ligne perdue au rebase' },
          { gravite: 'bloquant', texte: 'conflit mal résolu' },
          { gravite: 'mineur', fichier: 'f.txt', ligne: 1, texte: 'nom' },
        ],
        verdict: 'non conforme',
      }),
    );
    expect(l.status).toBe('handed-back');
    expect(l.outcome).toContain('2 constat(s) bloquant(s) ou majeur(s)');
    expect(l.constats).toEqual([
      { source: 'code', gravite: 'majeur', fichier: 'f.txt', ligne: 7, texte: 'ligne perdue au rebase' },
      { source: 'code', gravite: 'bloquant', fichier: undefined, ligne: undefined, texte: 'conflit mal résolu' },
    ]);
  });
  it('R2 — une ligne de journal par constat porté, avec sa gravité, son emplacement et son texte', async () => {
    const { r, lot } = await refusedBy(
      reviewReport({ majeurs: 1, bloquants: 1, constats: [{ gravite: 'majeur', fichier: 'f.txt', ligne: 7, texte: 'ligne perdue' }, { gravite: 'bloquant', texte: 'sans emplacement' }], verdict: 'non conforme' }),
    );
    expect(r.out).toContain(`a:${lot} · revue courte : majeur f.txt:7 — ligne perdue`);
    expect(r.out).toContain(`a:${lot} · revue courte : bloquant sans emplacement`);
  });
  it('R3 — rapport illisible : le refus ne porte aucun constat (et ne plante pas)', async () => {
    const { l } = await refusedBy({ nimportequoi: true });
    expect(l.outcome).toContain('rapport illisible');
    expect(l.constats ?? []).toEqual([]);
  });
  it('R4 — revue courte conforme : aucun constat, aucune ligne « revue courte : »', async () => {
    const { r, l } = await refusedBy(reviewReport({ verdict: 'rebase sans dégât' }));
    expect(l.status).toBe('ready');
    expect(l.constats ?? []).toEqual([]);
    expect(r.out).not.toContain('revue courte : ');
  });
});
