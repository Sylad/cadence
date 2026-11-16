// `cadence eval <lot>` (L755, D-26) : rejoue les cas d'éval du plugin que touchent les commits du lot, avant `raf done`.
import { lotWork } from '../audit.js';
import { gitRoot } from '../git.js';
import { filesOfCommits, readEvalEntries, runLotEvals, spawnEval } from '../lot-evals.js';
import { RafError } from '../plan.js';
import type { Ctx } from './context.js';

export function cmdEval(c: Ctx): number {
  const { rest, values, io, root, configPath, loadPlan, need } = c;
  need(1, 'eval <lot> [--dry-run]');
  const plan = loadPlan();
  if (plan.readonly) throw new RafError('cadence eval : le plan est en lecture seule, les commits d\'un lot n\'y sont pas lus');
  if (!plan.lots().some((l) => l.id === rest[0])) throw new RafError(`lot inconnu : ${rest[0]}`);
  const entries = readEvalEntries(configPath);
  if (!entries.length) {
    io.out('cadence eval : cadence.yaml n\'a pas de clé evals (quels cas d\'éval couvrent quels fichiers) — rien à rejouer');
    return 0;
  }
  const repo = gitRoot(root) ?? root;
  const files = filesOfCommits(repo, lotWork(plan, root, rest[0]).map((w) => w.sha));
  return runLotEvals({ root: repo, entries, id: rest[0], files }, { run: spawnEval(io.env), now: io.now(), out: io.out }, !!values['dry-run']);
}
