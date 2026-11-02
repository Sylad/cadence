import { gitRoot } from '../git.js';
import { candidates, readPriority, type Candidate } from './continue.js';
import { lotKey, lotRepoPaths, type LotState } from './state.js';
import { preflight } from './preflight.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';

export const priorityOf = (args: Args, launch: string) => args.priority ?? readPriority(launch);

/**
 * Tire jusqu'à `n` lots prêts du plan (L147), dans l'ordre de priorité, et les passe au contrôle préalable comme un lot donné :
 * un lot refusé est sauté, sa cause rendue dans `skipped`. `exclude` reçoit chaque lot tiré ou refusé pour lui-même, pas ceux d'un
 * dépôt refusé ni un lot qui ne tient pas dans le reste du budget (il tiendra peut-être au tour suivant).
 * Un tour tire au plus UN lot par dépôt (le pool joue à la suite les lots d'un même dépôt, `--max-sessions` ne servirait à rien) ;
 * les lots écartés pour cela complètent le tour, dans l'ordre, quand aucun autre dépôt n'a de lot prêt.
 */
export async function draw(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string, exclude: Set<string>, remaining: number, n: number): Promise<{ lots: LotState[]; skipped: string[] }> {
  const lots: LotState[] = [];
  const skipped: string[] = [];
  const badRepos = new Set<string>();
  const used = new Set<string>();
  type Pre = Awaited<ReturnType<typeof preflight>>;
  const deferred: { c: Candidate; repo: string; pre?: Pre }[] = [];
  /** `spread` : premier passage, un dépôt déjà pris ce tour renvoie le lot au second ; sinon (second passage) le lot complète le tour. */
  const attempt = async (c: Candidate, repo: string, spread: boolean, checked?: Pre): Promise<void> => {
    const key = lotKey(c.project, c.lot.id);
    if (badRepos.has(repo)) return;
    if (spread && used.has(repo)) return void deferred.push({ c, repo });
    const pre = checked ?? (await preflight(args, [{ project: c.project, projectDir: c.dir, repo, lot: c.lot.id, model: 'sonnet' }], io, deps, launch));
    if (pre.refusals.length) {
      // Un refus propre au lot l'écarte pour la vague ; celui d'un dépôt (arbre sale, orchestration en cours, pre-push) est passager :
      // le dépôt est sauté pour ce tirage seulement, une ligne, et ses lots restent tirables au suivant.
      const own = pre.refusals.filter((r) => r.startsWith(`${key} : `));
      if (own.length) exclude.add(key);
      if (own.length < pre.refusals.length) badRepos.add(repo);
      skipped.push(...pre.refusals.filter((r) => !skipped.includes(r)));
      return;
    }
    const lot = pre.lots[0];
    if (lot.budget! > remaining) return; // pas exclu : le budget du tour suivant le permettra peut-être
    if (spread && lotRepoPaths(lot).some((r) => used.has(r))) return void deferred.push({ c, repo, pre }); // un dépôt voisin déjà pris ce tour
    exclude.add(key);
    remaining -= lot.budget!;
    lots.push(lot);
    for (const r of lotRepoPaths(lot)) used.add(r);
  };
  for (const c of candidates(launch, { priority: priorityOf(args, launch), exclude, remaining })) {
    if (lots.length >= n) break;
    const repo = gitRoot(c.dir);
    if (repo) await attempt(c, repo, true);
  }
  for (const d of deferred) {
    if (lots.length >= n) break;
    await attempt(d.c, d.repo, false, d.pre);
  }
  return { lots, skipped };
}
