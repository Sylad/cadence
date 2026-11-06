import { type Constat } from '../state.js';
import { type LotCtx, save } from './ctx.js';
import { git } from '../worktree.js';
import { gateLabel } from '../gate-parts.js';
import { integratedChecks } from './checks.js';
import { dirname, join } from 'node:path';
import { tryGit } from '../../git.js';
import { mergeBase } from '../integrate.js';
import { declaredTests, readBounds } from '../../bounds.js';
import { docSyncSet } from '../../docsync.js';
import { DEFAULT_TEST_PATTERNS } from '../../testgate.js';

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

/** Le sommet de main sur lequel la porte d'intégration a été jouée verte au tour d'avant (L662), gardé d'un tour à l'autre de la boucle de rebase. */
export interface GreenOnto {
  onto?: string;
}

/**
 * La porte d'intégration d'un tour (L662) : un tour rejoué (main a avancé) ne rejoue la porte que si ce que main a gagné depuis le sommet où le tour d'avant l'a jouée verte (`green.onto`) est lié au diff du lot
 * (`deltaTouchesLot`, lu sur `onto..HEAD`) ; sinon la verte du tour d'avant reste celle de ce sommet, et le journal le dit. On ne peut pas prévenir que main avance, seulement son effet.
 * Rend les constats rouges ; `green.onto` devient le sommet de main sur lequel le lot est rebasé (un rouge rend le lot, la valeur ne sert alors plus).
 */
export async function integrationGate(c: LotCtx, key: string, t: { dir: string; base: string }, at: { tip: string; reviewed: string; green: GreenOnto }): Promise<Constat[]> {
  const onto = mergeBase(t.dir, 'HEAD', t.base);
  const before = at.green.onto;
  const lot = before ? changedBetween(t.dir, onto, 'HEAD') : null;
  at.green.onto = onto;
  if (before && lot && !deltaTouchesLot(t.dir, before, onto, lot)) {
    c.wave.log(`${key} porte d'intégration non rejouée : ce que ${t.base} a gagné depuis ${before.slice(0, 7)} ne touche ni un fichier ni un test liés au diff du lot`);
    return [];
  }
  return integrationChecks(c, key, t.dir, at.tip, at.reviewed);
}
