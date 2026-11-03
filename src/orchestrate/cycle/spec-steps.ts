import { type LotCtx, hasSpecStage, workDir as wd, histPlan, stop, transition, save } from './ctx.js';
import { type SessionKind } from '../launch.js';
import { findFiche, ficheReady, lightLot, answerAltersRule, sourceRules, LEAD_SOURCE, checkSpec, costlyHypotheses, hypothesisLines } from '../spec.js';
import { partsOf, ficheOf, specBudget } from './brief.js';
import { acceptationProof, NO_ACCEPT, lotAcceptation, listed } from './accept-step.js';
import { redSha, parseAcceptation } from '../accept.js';
import { git } from '../worktree.js';
import { posix, join, relative, resolve, isAbsolute } from 'node:path';
import { readCommits, changedFiles } from '../../git.js';
import { readFileSync } from 'node:fs';
import { lotWork } from '../../audit.js';
import { leadAnswerMessage } from '../../plan-commit.js';
import { planTemplate, noteHypotheses, noteMinors } from './plan-writes.js';
import { session, badReport } from './session.js';
import { type SpecReport, checkShape, SPEC_SCHEMA, type ReviewReport, REVIEW_SCHEMA, summarize } from '../schemas.js';
import { takeReport, dirtAfter, addProposals, blockingConstats } from './shared.js';
import { parse } from 'yaml';
import { lotKey } from '../state.js';
import { bulletLines } from '../maquette.js';
/** Première session d'écriture d'un lot : la spec quand il déclare `screen:` ou `spec: true` et qu'aucune fiche n'est écrite, sinon l'implémentation. */
export function firstWrite(c: LotCtx): SessionKind {
  const l = c.lot;
  if (!hasSpecStage(l) || l.spec) return 'implement';
  const fiche = findFiche(wd(c), c.config.spec.dir, l.lot);
  return fiche && ficheReady(wd(c), fiche, l.lot, partsOf(c, fiche)) ? afterSpec(c, fiche) : 'spec';
}/**
 * Étape qui suit une spec écrite : la revue UX de la maquette (S4) tant qu'elle n'est pas conforme (`orchestrate.maquette`), sauf si une
 * acceptation conforme est déjà commitée (elle n'a pu être écrite qu'après la revue) ; puis les tests d'acceptation rouges (S5).
 */
function afterSpec(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  // Revue de la fiche back (L188) d'abord, puis celle de la maquette d'un lot mixte ; la même preuve (acceptation scellée, code déjà commité) dispense des deux.
  if (c.config.fiche && partsOf(c, fiche).back && !l.fiche?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'fiche';
  return afterFiche(c, fiche);
}/** Étape qui suit une fiche relue : la revue UX de la maquette d'un lot à écran (S4), sinon `afterMaquette`. */
function afterFiche(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  if (l.screen && c.config.maquette && !l.maquette?.conforme && !acceptationProof(c, fiche) && !codeAfterFiche(c, fiche)) return 'maquette';
  return afterMaquette(c, fiche);
}/** Étape qui suit une maquette relue (ou une fiche, pour un lot sans écran) : les tests d'acceptation rouges (S5) quand le projet déclare sa commande dédiée et qu'aucune acceptation conforme n'est déjà commitée, sinon l'implémentation. */
function afterMaquette(c: LotCtx, fiche: string): SessionKind {
  const l = c.lot;
  // Des constats de la revue de fiche attendent la revue de la maquette (lot mixte) : les deux partent ensemble à la seconde passe `spec`.
  if (l.ficheConstats?.length) return 'spec';
  // Une maquette légère n'a pas de règles de comportement à verrouiller : pas d'accept, même si orchestrate.accept est déclaré.
  if (lightLot(l, c.loadPlan().lot(l.lot), c.config.maquette, wd(c), c.config.spec.dir)) return 'implement';
  if (!c.config.accept) {
    if (!l.warnings.includes(NO_ACCEPT)) l.warnings.push(NO_ACCEPT);
    return 'implement';
  }
  const json = lotAcceptation(c, fiche);
  if (acceptationProof(c, fiche)) {
    l.accept = { acceptation: json, rouge: redSha(wd(c), json) ?? '' };
    return 'implement';
  }
  return 'accept';
}/** Le lot a déjà du code commité après sa fiche : l'implémentation n'a pu partir qu'une fois la maquette relue, la revue n'est pas rejouée (même sans `orchestrate.accept`). */
function codeAfterFiche(c: LotCtx, fiche: string): boolean {
  const l = c.lot;
  let sha: string;
  try {
    // Le point de départ est le commit qui a créé la fiche : un commit plus récent du dossier (capture corrigée) ne doit pas masquer le code commité avant lui.
    sha = git(wd(c), 'log', '--diff-filter=A', '--format=%H', '--', fiche).split('\n').filter(Boolean).pop() ?? git(wd(c), 'log', '-1', '--format=%H', '--', posix.dirname(fiche));
  } catch {
    return false;
  }
  if (!sha) return false;
  const dir = `${posix.dirname(fiche)}/`;
  const after = new Set(readCommits(wd(c), { range: `${sha}..HEAD` }).map((k) => k.sha));
  // Un commit de la session spec elle-même (fiche, maquette, captures) ou de la session accept (tests listés) n'est pas du code.
  const tests = new Set<string>();
  const json = lotAcceptation(c, fiche);
  if (listed(c, json)) {
    const doc = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
    if (typeof doc !== 'string') for (const f of doc.fichiers) tests.add(posix.normalize(f));
  }
  return lotWork(histPlan(c), wd(c), l.lot).some((k) => after.has(k.sha) && changedFiles(wd(c), k.sha).some((f) => !f.startsWith(dir) && !tests.has(f)));
}/**
 * La réponse du lead à une question sur des hypothèses coûteuses de la fiche (L297) : le programme passe lui-même ces règles en `sourcee`
 * (`réponse du lead, <date>, vague <id>`) et commite la fiche AVANT la session spec reprise, qui pourrait être perdue ou ne rien écrire — la fiche est alors
 * conforme quand la revue de fiche la lit. Une réponse qui supprime ou change la règle (`answerAltersRule`) n'en source aucune. Rend vrai quand le lot est rendu (fiche introuvable, commit refusé).
 */
function sourceAnsweredRules(c: LotCtx): boolean {
  const l = c.lot;
  if (!l.pendingAnswer || !l.specAsked?.length || !l.specAskedRules?.length) return false;
  if (answerAltersRule(l.pendingAnswer)) return false; // le lead corrige la règle : la session spec reprise l'applique, sinon la question lui revient (L302)
  const fiche = ficheOf(c);
  if (!fiche) return false; // la session spec reprise l'écrira : l'ancienne consigne s'applique
  try {
    const ids = sourceRules(wd(c), fiche, l.specAskedRules, `${LEAD_SOURCE}, ${c.wave.today}, vague ${c.wave.id}`);
    if (!ids.length) return false;
    git(wd(c), 'add', '--', fiche);
    git(wd(c), 'commit', '-q', '-m', leadAnswerMessage(planTemplate(c), l.lot, ids, c.wave.id), '--', fiche);
    return false;
  } catch (e) {
    stop(c, 'handed-back', `réponse du lead non reportée dans la fiche ${fiche} : ${(e as Error).message.split('\n')[0]}`);
    return true;
  }
}/**
 * Étape spec (L171, spec etape-spec S3) : la session écrit maquette, captures et fiche dans `<spec.dir>/<écran>/`, le programme
 * en relève les écarts (une seconde passe, puis le lot est rendu), une hypothèse coûteuse à défaire devient une question au lead,
 * et une sortie sous le seuil (le lot ne change aucun écran) rend le lot au chemin actuel.
 */
export async function specStep(c: LotCtx): Promise<void> {
  const l = c.lot;
  if (sourceAnsweredRules(c)) return;
  const done = await session(c, 'spec');
  if (!done) return;
  l.specRuns = (l.specRuns ?? 0) + 1;
  let rep: SpecReport;
  try {
    rep = checkShape<SpecReport>(done.report, SPEC_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const questions = takeReport(c, done, rep);
  if (questions.length) {
    l.questions = questions;
    l.specRuns = undefined; // la réponse ouvre un nouveau budget de sessions
    l.specAsked = undefined; // la prochaine réponse porte sur la question de la session, pas sur d'anciennes hypothèses coûteuses
    l.specAskedRules = undefined;
    l.next = 'spec';
    transition(c, 'question', questions[0]);
    return;
  }
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après spec : ${dirt.join(', ')}`);
    return;
  }

  const reason = rep.sousSeuil.trim();
  if (reason) {
    l.spec = { sousSeuil: reason };
    l.specProblems = undefined;
    l.warnings.push(`étape spec : sous le seuil, ${l.screen ? 'aucune maquette' : 'aucune fiche'} — ${reason}`);
    l.next = 'implement';
    save(c);
    return;
  }

  // Le chemin du rapport est ramené relatif au dépôt (absolu, `./…` ou `a/../b` donneraient de faux écarts) ; hors du dépôt, c'est un écart.
  const reported = rep.fiche.trim();
  const asked = reported ? relative(wd(c), resolve(wd(c), reported)) : '';
  const outside = asked === '..' || asked.startsWith('../') || isAbsolute(asked);
  const fiche = outside ? '' : asked || findFiche(wd(c), c.config.spec.dir, l.lot) || '';
  const what = l.screen ? '<écran>' : '<sujet>';
  const inDir = fiche === '' || fiche.startsWith(`${c.config.spec.dir.replace(/\/+$/, '')}/`);
  const problems = !outside && fiche && !inDir ? [`${fiche} : fiche hors de ${c.config.spec.dir} (la spec vit dans ${c.config.spec.dir}/${what}/fiche.yaml, où l'étape la retrouve)`] : outside ? [`${reported} : fiche hors du dépôt (le chemin de « fiche » est relatif au dépôt : ${c.config.spec.dir}/${what}/fiche.yaml)`] : fiche ? checkSpec(wd(c), fiche, l.lot, partsOf(c, fiche)) : [`aucune fiche écrite : ${c.config.spec.dir}/${what}/fiche.yaml est attendue (ou une raison dans « sousSeuil » si le lot ne change ${l.screen ? 'aucun écran' : 'aucun comportement'})`];
  if (problems.length) {
    if ((l.specRuns ?? 0) >= specBudget(c)) {
      stop(c, 'handed-back', `spec non conforme après ${specBudget(c)} passes : ${problems.join(' ; ')}`);
      return;
    }
    l.specProblems = problems;
    l.next = 'spec';
    save(c);
    return;
  }
  l.specProblems = undefined; // les contrôles passent : les écarts de la passe précédente sont corrigés
  const doc = parse(readFileSync(join(wd(c), fiche), 'utf8')) as { regles?: { statut?: unknown }[]; sujet?: { id?: unknown } };
  // Un choix coûteux à défaire n'est pas une hypothèse : la question remonte au lead, la session reprend avec sa réponse.
  const costly = costlyHypotheses(doc);
  if (costly.length) {
    l.questions = costly.map((x) => `${x.id} est posée comme hypothèse mais touche un choix coûteux à défaire (${x.categorie}) : « ${x.siFaux} » — la confirmer, ou la corriger, avant que la fiche serve de référence.`);
    l.specAsked = [...l.questions];
    l.specAskedRules = costly.map((x) => x.id);
    l.specRuns = undefined; // la réponse du lead ouvre un nouveau budget de sessions, comme celle d'une question de la session
    l.next = 'spec';
    transition(c, 'question', l.questions[0]);
    return;
  }
  l.specAsked = undefined;
  l.specAskedRules = undefined;
  l.spec = { fiche, hypotheses: (doc.regles ?? []).filter((r) => r.statut === 'hypothese').length };
  l.specProblems = undefined;
  l.hypotheses = undefined; // la fiche vient d'être (ré)écrite : ses hypothèses se posent une fois la fiche relue, pas avant (settleHypotheses)
  // Les constats de la revue de fiche ont servi à cette passe : sans nouvelle revue de fiche derrière (partie back retirée, preuve d'acceptation), ils ne renvoient pas encore à la spec.
  const kept = l.ficheConstats;
  l.ficheConstats = undefined;
  l.next = afterSpec(c, fiche);
  if (l.next === 'fiche') l.ficheConstats = kept; // la seconde revue de fiche les relit
  save(c);
}/**
 * Un lot sans écran n'a pas de Nouveauté : les hypothèses de sa fiche vont en notes du lot (une par règle) et au tableau de fin de vague (spec
 * etape-spec-back § 7). Elles se lisent sur la fiche FINALE, juste avant `accept` ou `implement` : après la revue de la fiche et sa seconde passe
 * (une hypothèse changée ou retirée en passe 2 ne laisse pas la note de la passe 1), et aussi pour une fiche déjà présente à la reprise.
 * Rend vrai quand le lot est rendu.
 */
export async function settleHypotheses(c: LotCtx): Promise<boolean> {
  const l = c.lot;
  if (l.screen || !l.specLot || l.hypotheses !== undefined || (l.spec && !('fiche' in l.spec))) return false;
  const fiche = ficheOf(c);
  if (!fiche) return false;
  let doc: { sujet?: { id?: unknown } };
  try {
    doc = parse(readFileSync(join(wd(c), fiche), 'utf8')) as typeof doc;
  } catch {
    return false;
  }
  return noteHypotheses(c, hypothesisLines(doc), typeof doc.sujet?.id === 'string' ? doc.sujet.id : posix.basename(posix.dirname(fiche)));
}/** Ce qui distingue les deux revues de la spec : la fiche back relue par code-reviewer (L188), la maquette relue par ux-reviewer (L172). */
interface SpecReview {
  kind: 'fiche' | 'maquette';
  /** Nom de l'objet relu dans les messages (« la fiche », « la maquette »). */
  label: string;
  source: 'code' | 'ux';
  /** Étape suivante quand la relecture est conforme, ou quand la seconde passe `spec` doit d'abord avoir lieu (constats gardés). */
  after: (c: LotCtx, fiche: string) => SessionKind;
  /** Étape suivante quand des constats renvoient à la spec. */
  retry: (c: LotCtx, fiche: string) => SessionKind;
}const FICHE_REVIEW: SpecReview = { kind: 'fiche', label: 'fiche', source: 'code', after: afterFiche, retry: afterFiche };const MAQUETTE_REVIEW: SpecReview = { kind: 'maquette', label: 'maquette', source: 'ux', after: afterMaquette, retry: () => 'spec' };/**
 * Revue de la spec (fiche ou maquette) : une session de lecture seule. Un bloquant ou un majeur renvoie à la spec (avec les constats ; pour un lot mixte, ceux des deux revues ensemble), puis la spec est relue : deux revues pour la fiche,
 * `orchestrate.maquetteReviews` pour la maquette, dans le plafond de sessions spec du lot (`specBudget`) ; ce qui reste à la dernière revue est rendu au lead.
 * Les mineurs de la fiche vont en notes du lot (ceux de la maquette restent des propositions). Ce verdict n'est pas `raf review` ni `raf ux` : la revue après code garde ce rôle.
 */
async function reviewSpecStep(c: LotCtx, r: SpecReview): Promise<void> {
  const l = c.lot;
  const fiche = ficheOf(c);
  if (!fiche) {
    l.warnings.push(`revue de la ${r.label} ignorée : aucune fiche trouvée pour ce lot`);
    l.next = 'implement';
    save(c);
    return;
  }
  const done = await session(c, r.kind);
  if (!done) return;
  let rep: ReviewReport;
  try {
    rep = checkShape<ReviewReport>(done.report, REVIEW_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const summary = summarize(rep, done.after.head ?? '');
  const passes = (l[r.kind]?.passes ?? 0) + 1;
  // Fiche : les mineurs sont des notes du lot (design § 4). Maquette : inchangé (propositions du tableau final).
  addProposals(c, rep, r.kind, summary.head, r.kind !== 'fiche');
  // Un lot rendu sur le refus d'écrire ses notes (R26) rejoue cette revue à la reprise : le compte des passes n'est posé qu'une fois les notes écrites.
  if (r.kind === 'fiche' && (await noteMinors(c, rep, `la ${r.label}`))) return;
  l[r.kind] = { passes, conforme: summary.conforme, verdict: summary.verdict };
  const constats = blockingConstats(rep, r.source);
  if (r.kind === 'maquette' && passes >= 2) {
    // Lu sur rep.constats : blockingConstats ne garde pas `inchange`. Seul le booléen vrai est une marque (checkShape ne descend pas dans constats[]).
    for (const k of rep.constats) if ((k.gravite === 'bloquant' || k.gravite === 'majeur') && k.inchange === true) c.wave.log(`${lotKey(l.project, l.lot)} · défaut de revue : maquette, revue ${passes}, majeur sur un point inchangé absent de la revue ${passes - 1} : ${k.texte}`);
  }
  const key = r.kind === 'fiche' ? 'ficheConstats' : 'maquetteConstats';
  if (summary.conforme) {
    l[key] = undefined;
    l.next = r.after(c, fiche);
    save(c);
    return;
  }
  const reviews = r.kind === 'maquette' ? c.config.maquetteReviews : 2;
  if (passes >= reviews) {
    stop(c, 'handed-back', `${r.label} non conforme après ${reviews} revue${reviews > 1 ? 's' : ''} : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
    return;
  }
  // Le budget de sessions spec est épuisé (écarts du programme compris) : un renvoi à la spec serait une session de trop.
  if ((l.specRuns ?? 0) >= specBudget(c)) {
    stop(c, 'handed-back', `${r.label} non conforme et la spec a déjà joué ${specBudget(c)} sessions : ${summary.verdict}\n${bulletLines(constats).join('\n')}`);
    return;
  }
  l[key] = constats.length ? constats : [{ source: r.source, gravite: 'majeur', texte: summary.verdict }];
  l.next = r.retry(c, fiche);
  save(c);
}export const ficheStep = (c: LotCtx): Promise<void> => reviewSpecStep(c, FICHE_REVIEW);export const maquetteStep = (c: LotCtx): Promise<void> => reviewSpecStep(c, MAQUETTE_REVIEW);