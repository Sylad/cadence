import { type Plan } from '../../plan.js';
import { type LotRepo } from '../../repos.js';
import { hasWork } from './shared.js';
import { citesPriorWork, localYesNote, keepPrecheckReading, precheckNothingToFind } from '../precheck.js';
import { type LotCtx, save, stop, histPlan, workDir as wd, hasSpecStage } from './ctx.js';
import { type PrecheckReport, checkShape, PRECHECK_SCHEMA } from '../schemas.js';
import { session, LOCAL_FAILED, benchLocal } from './session.js';
import { LOCAL_PRECHECK_UNREADABLE, PRECHECK_UNREADABLE } from '../state.js';
import { firstWrite } from './spec-steps.js';
/**
 * Le contrôle préalable ne vaut que pour un lot sans commit (avec des commits, l'implémentation reprend légitimement) dont le
 * titre ou le goal (clé `goal:` du plan, ou `goal` donné au lancement) cite un constat ou un autre lot (L288, L292) : sans cela
 * rien ne laisse croire qu'un autre lot l'a déjà livré, et le contrôle coûtait 7 % des tokens pour 10 « oui » sur 30 mesurés
 * (audit du 24-10). Sur le modèle local (`precheck: local`, L296) le critère tombe : le titre faisait perdre 7 des 17 « oui »
 * réels, et le contrôle ne coûte plus rien au quota (seul un « oui » est confirmé par Sonnet). Un lot à étape de spec (`screen:`
 * ou `spec: true` du plan, ou `specStage` posé au lancement) passe aussi par le contrôle (L666) : sa lecture liste les cas limites
 * de la règle que la spec reçoit avant d'être écrite ; sans elle, un tiers des lots à fiche (13 sur 38 au 06-11) partait en spec à froid.
 */
export function needsPrecheck(config: { precheck: boolean; precheckLocal?: boolean }, plan: Plan, repo: string, lot: string, opts: PrecheckOpts = {}): boolean {
  if (!config.precheck || hasWork(plan, repo, { repos: opts.repos ?? [], lot })) return false;
  if (config.precheckLocal) return true;
  const l = plan.lot(lot);
  if (opts.specStage || l.screen || l.spec) return true;
  const text = [l.title, l.goal, opts.goal].filter(Boolean).join('\n');
  return citesPriorWork(text, lot, plan.lots().map((x) => x.id));
}

/** Ce que le lancement ajoute au plan pour décider du contrôle : dépôts voisins, goal donné au lancement, étape de spec posée au lancement (`--screen`). */
export interface PrecheckOpts { repos?: LotRepo[]; goal?: string; specStage?: boolean }

/**
 * Raison de sauter le contrôle d'un lot qui le mérite, ou null : un lot qui n'a rien à retrouver (L322) ; jamais un lot à étape
 * de spec (L666), dont le contrôle a aussi les cas limites de la règle à lister pour la spec.
 */
export function precheckSkipReason(plan: Plan, root: string, lot: string, opts: PrecheckOpts = {}): string | null {
  return opts.specStage ? null : precheckNothingToFind(plan, root, lot, opts.repos, opts.goal);
}

/**
 * Contrôle préalable (L77) : une session de lecture seule cherche si le livrable du lot est déjà dans le dépôt (fait par un
 * autre lot). « oui » rend le lot sans ouvrir d'implémentation ; « partiel » joint le constat au brief de l'implémentation.
 * Un rapport illisible ne bloque pas : avertissement, l'implémentation part.
 */
export async function precheck(c: LotCtx): Promise<void> {
  const l = c.lot;
  let rep: PrecheckReport | null = null;
  let localYes = false;
  if (c.config.precheckLocal && c.wave.localOut) {
    l.warnings.push(`contrôle préalable : modèle local écarté pour la vague (${c.wave.localOut}), Sonnet directement`);
  } else if (c.config.precheckLocal) {
    // Modèle local (L146) : un échec, un rapport illisible ou un « oui » (qui rendrait le lot sans implémentation) rend la main à Sonnet.
    const done = await session(c, 'precheck', true);
    if (!done) return;
    if (done !== LOCAL_FAILED) {
      try {
        rep = checkShape<PrecheckReport>(done.report, PRECHECK_SCHEMA);
      } catch (e) {
        l.warnings.push(`${LOCAL_PRECHECK_UNREADABLE} (${(e as Error).message}), repli sur Sonnet`);
        benchLocal(c, `rapport illisible : ${(e as Error).message}`);
      }
      if (rep?.dejaPresent === 'oui') {
        localYes = true;
        rep = null;
      } else if (rep) rep.lu = undefined; // « non » ou « partiel » du local, accepté sans relecture par Sonnet : sa lecture n'est pas gardée (L523), cas limites d'un lot à spec compris (L666)
    }
  }
  if (!rep) {
    const done = await session(c, 'precheck');
    if (!done) return;
    try {
      rep = checkShape<PrecheckReport>(done.report, PRECHECK_SCHEMA);
    } catch (e) {
      l.warnings.push(`${PRECHECK_UNREADABLE} : ${(e as Error).message}`);
      l.next = firstWrite(c);
      save(c);
      return;
    }
  }
  if (localYes) l.warnings.push(localYesNote(rep.dejaPresent));
  const proofs = rep.preuves.length ? ` (${rep.preuves.join(' ; ')})` : '';
  // « oui » sans preuve ne se vérifie pas : il vaut « partiel », l'implémentation part avec le constat.
  const unproven = rep.dejaPresent === 'oui' && rep.preuves.length === 0;
  l.precheckVerdict = unproven ? 'partiel' : rep.dejaPresent;
  if (unproven) l.warnings.push('contrôle préalable : « oui » sans preuve, traité comme partiel');
  if (rep.dejaPresent === 'oui' && !unproven) {
    stop(c, 'handed-back', `livrable déjà présent : ${rep.resume.trim()}${proofs}`);
    return;
  }
  if (rep.dejaPresent === 'partiel' || unproven) {
    l.precheck = `A pre-check found part of the deliverable already in the repository (do not redo it): ${rep.resume.trim()}${proofs}`;
    l.warnings.push(`contrôle préalable : livrable en partie présent — ${rep.resume.trim()}${proofs}`);
  }
  keepPrecheckReading(l, rep.lu);
  l.next = firstWrite(c);
  save(c);
}

/** Le lot passe-t-il par le contrôle préalable ? Un lot qui n'a rien à retrouver (L322, sauf à étape de spec, L666) saute l'étape, et le journal du lot le dit. */
export function precheckOrSkip(c: LotCtx): boolean {
  const opts: PrecheckOpts = { repos: c.lot.repos, goal: c.lot.goal, specStage: hasSpecStage(c.lot) };
  if (c.lot.express || !needsPrecheck(c.config, c.loadPlan(), c.lot.repo, c.lot.lot, opts)) return false;
  const nothing = precheckSkipReason(histPlan(c), wd(c), c.lot.lot, opts);
  if (nothing) c.lot.warnings.push(`contrôle préalable sauté : ${nothing}`);
  return !nothing;
}