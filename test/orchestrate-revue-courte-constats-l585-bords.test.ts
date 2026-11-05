import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { WAVE, fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L585 — bords : les constats d'un refus de revue courte ne survivent pas à une intégration reprise qui réussit.
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

describe('L585 — bords de la revue courte', () => {
  it('refus puis --resume --integrate dont la revue courte passe : le lot est prêt et ne garde plus les constats du refus', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', { 'f.txt': lines(12) });
    let round = 0;
    const f = fake({
      implement: async (cwd, brief) => {
        await meeting(2)();
        const lot = lotOf(brief);
        return edit(cwd, lot === 'L1' ? 4 : 7, lot);
      },
      'review-small': async () => {
        round++;
        return claudeOut(round === 1 ? reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'f.txt', ligne: 7, texte: 'perdu' }], verdict: 'non conforme' }) : reviewReport({ verdict: 'ok' }));
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const lot = f.calls.find((c) => c.kind === 'review-small')!.lot;
    expect(store(parent).readLot('a', lot)!.status).toBe('handed-back');
    await run(parent, ['--resume', WAVE, '--integrate', `a:${lot}`], f);
    const l = store(parent).readLot('a', lot)!;
    expect(l.status).toBe('ready');
    expect(l.constats ?? []).toEqual([]);
  });
});
