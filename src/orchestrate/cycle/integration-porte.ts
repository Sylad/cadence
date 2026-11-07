import { type Constat } from '../state.js';
import { type LotCtx, save } from './ctx.js';
import { git } from '../worktree.js';
import { gateLabel } from '../gate-parts.js';
import { integratedChecks } from './checks.js';
import { relative } from 'node:path';
import { mergeBase } from '../integrate.js';
import { planChain } from '../../gate-record.js';
import { crossablePlan } from '../../verify-gate-plan.js';

/** L.checks porte déjà une suite complète verte pour cet arbre (L590, R5) : même arbre, un run « tests » qui n'est pas ciblé, de la commande de la porte, code 0. Un verdict repris (L662) n'a pas tourné à cet arbre : une nouvelle intégration le rejoue. */
export function fullSuiteGreen(c: Pick<LotCtx, 'lot' | 'config'>, tree: string): boolean {
  const k = c.lot.checks;
  const test = c.config.test;
  return !!test && k?.tree === tree && !k.reprise && k.runs.some((r) => r.label === 'tests' && r.portee !== 'ciblee' && r.command === gateLabel(test) && r.code === 0);
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

/**
 * Le delta de main `from..to` (ce que la branche du dépôt a gagné depuis le dernier rebase) est-il celui que `verify --gate` traverserait lui-même (L662) ? Même règle, mêmes fonctions, jamais un second critère :
 * le plan est traversable (`crossablePlan`, L450/L482 : aucun test ne le lit, ni déclaré par `gate.readsPlan` ni deviné d'après le code qui cite son chemin au sommet `to`), et chaque commit de `to` à `from` ne change que
 * ce fichier du plan et n'a qu'un parent (`planChain`, L432 : la chaîne des commits de plan seul sous `to` atteint `from`). Ni la page Gantt, ni `plan.files`, ni ce que `plan.onWrite` produit, ni l'archive ne comptent :
 * `verify --gate` ne les traverse pas (des tests les lisent, L482). Un delta vide (`from` = `to`) est traversable ; un delta illisible ou plus long que `planChain` ne l'est pas (le doute rejoue la porte).
 */
export function deltaCrossable(dir: string, from: string, to: string, planFile: string, declared: unknown): boolean {
  const plan = crossablePlan(dir, to, planFile, declared);
  return plan !== undefined && planChain(dir, to, plan).includes(from);
}

/** Le fichier du plan du projet, relatif à son dépôt (chemins git) ; null quand le plan ne se lit pas (la porte est alors rejouée). */
function planFileOf(c: LotCtx): string | null {
  try {
    return relative(c.lot.repo, c.loadPlan().path).split('\\').join('/');
  } catch {
    return null;
  }
}

/** Le sommet de main sur lequel la porte d'intégration a été jouée verte au tour d'avant (L662) et l'arbre du lot à ce tour, gardés d'un tour à l'autre de la boucle de rebase. */
export interface GreenOnto {
  onto?: string;
  tree?: string;
}

/** La verte du tour d'avant vaut pour le sommet rebasé (L662) : l.checks est porté sur `tip` et son arbre, pour que `verify --gate` la retrouve au sha intégré, et garde ce qui a vraiment joué (le premier tour, si plusieurs tours de suite sautent la porte) et le delta de plan seul traversé. */
function carryGreen(c: LotCtx, tip: string, tree: string, delta: { from: string; to: string }): void {
  const k = c.lot.checks!;
  const origin = k.reprise ?? { head: k.head, tree: k.tree, from: delta.from };
  c.lot.checks = { ...k, head: tip, tree, reprise: { ...origin, to: delta.to } };
  save(c);
}

/**
 * La porte d'intégration d'un tour (L662) : un tour rejoué (main a avancé) ne saute la porte que si ce que main a gagné depuis le sommet où le tour d'avant l'a jouée verte (`green.onto`) est un delta que `verify --gate`
 * traverserait lui-même (`deltaCrossable`, lu sur `onto..HEAD` : des commits du seul fichier du plan, qu'aucun test ne lit), et si l.checks est encore l'enregistrement du tour d'avant (`green.tree`) ;
 * la verte du tour d'avant reste alors celle de ce sommet (`carryGreen`), et le journal le dit. Tout autre delta rejoue la porte. On ne peut pas prévenir que main avance, seulement son effet.
 * Rend les constats rouges ; `green` devient le sommet de main sur lequel le lot est rebasé et son arbre (un rouge rend le lot, la valeur ne sert alors plus).
 */
export async function integrationGate(c: LotCtx, key: string, t: { dir: string; base: string }, at: { tip: string; reviewed: string; green: GreenOnto }): Promise<Constat[]> {
  const onto = mergeBase(t.dir, 'HEAD', t.base);
  const tree = git(t.dir, 'rev-parse', 'HEAD^{tree}');
  const { onto: before, tree: greenTree } = at.green;
  const planFile = before ? planFileOf(c) : null;
  at.green.onto = onto;
  at.green.tree = tree;
  if (before && planFile && c.lot.checks?.tree === greenTree && deltaCrossable(t.dir, before, onto, planFile, c.config.gate?.readsPlan)) {
    carryGreen(c, at.tip, tree, { from: before, to: onto });
    c.wave.log(`${key} porte d'intégration non rejouée : ce que ${t.base} a gagné depuis ${before.slice(0, 7)} ne change que le plan (${planFile} seul, qu'aucun test ne lit : verify --gate le traverserait)`);
    return [];
  }
  return integrationChecks(c, key, t.dir, at.tip, at.reviewed);
}
