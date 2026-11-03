import { type Plan } from '../../plan.js';
import { type LotRepo } from '../../repos.js';
import { hasWork } from './shared.js';
import { citesPriorWork, localYesNote, keepPrecheckReading, precheckNothingToFind } from '../precheck.js';
import { type LotCtx, save, stop, histPlan, workDir as wd } from './ctx.js';
import { type PrecheckReport, checkShape, PRECHECK_SCHEMA } from '../schemas.js';
import { session, LOCAL_FAILED, benchLocal } from './session.js';
import { LOCAL_PRECHECK_UNREADABLE, PRECHECK_UNREADABLE } from '../state.js';
import { firstWrite } from './spec-steps.js';
/**
 * Le contrôle préalable ne vaut que pour un lot sans commit (avec des commits, l'implémentation reprend légitimement) dont le
 * titre ou le goal (clé `goal:` du plan, ou `goal` donné au lancement) cite un constat ou un autre lot (L288, L292) : sans cela
 * rien ne laisse croire qu'un autre lot l'a déjà livré, et le contrôle coûtait 7 % des tokens pour 10 « oui » sur 30 mesurés
 * (audit du 24-10). Sur le modèle local (`precheck: local`, L296) le critère tombe : le titre faisait perdre 7 des 17 « oui »
 * réels, et le contrôle ne coûte plus rien au quota (seul un « oui » est confirmé par Sonnet).
 */
export function needsPrecheck(config: { precheck: boolean; precheckLocal?: boolean }, plan: Plan, repo: string, lot: string, repos: LotRepo[] = [], goal?: string): boolean {
  if (!config.precheck || hasWork(plan, repo, { repos, lot })) return false;
  if (config.precheckLocal) return true;
  const l = plan.lot(lot);
  const text = [l.title, l.goal, goal].filter(Boolean).join('\n');
  return citesPriorWork(text, lot, plan.lots().map((x) => x.id));
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
      } else if (rep) rep.lu = undefined; // « non » ou « partiel » du local, accepté sans relecture par Sonnet : sa lecture n'est pas gardée (L523)
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

/** Le lot passe-t-il par le contrôle préalable ? Un lot qui n'a rien à retrouver (L322) saute l'étape, et le journal du lot le dit. */
export function precheckOrSkip(c: LotCtx): boolean {
  const plan = c.loadPlan();
  if (c.lot.express || !needsPrecheck(c.config, plan, c.lot.repo, c.lot.lot, c.lot.repos, c.lot.goal)) return false;
  const nothing = precheckNothingToFind(histPlan(c), wd(c), c.lot.lot, c.lot.repos, c.lot.goal);
  if (nothing) c.lot.warnings.push(`contrôle préalable sauté : ${nothing}`);
  return !nothing;
}