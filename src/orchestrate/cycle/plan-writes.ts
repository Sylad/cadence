import { join, relative } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lotWork } from '../../audit.js';
import { readPlanConfig } from '../../config.js';
import { PLAN_ACTIONS, planCommitMessage } from '../../plan-commit.js';
import { dirtyPaths, restoreWorktree, tryGit, type Commit } from '../../git.js';
import { RafError, type Plan } from '../../plan.js';
import { snapshot, type Snapshot } from '../guard.js';
import { type ReviewReport } from '../schemas.js';
import { isAcceptationFile } from '../accept.js';
import { hypothesisNote } from '../spec.js';
import { type LotState } from '../state.js';
import { repoBranch, takeRepoWrite } from '../integrate.js';
import { git, trackedDirty } from '../worktree.js';
import { type LotCtx, workDir as wd, transition, stop, propose } from './ctx.js';

/** Fichiers suivis modifiés (chemins), d'après `git status --porcelain`. */
export function trackedPaths(s: Snapshot): string[] {
  return s.tracked.map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

/** Le gabarit `plan.commit` du projet (L343), undefined sans. */
export const planTemplate = (c: LotCtx): string | undefined => readPlanConfig(join(c.lot.repo, 'cadence.yaml'), c.lot.repo)?.commit;

/** Le message d'un commit de plan de la vague : le gabarit `plan.commit` du projet (L343), à défaut le message d'avant. */
export function planMessage(c: LotCtx, action: string): string {
  return planCommitMessage(planTemplate(c), { lot: c.lot.lot, action, wave: c.wave.id });
}

/** Le contenu des fichiers du plan déjà modifiés, non commités, avant une écriture de cadence (null : absent du disque) : ce qu'un commit refusé remet (`commitPlan`). */
type PlanBefore = Map<string, string | null>;

/**
 * Ce que le lead a modifié dans le plan sans commiter, pris AVANT que cadence n'écrive : les fichiers suivis modifiés que `commitPlan` accepte (le plan, ce qui est
 * tenu avec lui, les acceptation.json), avec leur contenu. Un commit de plan refusé (hook) les remet tels quels au lieu de les ramener à HEAD (L343).
 */
export function planBefore(c: LotCtx, repo = c.lot.repo): PlanBefore {
  const ownFile = planOwnFile(c, repo);
  const kept: PlanBefore = new Map();
  for (const f of trackedDirty(repo).filter(ownFile)) {
    try {
      kept.set(f, readFileSync(join(repo, f), 'utf8'));
    } catch {
      kept.set(f, null);
    }
  }
  return kept;
}

/**
 * Commit d'entretien du plan, chemins explicites. Rend un message d'arbre sale quand autre chose que le plan a bougé.
 * Dans le dépôt du projet (`root` par défaut) : jamais dans un worktree de lot (R21). Les commits de TRAVAIL du cycle (scellé et `vert: true` de l'acceptation)
 * se font, eux, dans `wd(c)`, sur la branche du lot.
 * `before` : ce que le lead avait modifié sans commiter avant l'écriture (`planBefore`) ; un commit refusé le remet, et ramène à HEAD ce que cadence seule a écrit.
 */
export async function commitPlan(c: LotCtx, message: string, root = c.lot.repo, before: PlanBefore = new Map()): Promise<string | null> {
  const repo = root;
  const ownFile = planOwnFile(c, repo);
  // Les fichiers de plan.onWrite (L346) entrent même non suivis : le premier plan publié n'est pas encore au dépôt.
  // Les fichiers d'année de l'archive (L396) aussi : un `raf archive` non commité pendant la vague les crée ou les réécrit, et le plan seul commité laisserait HEAD sans les lots archivés.
  // Chemins relatifs au dépôt du projet (comme `plan.maintained`), même quand `root` est un worktree de lot ; vide pour un plan en lecture seule.
  const plan = c.loadPlan();
  const archives = plan.archiveFiles().map((f) => relative(c.lot.repo, f));
  const dirty = [...new Set([...trackedPaths(await snapshot(repo, { remote: false })), ...dirtyPaths(repo, [...plan.produced, ...archives])])];
  if (dirty.length === 0) return null;
  const foreign = dirty.filter((f) => !ownFile(f));
  if (foreign.length) return `arbre sale (fichiers hors plan) : ${foreign.join(', ')}`;
  try {
    git(repo, 'add', '--', ...dirty);
    git(repo, 'commit', '-q', '-m', message, '--', ...dirty);
  } catch (e) {
    // Commit refusé (hook commit-msg…, L343) ou index verrouillé (L385) : le plan n'a pas à rester indexé ni modifié par cadence, le lot suivant y verrait un dépôt sale et serait rendu.
    // Ce que le lead avait modifié sans commiter (raf add, raf note pendant la session) est remis, pas effacé.
    // Un index.lock bloque aussi la désindexation et le checkout : le désindexage est tenté sans plus, et l'arbre de travail est remis sans passer par l'index.
    tryGit(repo, ['restore', '--staged', '--', ...dirty]);
    const own = dirty.filter((f) => !before.has(f));
    if (own.length) restoreWorktree(repo, own);
    for (const [f, text] of before) {
      if (!dirty.includes(f)) continue;
      if (text === null) rmSync(join(repo, f), { force: true });
      else writeFileSync(join(repo, f), text);
    }
    throw e;
  }
  return null;
}

/**
 * Pose en note du lot une ligne par hypothèse de la fiche (rien de plus que ce que la note dit déjà : une reprise ne duplique pas) et la commite avec le
 * plan. Un plan tenu par un autre outil (lecture seule) ne reçoit rien : la ligne devient une proposition rendue au lead. Rend vrai quand le lot est rendu.
 */
export async function noteHypotheses(c: LotCtx, lines: string[], sujet: string): Promise<boolean> {
  const l = c.lot;
  l.hypotheses = lines;
  if (!lines.length) return false;
  const texts = lines.map((x) => hypothesisNote(sujet, x));
  const dirty = await planWrite(c, async () => {
    const plan = c.loadPlan();
    if (plan.readonly) {
      for (const t of texts) propose(c, `[note à poser] ${t}`);
      return null;
    }
    const have = new Set(plan.lot(l.lot).notes.map((n) => n.text));
    const fresh = texts.filter((t) => !have.has(t));
    if (!fresh.length) return null;
    const before = planBefore(c);
    for (const t of fresh) plan.note(l.lot, t, c.wave.today);
    plan.save();
    return commitPlan(c, planMessage(c, PLAN_ACTIONS.hypotheses(sujet)), c.lot.repo, before);
  });
  if (dirty) {
    handBackPlan(c, `${HYPOTHESES_HANDBACK}${dirty}`);
    return true;
  }
  return false;
}

/**
 * Les mineurs de la revue de la fiche vont en notes du lot (spec etape-spec-back § 4), pas au tableau de fin de vague : une note par constat, sans doublon
 * à la reprise, commitée avec le plan. Un plan en lecture seule ne reçoit rien : la ligne devient une proposition `[note à poser]` rendue au lead.
 * Rend vrai quand le lot est rendu (arbre sale).
 */
export async function noteMinors(c: LotCtx, rep: ReviewReport, label: string): Promise<boolean> {
  const texts = rep.constats.filter((k) => k.gravite === 'mineur').map((k) => `Revue de ${label} — mineur : ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);
  if (!texts.length) return false;
  const dirty = await planWrite(c, async () => {
    const plan = c.loadPlan();
    if (plan.readonly) {
      for (const t of texts) propose(c, `[note à poser] ${t}`);
      return null;
    }
    const have = new Set(plan.lot(c.lot.lot).notes.map((n) => n.text));
    const fresh = [...new Set(texts)].filter((t) => !have.has(t));
    if (!fresh.length) return null;
    const before = planBefore(c);
    for (const t of fresh) plan.note(c.lot.lot, t, c.wave.today);
    plan.save();
    return commitPlan(c, planMessage(c, PLAN_ACTIONS.minors(label)), c.lot.repo, before);
  });
  if (dirty) {
    handBackPlan(c, `${MINORS_HANDBACK}${label} : ${dirty}`);
    return true;
  }
  return false;
}

/**
 * Les fichiers que le cycle a le droit de commiter dans `repo` : le plan, ce qui est tenu avec lui, et les acceptation.json (L173), où il pose le scellé et `vert: true`.
 * Source commune de `commitPlan` et de `foreignDirty`.
 */
function planOwnFile(c: LotCtx, repo: string): (f: string) => boolean {
  const plan = c.loadPlan();
  const own = new Set([relative(repo, plan.path), ...plan.maintained]);
  const specDir = `${c.config.spec.dir.replace(/\/+$/, '')}/`;
  return (f) => own.has(f) || (f.startsWith(specDir) && isAcceptationFile(f));
}

/** Les fichiers suivis modifiés du dépôt du projet qui ne sont ni le plan, ni ce qui est tenu avec lui, ni une acceptation : ce que `commitPlan` refuserait (R26). */
export function foreignDirty(c: LotCtx): string[] {
  const ownFile = planOwnFile(c, c.lot.repo);
  return trackedDirty(c.lot.repo).filter((f) => !ownFile(f));
}

/** Pourquoi le dépôt du lead n'est plus celui que l'intégration a vu au départ : branche changée ou HEAD détaché (R24), fichier suivi modifié (R8). Null s'il est intact. */
export function leadMoved(repo: string, base: string): string | null {
  const cur = repoBranch(repo);
  if (cur !== base) return `le dépôt est sur ${cur ?? 'HEAD détaché'} et non sur ${base}`;
  const dirty = trackedDirty(repo);
  return dirty.length ? `arbre du dépôt modifié (${dirty.join(', ')})` : null;
}

/** Un refus d'écrire le plan par Plan.save() (plan.onWrite en échec, L346) est la cause d'un lot rendu, pas une erreur du lot. */
export async function refusal(write: () => Promise<string | null>): Promise<string | null> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof RafError) return e.message;
    throw e;
  }
}

/** Une écriture de plan du programme (R21, R26) : sous la file et le verrou du dépôt, le dépôt encore sur la branche de départ, aucun fichier suivi modifié hors plan. Rend la cause du refus, null si l'écriture a eu lieu. Hors worktree, rien ne change. */
export async function planWrite(c: LotCtx, doWrite: () => Promise<string | null>): Promise<string | null> {
  const write = () => refusal(doWrite);
  if (!c.tree) return write();
  const l = c.lot;
  const grant = await takeRepoWrite(l.repo, { wave: c.wave.id }, c.wave.integrate);
  if (!grant.ok) return `écriture du plan refusée : verrou tenu par ${grant.holder.wave} (pid ${grant.holder.pid})`;
  try {
    const cur = repoBranch(l.repo);
    if (cur !== c.tree.base) return `écriture du plan refusée : dépôt sur ${cur ?? 'HEAD détaché'} et non ${c.tree.base}`;
    const foreign = foreignDirty(c);
    if (foreign.length) return `écriture du plan refusée : arbre du dépôt modifié (${foreign.join(', ')})`;
    return await write();
  } finally {
    grant.release();
  }
}

/** Début de la cause d'un lot rendu sur le refus d'écrire les notes d'hypothèses de sa fiche, et des mineurs de la revue de sa fiche (handBackPlan). */
export const HYPOTHESES_HANDBACK = 'notes des hypothèses de la fiche : ';
const MINORS_HANDBACK = 'notes des mineurs de la revue de ';

/**
 * Lot rendu sur une écriture de plan refusée hors intégration (R26) : en worktree il garde l'étape atteinte (`next`), et `--resume --replay` le rejoue à cette étape
 * (décision du lead du 24-10). Aucun champ d'état : la cause rendue le désigne.
 */
export const planNoteHandBack = (l: LotState): boolean => l.status === 'handed-back' && l.next !== null && l.next !== undefined && !!l.outcome && (l.outcome.startsWith(HYPOTHESES_HANDBACK) || l.outcome.startsWith(MINORS_HANDBACK));

/**
 * Un lot rendu hors de l'étape d'intégration (budget, revue non conforme…) que le lead a fait corriger puis revoir hors vague (L370) : sa revue de code du plan
 * porte le dernier commit de travail du lot dans son worktree, donc rien n'a été commité après elle. Rend le sha relu et le verdict du lead, ou null.
 */
export function leadReviewedHandBack(l: LotState, plan: Plan, treeDir: string): { head: string; verdict: string } | null {
  if (l.status !== 'handed-back' || l.next === 'integrate' || planNoteHandBack(l) || !existsSync(join(treeDir, '.git'))) return null;
  const review = plan.lots().find((x) => x.id === l.lot)?.review;
  const tip = lotWork(plan, treeDir, l.lot)[0]?.sha;
  return review?.commit && tip && review.commit === tip ? { head: tip, verdict: review.verdict } : null;
}

/** Une écriture de plan refusée rend le lot au lead ; en worktree, il garde l'étape atteinte pour la reprise (R26), sinon `stop` la vide comme avant. */
function handBackPlan(c: LotCtx, why: string): void {
  if (c.tree) transition(c, 'handed-back', why);
  else stop(c, 'handed-back', why);
}
