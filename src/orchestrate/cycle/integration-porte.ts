import { type Constat } from '../state.js';
import { type LotCtx, save } from './ctx.js';
import { git, planFileSet } from '../worktree.js';
import { gateLabel } from '../gate-parts.js';
import { integratedChecks } from './checks.js';
import { relative } from 'node:path';
import { tryGit } from '../../git.js';
import { mergeBase } from '../integrate.js';

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

/** Les fichiers que le diff `from..to` change, supprimés et ancien nom d'un fichier déplacé compris ; null quand git ne le lit pas. */
const changedBetween = (dir: string, from: string, to: string): string[] | null => {
  const out = tryGit(dir, ['diff', '--name-only', '--no-renames', '-z', from, to]);
  return out === null ? null : out.split('\0').filter(Boolean);
};

/**
 * Le delta de main `from..to` (ce que la branche du dépôt a gagné depuis le dernier rebase) ne change-t-il que le plan (L662) ? Vrai quand chaque fichier du delta est un fichier du plan (`planFileSet` : le plan, sa page Gantt,
 * `plan.files`, ce que `plan.onWrite` produit, les fichiers d'année de l'archive), le commit de plan du lead ou d'une autre vague. Tout autre fichier rend faux : du code, un test, un script, un fichier racine que la porte exécute
 * (package.json, tsconfig.json), une page de docs (des tests la lisent, test/pages-lues-par-des-tests-l658.test.ts), CHANGELOG.md (test/changelog.test.ts) : la porte seule dit si le lot reste vert dessus, un lien d'imports n'est pas cherché.
 * Un delta vide ne change que le plan ; un delta que git ne lit pas est tenu pour du code (le doute rejoue la porte).
 */
export function deltaPlanOnly(dir: string, from: string, to: string, planFiles: ReadonlySet<string>): boolean {
  const delta = changedBetween(dir, from, to);
  return delta !== null && delta.every((f) => planFiles.has(f));
}

/** Les fichiers du plan du projet, relatifs à son dépôt ; null quand le plan ne se lit pas (la porte est alors rejouée). */
function planFilesOf(c: LotCtx): ReadonlySet<string> | null {
  try {
    return planFileSet(c.loadPlan(), c.lot.repo);
  } catch {
    return null;
  }
}

/** Le sommet de main sur lequel la porte d'intégration a été jouée verte au tour d'avant (L662) et l'arbre du lot à ce tour, gardés d'un tour à l'autre de la boucle de rebase. */
export interface GreenOnto {
  onto?: string;
  tree?: string;
}

/** Le delta `from..to` change le plan alors que `orchestrate.gate.readsPlan` déclare qu'un test le lit (L450) : il a un effet sur la porte, plan seul ou non. `verify --gate` reprenant la porte sautée, personne d'autre ne rattraperait ce test. */
function planDeltaRead(c: LotCtx, dir: string, from: string, to: string): boolean {
  if (!c.config.gate?.readsPlan) return false;
  const delta = changedBetween(dir, from, to);
  return delta === null || delta.includes(relative(c.lot.repo, c.loadPlan().path).split('\\').join('/'));
}

/** La verte du tour d'avant vaut pour le sommet rebasé (L662) : l.checks est porté sur `tip` et son arbre, pour que `verify --gate` la retrouve au sha intégré, et garde ce qui a vraiment joué (le premier tour, si plusieurs tours de suite sautent la porte) et le delta de plan seul. */
function carryGreen(c: LotCtx, tip: string, tree: string, delta: { from: string; to: string }): void {
  const k = c.lot.checks!;
  const origin = k.reprise ?? { head: k.head, tree: k.tree, from: delta.from };
  c.lot.checks = { ...k, head: tip, tree, reprise: { ...origin, to: delta.to } };
  save(c);
}

/**
 * La porte d'intégration d'un tour (L662) : un tour rejoué (main a avancé) ne saute la porte que si ce que main a gagné depuis le sommet où le tour d'avant l'a jouée verte (`green.onto`) ne change que le plan
 * (`deltaPlanOnly`, lu sur `onto..HEAD` : ni code, ni test, ni script, ni fichier racine, ni docs), sans qu'un test déclaré le lise (`planDeltaRead`), et si l.checks est encore l'enregistrement du tour d'avant (`green.tree`) ;
 * la verte du tour d'avant reste alors celle de ce sommet (`carryGreen`), et le journal le dit. Tout autre delta rejoue la porte. On ne peut pas prévenir que main avance, seulement son effet.
 * Rend les constats rouges ; `green` devient le sommet de main sur lequel le lot est rebasé et son arbre (un rouge rend le lot, la valeur ne sert alors plus).
 */
export async function integrationGate(c: LotCtx, key: string, t: { dir: string; base: string }, at: { tip: string; reviewed: string; green: GreenOnto }): Promise<Constat[]> {
  const onto = mergeBase(t.dir, 'HEAD', t.base);
  const tree = git(t.dir, 'rev-parse', 'HEAD^{tree}');
  const { onto: before, tree: greenTree } = at.green;
  const planFiles = before ? planFilesOf(c) : null;
  at.green.onto = onto;
  at.green.tree = tree;
  if (before && planFiles && c.lot.checks?.tree === greenTree && deltaPlanOnly(t.dir, before, onto, planFiles) && !planDeltaRead(c, t.dir, before, onto)) {
    carryGreen(c, at.tip, tree, { from: before, to: onto });
    c.wave.log(`${key} porte d'intégration non rejouée : ce que ${t.base} a gagné depuis ${before.slice(0, 7)} ne change que le plan (ni code, ni test, ni script, ni fichier racine, ni docs)`);
    return [];
  }
  return integrationChecks(c, key, t.dir, at.tip, at.reviewed);
}
