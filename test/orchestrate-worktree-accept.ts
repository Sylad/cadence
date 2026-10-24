import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { lotBranch, lotTreeDir } from '../src/orchestrate/worktree.js';
import { ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { tempDir } from './helpers.js';

/**
 * Un lot à écran dont l'étape accept pose un scellé puis `vert: true`, joué dans un worktree (L279, R21). Le dépôt du lead est salie juste avant l'intégration :
 * le lot est rendu à cette étape et ses commits d'acceptation sont encore sur sa seule branche.
 */
export async function acceptWave() {
  const accept: Handler = (call) => {
    ecritAcceptation(call.opts.cwd, { sansFiche: true });
    return claudeOut(acceptReport());
  };
  const green: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }));
  const h = harness({
    lots: [{ title: 'Un écran', screen: 'page' }],
    script: {
      accept: [accept],
      implement: [green],
      review: [
        () => {
          appendFileSync(join(h.repo, 'docs/plan/raf.yaml'), '# le lead édite son plan\n'); // fichier suivi modifié dans le dépôt du lead
          return claudeOut(reviewReport());
        },
      ],
      ux: [() => claudeOut(reviewReport())],
    },
  });
  ecrit(h.repo);
  const c = h.lot('L1', { visible: true, screen: 'page' }, { accept: 'test -f done.flag', test: 'true' });
  const waveDir = tempDir();
  c.tree = { dir: lotTreeDir(waveDir, 'demo', 'L1'), branch: lotBranch('w1', 'demo', 'L1'), base: 'main', active: false };
  await runLot(c);
  return {
    status: c.lot.status,
    next: c.lot.next,
    branchLog: git(h.repo, 'log', '--format=%s', c.tree.branch),
    mainLog: git(h.repo, 'log', '--format=%s', 'main'),
  };
}
