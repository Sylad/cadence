import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, git, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, sharedFile, store, subjects } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L558 — ressources par chemins, de bout en bout dans une vague (A2) : l'attente à l'intégration et le message de conflit, avec de vrais worktrees et des sessions simulées.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Attend (au plus 20 s) qu'une condition soit vraie. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await sleep(20);
}
const journal = (parent: string) => {
  const f = join(store(parent).dir, 'journal.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

describe('A2 — l\'étape integrate d\'une vague réelle', () => {
  it('R8 — ancien ayant déjà un commit sur src/, tardif fini en premier : il attend puis s\'intègre (vague réelle, ligne de journal)', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
    writeFileSync(join(parent, 'cadence.yaml'), 'resources:\n  src: { paths: [src/] }\n');
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        const file = lot === 'L1' ? 'src/a.txt' : 'src/b.txt';
        // le lot L1 commite sous src/ puis reste « implementing » jusqu'à ce que L2, fini en premier, ait différé son intégration
        const commit = () => {
          mkdirSync(join(cwd, 'src'), { recursive: true });
          writeFileSync(join(cwd, file), `${lot}\n`);
          git(cwd, 'add', '--', file);
          git(cwd, 'commit', '-q', '-m', `feat(${lot}): ${file}`);
          return { sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): ${file}` };
        };
        const c = commit();
        if (lot === 'L1') await until(() => journal(parent).includes('intégration différée'));
        return claudeOut(workReport({ commits: [c] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(r.out).toContain('a:L2 intégration différée : a:L1 touche la ressource « src » (src)');
    // L1 s'est intégré avant L2 : son commit de travail est plus profond dans main
    const s = subjects(repo);
    expect(s.indexOf('feat(L2): src/b.txt')).toBeLessThan(s.indexOf('feat(L1): src/a.txt'));
  }, 60_000);

  it('R11 — conflit sur un fichier d\'une ressource : le message garde le texte d\'avant et nomme la ressource, le fichier et le commit de base (vague réelle)', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    writeFileSync(join(parent, 'cadence.yaml'), 'resources:\n  partage: { paths: [./shared.txt] }\n');
    const f = fake({ implement: sharedFile(join(parent, 'a')) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const a = store(parent).readLot('a', 'L1')!;
    expect(a.status).toBe('handed-back');
    expect(a.outcome).toMatch(/^intégration impossible : conflit en rebasant cadence\/2026-10-04-1412\/a--L1 sur main \(fichiers : shared\.txt\) ; ressource « partage » : shared\.txt modifié dans main depuis le départ du lot par [0-9a-f]{7} feat\(L2\): travail ; worktree conservé : .*worktrees\/a--L1$/);
  }, 60_000);
});
