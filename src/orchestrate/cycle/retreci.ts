import { spawnSync } from 'node:child_process';
import { lotWork } from '../../audit.js';
import { type OrchestrateConfig } from '../../config.js';
import { type Plan, type Screen } from '../../plan.js';
import { type SessionKind } from '../launch.js';
import { lotKey } from '../state.js';
import { sealedAcceptation, stageScreen } from '../spec.js';
import { convergeBrief } from './converge.js';
import { histPlan, workDir as wd, type LotCtx } from './ctx.js';

/**
 * Lot rétréci (L621, issue #40) : un objectif est donné (`--goal`, ou clé `goal:` du plan) et au moins un commit de travail du lot est déjà dans la base au lancement.
 * Les commits du lot sont ceux de `lotWork`, dépôt du projet seul : un lot dont les commits intégrés sont seulement dans un dépôt voisin n'est jamais rétréci.
 */

/** Mots qui disent que l'objectif change la mise en page (hypothèse R3 de la fiche goal-lot-retreci), cherchés sans accents ni majuscules. */
const LAYOUT_WORDS = ['mise en page', 'layout', 'disposition', 'maquette', 'ecran', 'affichage', 'colonne', 'grille', 'responsive'];

const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** L'objectif change la mise en page : la maquette reste jouée même pour un lot rétréci. */
const changesLayout = (goal: string): boolean => LAYOUT_WORDS.some((w) => plain(goal).includes(w));

/**
 * Étape spec du lancement (`screen` de l'état) : celle de `stageScreen`, sauf pour un lot rétréci dont l'objectif ne change pas la mise en page (R2) : `screen` absent et `skipped` = le nombre de commits
 * du lot déjà dans la base (`lotWork`, lu avant toute session, N du journal). Un lot à acceptation scellée garde sa chaîne (R4) ; un lot `spec: true` sans écran n'a pas de maquette à sauter (R5), un `spec: true` avec écran la saute comme les autres (R2).
 */
export function launchScreen(plan: Plan, repo: string, config: Pick<OrchestrateConfig, 'spec' | 'maquette'>, lot: Parameters<typeof stageScreen>[2], goal: string | undefined): { screen?: Screen; skipped?: number } {
  const ordinary = stageScreen(repo, config.spec.dir, lot, config.maquette);
  const merged = ordinary && goal ? lotWork(plan, repo, lot.id).length : 0;
  const skip = merged > 0 && !changesLayout(goal!) && !sealedAcceptation(repo, config.spec.dir, lot.id);
  return skip ? { skipped: merged } : { screen: ordinary };
}

/** Le lot tel que le lancement le lit : maquette sautée, un lot `spec: true` avec écran n'a plus d'étape spec, ni dans son état ni dans son budget (R2). */
export const launchedLot = <L extends { spec?: boolean }>(lot: L, skipped: number | undefined): L => (skipped ? { ...lot, spec: false } : lot);

/**
 * Ligne du journal de la vague au premier départ d'un lot dont le lancement a sauté la maquette (R2) ; rien sinon. Aucun champ d'état (D1) : la décision du lancement est refaite
 * par `launchScreen` (même plan, mêmes commits intégrés), seulement pour un lot sans étape ni écran ; un lot déjà démarré ne reparle pas.
 */
export function noteMaquetteSautee(c: LotCtx): void {
  const l = c.lot;
  if (!l.goal || l.screen || l.steps.length) return;
  const plan = c.loadPlan();
  const planLot = plan.lots().find((x) => x.id === l.lot);
  const skipped = planLot ? launchScreen(plan, l.repo, c.config, planLot, l.goal).skipped : undefined;
  if (skipped) c.wave.log(`${lotKey(l.project, l.lot)} · maquette sautée : l'objectif rétrécit le lot à ${skipped} commit(s) déjà intégré(s) et ne change pas la mise en page`);
}

/** `{{converge}}` d'une session : la consigne de `convergeBrief`, avec le rétrécissement du lot relu dans git pour les revues de code seulement. */
export const convergeText = (c: LotCtx, kind: SessionKind): string => convergeBrief(kind, c.lot, kind === 'review' || kind === 'review-small' ? readShrunk(c) : undefined);

/** Un lot lu rétréci pour la revue : son objectif et la tête de lancement (`headBefore` de sa première étape), au-delà de laquelle commence le diff à juger. */
export interface Shrunk {
  goal: string;
  from: string;
}

/** `sha` est-il `from` ou un de ses ancêtres ? Une lecture impossible (objet inconnu du dépôt, git en échec) vaut non : le repli sûr est le lot non rétréci. */
function isAncestor(dir: string, sha: string, from: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, from], { cwd: dir, stdio: 'ignore' }).status === 0;
}

/**
 * Le lot est-il rétréci ? Relu dans git à chaque besoin, sans champ d'état (R12) : l'état garde un objectif et au moins un commit de `lotWork` est antérieur à la tête
 * avant la première étape (`steps[0].headBefore`). Les commits écrits par la vague lui sont postérieurs : ils ne rendent jamais un lot rétréci après coup.
 * Sans objectif, sans `headBefore`, ou si git ne répond pas : undefined (chemin ordinaire).
 */
export function readShrunk(c: LotCtx): Shrunk | undefined {
  const goal = c.lot.goal;
  const from = c.lot.steps[0]?.headBefore;
  if (!goal || !from) return undefined;
  const dir = wd(c);
  let commits;
  try {
    commits = lotWork(histPlan(c), dir, c.lot.lot);
  } catch {
    return undefined; // lecture impossible : lot non rétréci (R12)
  }
  // Intégré = dans la base réelle du lot (R1) : sur une branche reprise (L311), les commits non intégrés d'une vague passée sont des ancêtres de `from` sans être dans la base.
  const base = c.tree?.base;
  return commits.some((k) => isAncestor(dir, k.sha, from) && (!base || isAncestor(dir, k.sha, base))) ? { goal, from } : undefined;
}
