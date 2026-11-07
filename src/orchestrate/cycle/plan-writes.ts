import { join, relative } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lotWork } from '../../audit.js';
import { readPlanConfig } from '../../config.js';
import { PLAN_ACTIONS, planCommitMessage } from '../../plan-commit.js';
import { dirtyPaths, restoreWorktree, tryGit, unquotePath } from '../../git.js';
import { RafError, type Plan } from '../../plan.js';
import { snapshot, type Snapshot } from '../guard.js';
import { type ReviewReport } from '../schemas.js';
import { isAcceptationFile } from '../accept.js';
import { hypothesisNote } from '../spec.js';
import { type LotState, lotKey } from '../state.js';
import { repoBranch, takeRepoWrite, WAIT_LOG_MS } from '../integrate.js';
import { git, trackedDirty } from '../worktree.js';
import { diffFiles, type LotDiff } from '../lot-diff.js';
import { type LotCtx, transition, stop, propose, setWaitsTurn } from './ctx.js';

/** Fichiers suivis modifiés (chemins décodés), d'après `git status --porcelain` : un nom accentué ou à espace y est cité en C-quoting, il en sort tel que le disque le nomme (L614). */
export function trackedPaths(s: Snapshot): string[] {
  return s.tracked.map((l) => unquotePath(l.slice(3).replace(/^.* -> /, '')));
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
 * La réponse du lead va en note du lot dès qu'elle est prise (L670) : la question suivante ne peut plus venir de « aucune trace écrite dans les notes » (L477).
 * Une ligne, sans doublon à la reprise, commitée avec le plan. Un plan en lecture seule ne reçoit rien : la ligne devient une proposition `[note à poser]`.
 * Ne rend jamais le lot : une écriture refusée est un avertissement du lot, la réponse reste dans le brief de la session.
 */
export async function noteAnswer(c: LotCtx, answer: string): Promise<void> {
  const l = c.lot;
  const text = `Réponse du lead (vague ${c.wave.id}, ${c.wave.today}) — ${answer.trim().replace(/\s+/g, ' ')}`;
  try {
    const dirty = await planWrite(
      c,
      async () => {
        const plan = c.loadPlan();
        if (plan.readonly) {
          propose(c, `[note à poser] ${text}`);
          return null;
        }
        if (plan.lot(l.lot).notes.some((n) => n.text === text)) return null;
        const before = planBefore(c);
        plan.note(l.lot, text, c.wave.today);
        plan.save();
        return commitPlan(c, planMessage(c, PLAN_ACTIONS.answerNoted), l.repo, before);
      },
      PLAN_ACTIONS.answerNoted,
    );
    if (dirty) l.warnings.push(`réponse du lead non notée : ${dirty}`);
  } catch (e) {
    l.warnings.push(`réponse du lead non notée : ${(e as Error).message.split('\n')[0]}`);
  }
}

/**
 * La réponse du lead en attente est notée à la prise du lot (L670) : `noteTakenAnswers` l'appelle à chaque tour de la file des demandes (execute.ts), donc dès la prise, et au premier tour pour une réponse de
 * `--resume --answer`, avant que le lot attende un créneau du pool ; `runLot` le rappelle au départ du passage, pour une réponse arrivée autrement. La même réponse déjà en note (`c.answerNoted.text`) n'est pas relancée.
 * Dans le dépôt lui-même, l'écriture est attendue (elle salirait l'arbre où la session écrit) ; en worktree elle peut attendre le dépôt (une intégration le tient) : la session ne l'attend pas,
 * `awaitAnswerNote` l'attend à la fin du passage.
 */
export async function takeAnswerNote(c: LotCtx, atTake = false): Promise<void> {
  const answer = c.lot.pendingAnswer;
  // À la prise (`atTake`), un lot à l'étape accept n'est pas noté : le programme peut consommer la réponse lui-même (acceptation déjà verte, elle ne va ni au brief ni aux notes) ; l'étape accept la note quand elle la passe à une session.
  if (!answer || c.answerNoted?.text === answer || (atTake && c.lot.next === 'accept')) return;
  const note = { text: answer, end: Promise.resolve(), done: false };
  note.end = noteAnswer(c, answer).then(() => {
    note.done = true;
  });
  c.answerNoted = note;
  if (!c.tree) await note.end;
}

/** L670 : à chaque tour de la file des demandes, les lots dont une réponse du lead attend sont notés (prise à ce tour, ou déposée par `--resume --answer` au premier tour), avant toute attente de créneau. */
export async function noteTakenAnswers(ctxs: LotCtx[]): Promise<void> {
  for (const c of ctxs) await takeAnswerNote(c, true);
}

/** L670 : la fin du passage du lot attend sa note encore en cours ; le lot rend son créneau pendant cette attente sans session (`waitsTurn`, comme une intégration, L591). Une réponse suivante aura sa propre note. */
export async function awaitAnswerNote(c: LotCtx): Promise<void> {
  const note = c.answerNoted;
  if (note && !note.done) {
    setWaitsTurn(c, true);
    await note.end;
    setWaitsTurn(c, false);
  }
  c.answerNoted = undefined;
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

/**
 * Les fichiers modifiés du dépôt du lead que l'intégration du lot laisse passer (L673) : ceux du plan ou tenus avec lui (un `raf add` ou `raf done` du lead pendant la vague,
 * que le commit du plan emporte avec lui), tant que le diff du lot ne les touche pas. Tout autre fichier modifié reste un refus (R26). Le diff est celui de `lot-diff.ts`
 * (`diffFiles`, renommages comptés sous les deux chemins) ; illisible, rien n'est toléré : le refus nomme le fichier, comme avant L673.
 */
export function toleratedDirty(c: LotCtx, branch: string): (f: string) => boolean {
  const ownFile = planOwnFile(c, c.lot.repo);
  // Le diff n'est lu qu'au premier fichier du plan trouvé sale : un dépôt propre, ou déjà sur une autre branche (refus nommé par `leadMoved`), n'en paie ni la lecture ni l'échec.
  let diff: LotDiff | undefined;
  return (f) => {
    if (!ownFile(f)) return false;
    diff ??= diffFiles(c.lot.repo, c.tree!.base, branch);
    return diff.failure === null && !diff.files.includes(f);
  };
}

/**
 * Pourquoi le dépôt du lead n'est plus celui que l'intégration a vu au départ : branche changée ou HEAD détaché (R24), fichier suivi modifié (R8). Null s'il est intact.
 * `tolerated` écarte les fichiers modifiés que l'intégration accepte (L673) ; sans lui, tout fichier suivi modifié refuse.
 */
export function leadMoved(repo: string, base: string, tolerated: (f: string) => boolean = () => false): string | null {
  const cur = repoBranch(repo);
  if (cur !== base) return `le dépôt est sur ${cur ?? 'HEAD détaché'} et non sur ${base}`;
  const dirty = trackedDirty(repo).filter((f) => !tolerated(f));
  return dirty.length ? `arbre du dépôt modifié (${dirty.join(', ')})` : null;
}

/** Un refus d'écrire le plan par Plan.save() (plan.onWrite en échec, L346) est la cause d'un lot rendu, pas une erreur du lot. */
async function refusal(write: () => Promise<string | null>): Promise<string | null> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof RafError) return e.message;
    throw e;
  }
}

/** L670 : la ligne de journal d'une attente du dépôt de plus de 10 s : quel lot attend, quoi, et ce qu'il écrit ensuite (`what`). */
export const slowWaitLog = (c: LotCtx, what: string) => (waitingFor: string): void => c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · attend ${waitingFor} depuis plus de ${(c.wave.integrate?.slowMs ?? WAIT_LOG_MS) / 1000} s, pour : ${what}`);

/** Une écriture de plan du programme (R21, R26) : sous la file et le verrou du dépôt, le dépôt encore sur la branche de départ, aucun fichier suivi modifié hors plan. Rend la cause du refus, null si l'écriture a eu lieu. Hors worktree, rien ne change. */
export async function planWrite(c: LotCtx, doWrite: () => Promise<string | null>, what = 'une écriture du plan'): Promise<string | null> {
  const write = () => refusal(doWrite);
  if (!c.tree) return write();
  const l = c.lot;
  // L591 : l'écriture de plan, courte, passe devant les intégrations en file (elle n'attend que celle qui tient le dépôt) : un lot neuf ne reste pas sans session derrière toute la file, alors qu'il tient un créneau.
  const grant = await takeRepoWrite(l.repo, { wave: c.wave.id }, { ...c.wave.integrate, first: true, onSlow: slowWaitLog(c, what) });
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
