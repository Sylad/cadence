import { type Constat } from '../state.js';
import { type LotCtx, save } from './ctx.js';
import { git } from '../worktree.js';
import { gateLabel } from '../gate-parts.js';
import { integratedChecks } from './checks.js';
import { dirname, join, relative } from 'node:path';
import { tryGit } from '../../git.js';
import { mergeBase } from '../integrate.js';
import { declaredTests, readBounds } from '../../bounds.js';
import { docSyncSet } from '../../docsync.js';
import { DEFAULT_TEST_PATTERNS } from '../../testgate.js';

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

/** Les tests que `bounds` (cadence.yaml) déclare pour ces fichiers ; un cadence.yaml absent ou illisible n'en déclare aucun. */
function declaredFor(dir: string, files: string[]): string[] {
  try {
    return declaredTests(readBounds(join(dir, 'cadence.yaml')), files);
  } catch {
    return [];
  }
}

/** Les fichiers que tous les lots touchent (`docs.sync` impose une entrée sous `[Unreleased]`) : ils ne disent rien du lien entre un delta et un lot, sa forme est déjà rejouée à part (test/changelog.test.ts). */
const EVERY_LOT = ['CHANGELOG.md'];

/**
 * Le delta de main `from..to` (ce que la branche du dépôt a gagné depuis le dernier rebase) est-il lié au diff du lot (L662) ? Lié : il touche un fichier du lot, un voisin de code du lot (même dossier : faute de graphe d'import,
 * c'est ce qui approche « le fichier qu'il importe »), ou un test que `bounds` déclare pour les fichiers du lot. Ni `CHANGELOG.md` (tous les lots le touchent) ni la racine du dépôt comme voisinage (tout fichier racine lierait) ne comptent. Les dossiers des tests du lot ne comptent pas comme voisinage (le dossier `test/` de tous les lots les lierait tous).
 * Un delta vide n'est pas lié ; un delta que git ne lit pas l'est (le doute rejoue la porte).
 */
export function deltaTouchesLot(dir: string, from: string, to: string, lotFiles: string[]): boolean {
  const delta = changedBetween(dir, from, to);
  if (delta === null) return true;
  const isTest = docSyncSet(DEFAULT_TEST_PATTERNS);
  const own = lotFiles.filter((f) => !EVERY_LOT.includes(f));
  const dirs = new Set(own.filter((f) => !isTest(f)).map((f) => dirname(f)).filter((d) => d !== '.'));
  const related = new Set([...own, ...declaredFor(dir, own)]);
  return delta.some((f) => related.has(f) || dirs.has(dirname(f)));
}

/** Le sommet de main sur lequel la porte d'intégration a été jouée verte au tour d'avant (L662) et l'arbre du lot à ce tour, gardés d'un tour à l'autre de la boucle de rebase. */
export interface GreenOnto {
  onto?: string;
  tree?: string;
}

/** Le delta `from..to` change le plan alors que `orchestrate.gate.readsPlan` déclare qu'un test le lit (L450) : il a un effet sur la porte, qu'il touche le lot ou non. `verify --gate` reprenant la porte sautée, personne d'autre ne rattraperait ce test. */
function planDeltaRead(c: LotCtx, dir: string, from: string, to: string): boolean {
  if (!c.config.gate?.readsPlan) return false;
  const delta = changedBetween(dir, from, to);
  return delta === null || delta.includes(relative(c.lot.repo, c.loadPlan().path).split('\\').join('/'));
}

/** La verte du tour d'avant vaut pour le sommet rebasé (L662) : l.checks est porté sur `tip` et son arbre, pour que `verify --gate` la retrouve au sha intégré, et garde ce qui a vraiment joué (le premier tour, si plusieurs tours de suite sautent la porte) et le delta jugé sans lien. */
function carryGreen(c: LotCtx, tip: string, tree: string, delta: { from: string; to: string }): void {
  const k = c.lot.checks!;
  const origin = k.reprise ?? { head: k.head, tree: k.tree, from: delta.from };
  c.lot.checks = { ...k, head: tip, tree, reprise: { ...origin, to: delta.to } };
  save(c);
}

/**
 * La porte d'intégration d'un tour (L662) : un tour rejoué (main a avancé) ne rejoue la porte que si ce que main a gagné depuis le sommet où le tour d'avant l'a jouée verte (`green.onto`) est lié au diff du lot
 * (`deltaTouchesLot`, lu sur `onto..HEAD`), ou change un plan qu'un test déclaré lit (`planDeltaRead`), ou si l.checks n'est plus l'enregistrement du tour d'avant (`green.tree`) ; sinon la verte du tour d'avant reste celle de ce sommet (`carryGreen`), et le journal le dit. On ne peut pas prévenir que main avance, seulement son effet.
 * Rend les constats rouges ; `green` devient le sommet de main sur lequel le lot est rebasé et son arbre (un rouge rend le lot, la valeur ne sert alors plus).
 */
export async function integrationGate(c: LotCtx, key: string, t: { dir: string; base: string }, at: { tip: string; reviewed: string; green: GreenOnto }): Promise<Constat[]> {
  const onto = mergeBase(t.dir, 'HEAD', t.base);
  const tree = git(t.dir, 'rev-parse', 'HEAD^{tree}');
  const { onto: before, tree: greenTree } = at.green;
  const lot = before ? changedBetween(t.dir, onto, 'HEAD') : null;
  at.green.onto = onto;
  at.green.tree = tree;
  if (before && lot && c.lot.checks?.tree === greenTree && !deltaTouchesLot(t.dir, before, onto, lot) && !planDeltaRead(c, t.dir, before, onto)) {
    carryGreen(c, at.tip, tree, { from: before, to: onto });
    c.wave.log(`${key} porte d'intégration non rejouée : ce que ${t.base} a gagné depuis ${before.slice(0, 7)} ne touche ni un fichier ni un test liés au diff du lot`);
    return [];
  }
  return integrationChecks(c, key, t.dir, at.tip, at.reviewed);
}
