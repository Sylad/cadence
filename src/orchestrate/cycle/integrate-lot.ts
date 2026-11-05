import { type LotCtx, type LotTree, histPlan, workDir as wd, stop, save, transition, propose, setWaitsTurn } from './ctx.js';
import { type ReviewSummary, type Constat, lotKey } from '../state.js';
import { repoShas, repoWork } from '../../repos.js';
import { lotWork, coveredTasks } from '../../audit.js';
import { openDocGap } from './brief.js';
import { git, trackedDirty, lotBranch, branchExists, integrated, gitFailure, removeTree } from '../worktree.js';
import { foreignDirty, planBefore, commitPlan, planMessage, leadMoved } from './plan-writes.js';
import { repoBranch, INTEGRATE_WAIT_MS, takeRepoWrite, rebaseOnto, rebaseNotes, changelogShapeOf, patchId, mergeBase, advance, baseMoved, MAX_REPLAYS, type Grant, type Rebase } from '../integrate.js';
import { relative } from 'node:path';
import { RafError } from '../../plan.js';
import { PLAN_ACTIONS } from '../../plan-commit.js';
import { sh, shEscape } from './sh.js';
import { redExcerpt } from './checks.js';
import { integrationChecks } from './integration-porte.js';
import { session } from './session.js';
import { blockingConstats } from './shared.js';
import { lateRefusal } from './depot-partage.js';
import { awaitOlder } from './integrate-wait.js';
import { conflictNotes } from '../lot-diff.js';
import { declaredFor } from '../../resources.js';
import { checkShape, type ReviewReport, REVIEW_SCHEMA } from '../schemas.js';
/** Trace d'un verdict reporté après un rebase (R9) : le sha relu, le sha intégré qui le remplace, et le patch-id (le même des deux côtés) qui le garantit. */
export interface Reporte {
  de: string;
  vers: string;
  patchId: string;
}

/**
 * Revue conforme : le verdict est enregistré avec le sha relu, puis le commit du plan. `raf done` reste au lead.
 * Un lot en worktree (L279) n'écrit rien au plan ici : le verdict et la clôture des sous-tâches attendent l'intégration, qui les écrit après l'avance de la branche
 * du dépôt (R22, R23) ; le lot passe alors à l'étape `integrate`, la seule que `--resume --integrate` rejoue (R14, R27).
 */
export async function conclude(c: LotCtx, code: ReviewSummary, minorNote = ''): Promise<void> {
  const l = c.lot;
  const plan = histPlan(c);
  // Dépôts voisins du lot (L62) : le sha lu de chacun est enregistré avec le verdict, et dit dans son texte (un plan en lecture seule n'a que le texte).
  const neighbours = l.repos ?? [];
  const shas = repoShas(plan, neighbours, l.lot);
  const read = neighbours.length ? ` ; dépôts relus : ${neighbours.map((r) => `${r.rel}@${shas[r.rel]?.slice(0, 7) ?? 'aucun commit du lot'}`).join(', ')}` : '';
  const verdict = `${code.verdict} — orchestré (vague ${c.wave.id}, ${l.pass} passe(s) de correction${l.minorPass ? ` + passe des mineurs${minorNote}` : ''}${read})`;
  l.verdict = verdict;
  const newer = lotWork(plan, wd(c), l.lot)[0]?.sha ?? null;
  // L317 : la porte du bibliothécaire peut ne pas avoir été jouée (passes ou budget épuisés) ; un écart docs.sync ouvert ne finit jamais prêt.
  const gap = openDocGap(c);
  if (gap) {
    stop(c, 'handed-back', gap);
    return;
  }
  const moved = (code.head && newer !== null && git(wd(c), 'rev-parse', 'HEAD') !== code.head ? [''] : []).concat(
    neighbours.filter((r) => shas[r.rel] !== null && code.repoHeads?.[r.rel] && git(r.path, 'rev-parse', 'HEAD') !== code.repoHeads[r.rel]).map((r) => ` dans ${r.rel}`),
  );
  if (moved.length) {
    stop(c, 'handed-back', `un commit est postérieur à la revue${moved.join(',')} : verdict non enregistré`);
    return;
  }
  l.constats = [];
  if (c.tree?.active) {
    l.next = 'integrate';
    save(c);
    await integrateLot(c);
    return;
  }
  const dirty = await writeVerdict(c, verdict, newer);
  if (dirty) {
    stop(c, 'handed-back', dirty);
    return;
  }
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/**
 * Écrit au plan, dans le dépôt du projet, l'entrée du lot : verdict (au sha `commit`, avec la trace `reporte` d'un verdict reporté), sous-tâches couvertes
 * passées à done, puis le commit du plan seul ; pour un plan en lecture seule, l'outil `orchestrate.verdict` du projet, lancé dans ce dépôt (R21, R23).
 * Rend la cause d'un refus (arbre sale hors plan), null sinon. Un verdict déjà écrit et commité au même sha n'est pas écrit deux fois (reprise de l'intégration, R23).
 */
async function writeVerdict(c: LotCtx, verdict: string, commit: string | null, reporte?: Reporte): Promise<string | null> {
  const l = c.lot;
  const plan = c.loadPlan();
  const neighbours = l.repos ?? [];
  const shas = repoShas(plan, neighbours, l.lot);
  // Sous-tâches ouvertes que des commits du lot citent (L82) : la revue conforme vaut pour elles, sinon `raf done` refuserait le lot.
  const covered = coveredTasks(plan, l.repo, l.lot, neighbours.flatMap((r) => repoWork(plan, r, l.lot)));
  // En worktree, rien n'est écrit (ni plan, ni outil du projet) si le dépôt du lead a déjà un fichier suivi modifié hors plan : le refus ne laisse pas un plan modifié non commité (R26).
  const foreign = c.tree ? foreignDirty(c) : [];
  if (foreign.length) return `arbre du dépôt modifié (${foreign.join(', ')})`;
  // Le commit de plan va sur la branche courante du dépôt : en worktree, elle doit être encore la branche de départ (R24), même si le lead a bougé depuis l'avance.
  if (c.tree) {
    const cur = repoBranch(l.repo);
    if (cur !== c.tree.base) return `dépôt sur ${cur ?? 'HEAD détaché'} et non ${c.tree.base}`;
  }
  if (!plan.readonly) {
    // Déjà écrit et commité au même sha (reprise de l'intégration, R23) : une seule fois.
    if (c.tree && commit !== null && plan.lot(l.lot).review?.commit === commit && !covered.length && !trackedDirty(l.repo).includes(relative(l.repo, plan.path))) return null;
    const before = planBefore(c);
    plan.recordReview(l.lot, verdict, c.wave.today, commit, neighbours.length ? shas : undefined, reporte);
    for (const k of covered) plan.setStatus(`${l.lot}/${k.task}`, 'done', c.wave.today);
    if (covered.length) l.warnings.push(`sous-tâches closes (couvertes par des commits qui les citent, revue conforme) : ${covered.map((k) => `${l.lot}/${k.task} (${k.sha.slice(0, 7)})`).join(', ')}`);
    try {
      plan.save();
    } catch (e) {
      if (e instanceof RafError) return e.message;
      throw e;
    }
    const dirty = await commitPlan(c, planMessage(c, PLAN_ACTIONS.reviewRecorded), l.repo, before);
    if (dirty) return dirty;
  } else {
    for (const k of covered) propose(c, `[sous-tâche clore] ${l.lot}/${k.task} — couverte par ${k.sha.slice(0, 7)}, revue conforme : à clore avant raf done`);
  }
  if (plan.readonly && c.config.verdict) {
    // La trace d'un verdict reporté va dans le texte, le seul endroit où l'outil du projet la lit (R23).
    const text = reporte ? `${verdict} ; verdict reporté : ${reporte.de.slice(0, 7)} → ${reporte.vers.slice(0, 7)} (patch-id identique)` : verdict;
    const before = planBefore(c);
    const r = await sh(c, c.config.verdict.replaceAll('{lot}', l.lot).replaceAll('{verdict}', shEscape(text)), undefined, undefined, l.repo);
    if (r.code !== 0) l.warnings.push(`orchestrate.verdict en échec (code ${r.code}) : le lead reporte le verdict`);
    else {
      const dirty = await commitPlan(c, planMessage(c, PLAN_ACTIONS.reviewNoted), l.repo, before);
      if (dirty) return dirty;
    }
  }
  return null;
}

/** Ce qui sépare le verdict de la revue du lot de celui de sa revue courte du diff rebasé (R17). */
const SHORT_REVIEW_TRACE = ' ; revue courte du diff rebasé (patch-id différent) : ';

const minutesText = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} s`);

/**
 * Le refus d'un rebase en conflit (R6 de L279) : le message d'avant, complété (L558, R11) pour chaque ressource à chemins qu'un fichier en conflit couvre des commits
 * de la base qui l'ont modifié depuis le départ du lot.
 */
function conflictRefusal(repo: string, t: LotTree, rebased: Extract<Rebase, { kind: 'conflict' }>): string {
  const files = rebased.files.length ? ` (fichiers : ${rebased.files.join(', ')})` : ` (${rebased.detail})`;
  return `intégration impossible : conflit en rebasant ${t.branch} sur ${t.base}${files}${conflictNotes(t.dir, t.base, rebased.files, declaredFor(repo))}`;
}

/**
 * Le tour d'intégration du lot (L591) : le lot qui attend son tour rend son créneau (pool et registre, `waitsTurn`) ; à son tour il compte de nouveau et reprend sans
 * redemander de créneau (`tookTurn`, lu par la fonction `claude` d'execute.ts, le temps de l'intégration : la relâche du tour le retire), l'intégration ne lançant qu'une revue courte.
 */
async function awaitTurn(c: LotCtx): Promise<Grant> {
  let waited = false;
  const grant = await takeRepoWrite(c.lot.repo, { wave: c.wave.id }, { ...c.wave.integrate, onWait: () => { waited = true; setWaitsTurn(c, true); }, onTurn: () => setWaitsTurn(c, false) });
  if (!grant.ok) return grant;
  c.tookTurn = waited;
  return { ok: true, release: () => { c.tookTurn = false; grant.release(); } };
}

/**
 * Intégration d'un lot en worktree à la branche du dépôt (L279, C2), AVANT sa transition à ready (R22). D'abord, hors verrou, l'attente d'un lot plus ancien de la
 * vague qui travaille sur une ressource à chemins que le lot touche aussi (L558, `awaitOlder`). Puis sous le verrou d'intégration : branche du dépôt encore
 * celle de départ (R24), aucun fichier suivi modifié (R8), rebase sur le sommet courant (conflit : abandonné, rendu au lead, R6), contrôles joués au sommet
 * (rebasé ou non, suite complète une fois par sommet, L590 R5 et R7), report du verdict si le patch-id est le même (R9) ou revue courte du diff rebasé sinon (R17), avance en fast-forward, puis écriture du plan dans le
 * dépôt du projet (R23). Tout rendu garde `next: integrate` et le worktree : seul `--resume --integrate` le rejoue (R14, R27).
 */
export async function integrateLot(c: LotCtx): Promise<void> {
  const l = c.lot;
  const key = lotKey(l.project, l.lot);
  const refuse = (why: string): void => {
    l.next = 'integrate';
    transition(c, 'handed-back', why);
  };
  // Un lot repris à l'intégration dont le worktree a été retiré entre-temps (`--remove-worktree`) n'a plus rien à intégrer.
  if (!c.tree?.active) {
    // Une branche encore là mais sans sa clé `branch.<nom>.cadence-base` (supprimée à la main, config perdue) n'est pas une branche retirée : elle n'est pas rejouée, et rien n'est dit « abandonné ».
    const br = lotBranch(c.wave.id, l.project, l.lot);
    if (branchExists(l.repo, br)) return refuse(`intégration impossible : la branche ${br} existe mais n'est plus marquée comme worktree de cadence (branch.${br}.cadence-base absente) : rien n'est intégré ni retiré, à vérifier à la main`);
    return refuse("intégration impossible : le worktree du lot n'existe plus (retiré par --remove-worktree ?) : commits abandonnés, sa branche n'est plus là pour être intégrée");
  }
  const t = c.tree;
  const kept = `worktree conservé : ${t.dir}`;
  const waitMs = c.wave.integrate?.waitMs ?? INTEGRATE_WAIT_MS;
  await awaitOlder(c); // L558 (R8) : avant le verrou, la fin d'un lot plus ancien de la vague qui travaille déjà sur une ressource à chemins que le diff touche
  const grant = await awaitTurn(c);
  if (!grant.ok) return refuse(`intégration refusée : verrou d'intégration tenu par ${grant.holder.wave} (pid ${grant.holder.pid}) depuis plus de ${minutesText(waitMs)} ; ${kept}`);
  // Un refus tardif garde `l.verdict` avec la trace de la revue courte déjà jouée : reprise, elle est rejouée et remplace l'ancienne trace au lieu de s'y ajouter.
  let verdict = (l.verdict ?? '').split(SHORT_REVIEW_TRACE)[0];
  let reporte: Reporte | undefined;
  let start = '';
  try {
    const moved = leadMoved(l.repo, t.base);
    if (moved) return refuse(`intégration refusée : ${moved} ; branche conservée : ${t.branch}`);
    start = git(l.repo, 'rev-parse', `refs/heads/${t.base}`);
    // Une branche déjà contenue dans celle du dépôt (arrêt entre l'avance et l'écriture du verdict) : ni rebase ni avance, seul le plan reste à écrire (R23).
    if (!integrated(l.repo, t.branch, t.base)) {
      // Le verdict de départ et le commit relu servent à chaque tour : un rebase rejoué repart d'eux, pas des traces ni du sommet du tour précédent.
      const opening = verdict;
      const reviewed = l.code?.head ?? git(t.dir, 'rev-parse', 'HEAD');
      for (let replays = 0; ; replays++) {
        verdict = opening;
        reporte = undefined;
        const rebased = rebaseOnto(t.dir, t.base);
        if (rebased.kind === 'conflict') return refuse(`${conflictRefusal(l.repo, t, rebased)} ; ${kept}`);
        if (rebased.kind === 'rebased') rebaseNotes(rebased, key).forEach((note) => c.wave.log(note));
        const tip = git(t.dir, 'rev-parse', 'HEAD');
        // Le contrôle de forme du CHANGELOG (L619) coûte une lecture : il passe avant la porte complète, qui ne le ferait voir qu'après cinq minutes.
        const shape = changelogShapeOf(t.dir, t.base);
        if (shape.length) return refuse(`intégration refusée : CHANGELOG.md mal formé au sommet intégré (${shape.join(' ; ')}) ; branche du dépôt inchangée, ${kept}`);
        // Tests et build joués au sommet (L590, R5 : la suite complète, une fois par sommet), avant que la branche du dépôt ne bouge (R7).
        const red = await integrationChecks(c, key, t.dir, tip, reviewed);
        if (red.length) return refuse(`intégration refusée : tests rouges au sommet intégré (${red.map(redExcerpt).join(' ; ')}) ; branche du dépôt inchangée, ${kept}`);
        if (tip !== reviewed) {
          const before = patchId(t.dir, mergeBase(t.dir, reviewed, t.base), reviewed);
          const after = patchId(t.dir, t.base, 'HEAD');
          if (before !== '' && before === after) {
            const vers = lotWork(histPlan(c), t.dir, l.lot)[0]?.sha ?? tip;
            reporte = { de: reviewed, vers, patchId: before };
          } else {
            // Le diff du lot n'est plus celui qui a été relu (contexte modifié, conflit résolu) : une revue courte du diff rebasé avant l'avance (R17).
            const short = await shortReview(c);
            if (short === null) return;
            l.constats = [];
            if (short.refused) return refuse(shortRefusal(c, short, kept));
            verdict = `${verdict}${SHORT_REVIEW_TRACE}${short.verdict}`;
            l.verdict = verdict;
          }
        }
        // Les contrôles rejoués et la revue courte ont pu durer : le lead a pu changer de branche ou salir son arbre depuis le contrôle du départ (R24, R8), ou un tiers a pu prendre le dépôt libéré par la vague porteuse (L553, `lateRefusal`).
        const late = lateRefusal(c.wave, l.repo, t.base);
        if (late) return refuse(`intégration refusée : ${late} ; branche du dépôt inchangée, ${kept}`);
        try {
          advance(l.repo, t.branch);
          break;
        } catch (e) {
          // L364 : un commit est tombé sur la branche du dépôt pendant le rebase, les contrôles ou la revue courte (plan du lead, autre lot) : l'avance n'est plus une avance rapide.
          if (!baseMoved(l.repo, t.branch, t.base)) throw e;
          if (replays >= MAX_REPLAYS) return refuse(`intégration refusée : ${t.base} a encore avancé après ${MAX_REPLAYS} rebases rejoués ; branche du dépôt inchangée par le lot, ${kept}`);
          c.wave.log(`${key} ${t.base} a avancé pendant l'intégration, rebase rejoué (${replays + 1}/${MAX_REPLAYS})`);
        }
      }
    }
    const end = git(l.repo, 'rev-parse', `refs/heads/${t.base}`);
    if (end !== start) c.wave.log(`${key} intégré : ${start.slice(0, 7)}..${end.slice(0, 7)}`);
    if (reporte) c.wave.log(`${key} verdict reporté : ${reporte.de.slice(0, 7)} → ${reporte.vers.slice(0, 7)} (patch-id identique)`);
    // Le plan, sous le même verrou, après l'avance : un commit de plan seul au sommet de la branche du dépôt, `commit` = dernier commit de travail intégré (R23).
    const commit = lotWork(c.loadPlan(), l.repo, l.lot)[0]?.sha ?? null;
    // Aucun commit de travail au sommet : il n'y a rien d'intégré, donc rien qu'un verdict conforme puisse couvrir.
    if (commit === null) return refuse(`intégration impossible : aucun commit du lot dans ${t.base} (commits abandonnés ?) ; ${kept}`);
    const refusal = await writeVerdict(c, verdict, commit, reporte);
    if (refusal) return refuse(`écriture du plan refusée : ${refusal}`);
  } catch (e) {
    return refuse(`intégration impossible : ${gitFailure(e)} ; ${kept}`);
  } finally {
    grant.release();
  }
  // Intégré : le worktree et la branche, propres et fusionnés, sont retirés (R12) ; sinon ils restent et le journal le dit.
  const removed = removeTree({ repo: l.repo, dir: t.dir, branch: t.branch, base: t.base });
  if (!removed.ok) c.wave.log(`orchestrate : ${key} : worktree conservé : ${t.dir} (branche ${t.branch})`);
  else t.active = false;
  l.next = null;
  transition(c, 'ready', 'prêt à livrer');
}

/** Le refus de la revue courte (L585) : ses constats entrent dans l'état du lot (`--status`) et au journal, une ligne chacun, comme ceux d'une revue complète ; rend le motif du refus. */
function shortRefusal(c: LotCtx, short: { refused: string; constats?: Constat[] }, kept: string): string {
  const l = c.lot;
  l.constats = short.constats ?? [];
  for (const k of l.constats) c.wave.log(`${lotKey(l.project, l.lot)} · revue courte : ${k.gravite} ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`);
  return `intégration refusée : revue courte du diff rebasé : ${short.refused} ; branche du dépôt inchangée, ${kept}`;
}

/**
 * Revue courte (`review-small`) du diff rebasé (R17), jouée sous le verrou d'intégration. `refused` : le nombre de constats bloquants ou majeurs, dit en clair ;
 * `null` : la session n'a pas eu lieu (budget, quota, arrêt) et le lot est suspendu ou rendu par `session`.
 */
async function shortReview(c: LotCtx): Promise<{ verdict: string; refused?: undefined; constats?: undefined } | { refused: string; constats?: Constat[]; verdict?: undefined } | null> {
  c.integration = { base: c.tree!.base };
  try {
    const done = await session(c, 'review-small');
    if (!done) return null;
    const rep = checkShape<ReviewReport>(done.report, REVIEW_SCHEMA);
    const n = rep.bloquants + rep.majeurs;
    if (n > 0) return { refused: `${n} constat(s) bloquant(s) ou majeur(s)`, constats: blockingConstats(rep, 'code') };
    return { verdict: rep.verdict };
  } catch (e) {
    return { refused: `rapport illisible (${(e as Error).message})` };
  } finally {
    c.integration = undefined;
  }
}