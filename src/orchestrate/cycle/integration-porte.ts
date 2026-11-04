import { type Constat } from '../state.js';
import { type LotCtx, save } from './ctx.js';
import { git } from '../worktree.js';
import { gateLabel } from '../gate-parts.js';
import { integratedChecks } from './checks.js';

/** L.checks porte déjà une suite complète verte pour cet arbre (L590, R5) : même arbre, un run « tests » qui n'est pas ciblé, de la commande de la porte, code 0. */
function fullSuiteGreen(c: LotCtx, tree: string): boolean {
  const k = c.lot.checks;
  const test = c.config.test;
  return !!test && k?.tree === tree && k.runs.some((r) => r.label === 'tests' && r.portee !== 'ciblee' && r.command === gateLabel(test) && r.code === 0);
}

/**
 * Les contrôles du sommet `tip` du lot, dans son worktree, avant que la branche du dépôt ne bouge (R7) : la suite complète jouée une fois par sommet, rebasé ou non (L590, R5, les portes d'écriture ne jouent que les tests liés),
 * sauf si l.checks en porte déjà une verte pour cet arbre. Sans orchestrate.test et sans rebase (`tip` = `reviewed`, le commit relu), rien n'est rejoué : le build l'a été au commit relu. Rend les constats rouges ; l.checks est celui du sommet.
 */
export async function integrationChecks(c: LotCtx, key: string, dir: string, tip: string, reviewed: string): Promise<Constat[]> {
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  if ((tip === reviewed && !c.config.test) || fullSuiteGreen(c, tree)) return [];
  const { red, runs } = await integratedChecks(c, key);
  c.lot.checks = runs.length ? { head: tip, tree, runs } : undefined;
  save(c);
  return red;
}
