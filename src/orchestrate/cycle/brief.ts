import { parse } from 'yaml';
import { join, posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { lotWork } from '../../audit.js';
import { readDocsConfig } from '../../config.js';
import { articlesBrief, docSyncBrief, lotDocSyncGaps, type DocSyncGap, type DocSyncRule } from '../../docsync.js';
import { partageBrief } from '../partage.js';
import { probeVars } from '../probe.js';
import { repoWork } from '../../repos.js';
import { testWorkersText } from '../workers.js';
import { withClusterLine } from '../objectif.js';
import { readBounds, boundsText } from '../../bounds.js';
import { docsFollowText } from '../../doc-follow.js';
import { capturesText, EXPRESS_BRIEF, expressNewsText, gateText, headline, integrationText, localReading, precheckBrief, newsText, objective, renderBrief, reposText, shotsText, visibleFixText, TEMPLATES_DIR, tiersText, tmpText, type BriefName, type BriefVars } from '../briefs.js';
import type { Screen } from '../../plan.js';
import { mcpServersFor, playwrightDir, type SessionKind } from '../launch.js';
import { acceptationFile, acceptText, findAcceptation } from '../accept.js';
import { lotIds, referenceIdsText } from '../../ref/coverage.js';
import { reglesDuLotPourBrief } from '../accept-regles.js';
import { avalFicheText, ficheContracts, ficheRules, hasScreenPart } from '../aval.js';
import { ficheReviewText, reviewedSheetText } from '../fiche.js';
import { maquetteText, reviewedText } from '../maquette.js';
import { worstUxText } from '../pires-cas.js';
import { answeredText, ficheHasBack, findFiche, lightLot, ruleIdsSourcedByLead, specText, visibleFix, type FicheParts } from '../spec.js';
import { decisionsText, humanDecisions } from '../decisions.js';
import { type Constat, type LotState } from '../state.js';
import { git } from '../worktree.js';
import { DOCS_GAP } from '../geste.js';
import { convergeText } from './retreci.js';
import { fixConstatsText } from '../constat-classes.js';
import { type LotCtx, workDir as wd, histPlan, short, startSha, hasSpecStage } from './ctx.js';

function lotCommitLines(c: LotCtx): string {
  const plan = histPlan(c);
  const mine = lotWork(plan, wd(c), c.lot.lot).reverse().map((k) => `- ${short(k)}`);
  const theirs = (c.lot.repos ?? []).flatMap((r) => repoWork(plan, r, c.lot.lot).reverse().map((k) => `- [${r.rel}] ${short(k)}`));
  return [...mine, ...theirs].join('\n');
}

/** Consigne de captures : `uxText` n'alimente que `ux` et `review-small` d'un petit lot visible, deux étapes qui chargent toujours le serveur Playwright de la vague. */
const shotsAt = (dir: string): string => `Take screenshots at 1440 and 390 px width, in the wave's capture directory (outside the repository), each named with its full path, e.g. \`${dir}/home-1440px.png\`.`;

function uxText(c: LotCtx): string {
  const ux = c.config.ux;
  const SHOTS_TEXT = shotsAt(playwrightDir(c.wave.store.lotDir(c.lot.project, c.lot.lot)));
  if (!ux) {
    return 'No way to run the app is declared (cadence.yaml: orchestrate.ux): review the interface from the code, and list under "nonVerifie" what you could not see.';
  }
  if (c.app?.kind === 'ready') return [`The running app is at ${ux.url}.`, SHOTS_TEXT].join(' ');
  if (c.app) return `The app could not be verified (${c.app.kind === 'busy' ? 'the port is already in use' : 'it did not start'}): review the interface from the code, and list under "nonVerifie" what you could not see.`;
  return [
    ux.url ? `The running app is at ${ux.url}.` : '',
    ux.command ? `Start the app with: ${ux.command} (from the repository root), and stop it when you are done.` : '',
    SHOTS_TEXT,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Correctif visible (L633) : capture avant et après dans le brief `implement` (`news`), revue du seul diff dans celui de `ux` et de `review-small` (`ux`) ; rien pour les autres lots et étapes. */
function visibleFixVars(kind: SessionKind, fix: boolean, captureDir: string, vars: Pick<BriefVars, 'news' | 'ux'>, ux?: { url?: string; command?: string }): Partial<Pick<BriefVars, 'news' | 'ux'>> {
  if (!fix) return {};
  if (kind === 'implement') return { news: [vars.news, visibleFixText('implement', captureDir, ux)].join('\n') };
  if (kind === 'ux' || kind === 'review-small') return { ux: [vars.ux, visibleFixText('review', captureDir)].filter(Boolean).join('\n') };
  return {};
}

function choixText(choix: string[]): string {
  if (!choix.length) return '';
  return ['The author decided these interpretation questions on its own; re-read each choice against the lot, its notes and the code, and report a finding if one is wrong or changes the scope:', ...choix.map((x) => `- ${x}`)].join('\n');
}

/** Tests et build déjà lancés par le programme au HEAD relu : le relecteur ne les refait pas (L75). Vide si HEAD a bougé depuis ou si rien n'a tourné. */
function checksText(c: LotCtx): string {
  const b = c.lot.baseline;
  // Sans orchestrate.test aucun rejeu : la base annoncée par la session (non vérifiée) est la seule trace des échecs de départ ; elle s'ajoute aux runs du programme (le build), elle ne les remplace pas.
  const declared = b && !b.verified && b.failures.length ? `The author reports ${b.failures.length} test(s) already red at the start sha${b.sha ? ` ${b.sha.slice(0, 7)}` : ''}, before this lot (not verified by the program):\n${b.failures.map((t) => `- ${t}`).join('\n')}\nThey are not defects of this lot, do not report them as findings; a failing test outside this list is still a finding.` : '';
  const k = c.lot.checks;
  if (!k?.runs.length || k.head !== git(wd(c), 'rev-parse', 'HEAD')) return declared;
  const runs = k.runs.map((r) => {
    const alone = r.instables?.length ? `${r.instables.length} test(s) red under load in the whole suite, green when replayed alone, not defects: ${r.instables.join(' ; ')}` : '';
    const state = r.code === 0 ? 'green' : r.dejaRouges ? `RED, exit code ${r.code}, but every failing test (${r.dejaRouges}) was already red at the start sha${c.lot.baseline?.sha ? ` ${c.lot.baseline.sha.slice(0, 7)}` : ''}: not a defect of this lot, do not report them as findings` : `RED, exit code ${r.code}`;
    const targeted = r.portee === 'ciblee' ? '. This gate is targeted: only the tests related to the files of the lot were played, not the whole suite; the full suite will be played by the program at integration' : '';
    return `- \`${r.command}\` (${r.label}): ${state}${alone ? `${r.code === 0 ? ';' : '. Also'} ${alone}` : ''}${targeted}`;
  });
  const ran = [`The program already ran these checks at HEAD ${k.head.slice(0, 7)}, just before this review:`, ...runs, 'Take these results as given: do not rebuild, do not rerun the whole suite, and do not wait on them. Run only a check they do not cover (a targeted test of a case you doubt), and list under "nonVerifie" what neither they nor you verified.'].join('\n');
  return declared ? `${ran}\n${declared}` : ran;
}

/** La clé `docs` du cadence.yaml du projet de ce lot. */
export const docsConfig = (c: LotCtx) => readDocsConfig(histPlan(c).configFile ?? join(wd(c), 'cadence.yaml'));

/** Écarts docs.sync des commits du lot (L143), calculés au moment de la demande : ni gardés ni écrits d'avance. Un écart acquitté et motivé (`raf docs-ok`, L317) n'en est plus un. */
export function docGaps(c: LotCtx): { sync: DocSyncRule[]; gaps: DocSyncGap[] } {
  const { sync } = docsConfig(c);
  const plan = histPlan(c);
  const acknowledged = !!plan.lots().find((x) => x.id === c.lot.lot)?.docsOk;
  return { sync, gaps: sync.length && !acknowledged ? lotDocSyncGaps(sync, wd(c), lotWork(plan, wd(c), c.lot.lot)) : [] };
}

/** Cause du renvoi au lead d'un lot dont l'écart docs.sync est ouvert (L317), null sans écart. */
export function openDocGap(c: LotCtx): string | null {
  const { gaps } = docGaps(c);
  if (!gaps.length) return null;
  return `${DOCS_GAP} : ${gaps.flatMap((g) => g.touched).join(', ')} sans la documentation attendue, et aucun écart acquitté — écrire la documentation, ou \`raf docs-ok ${c.lot.lot} --reason "…"\` si elle reste vraie`;
}

/** Consigne docs.sync du brief de revue (L143). */
function docsText(c: LotCtx): string {
  const { sync, gaps } = docGaps(c);
  return sync.length ? docSyncBrief(sync, gaps) : '';
}

/** Gabarit d'une étape : la passe des mineurs et la revue courte qui la suit ont chacune le leur. */
export function briefName(l: LotState, kind: SessionKind, integration = false): BriefName {
  if (l.specLot && !l.screen && (kind === 'spec' || kind === 'accept')) return `${kind}-back`;
  if (kind === 'fix' && l.docsFix) return 'fix-docs';
  if (kind === 'fix' && l.minorFix) return 'fix-minors';
  if (kind === 'review-small' && l.minorPass && !integration && !(l.small && l.visible)) return 'review-recheck'; // la revue d'intégration (R17) garde le gabarit qui porte {{integration}}
  return kind;
}

/** Fichier livré avec le paquet à côté des gabarits, joint à un brief (la session ne lit pas le dossier du paquet) ; undefined s'il manque. */
function packageFile(name: string): string | undefined {
  try {
    return readFileSync(join(TEMPLATES_DIR, '..', name), 'utf8');
  } catch {
    return undefined;
  }
}

/** Gabarit de fiche livré avec le paquet, joint au brief de la spec. */
const ficheTemplate = (): string | undefined => packageFile('fiche.yaml');

/** Gabarit de la partie back de la fiche (L187), joint au brief de la spec d'un lot `spec: true`. */
const ficheBackTemplate = (): string | undefined => packageFile('fiche-back.yaml');

/**
 * Les parties que la fiche du lot doit avoir : l'écran d'un lot à `screen:`, le sujet d'un lot à `spec: true` (sans écran). Un lot mixte est un lot
 * `screen:` dont la FICHE a une partie back (bloc `sujet`, décision du lead) : la fiche écrite le dit, pas un champ du plan.
 */
export const partsOf = (c: LotCtx, fiche?: string | null): FicheParts => ({ screen: !!c.lot.screen, back: !!c.lot.specLot || (!!c.lot.screen && !!fiche && ficheHasBack(wd(c), fiche)) });

/** Gabarit du lanceur de tests livré avec le paquet, joint au brief de l'étape accept. */
const acceptRunner = (): string | undefined => packageFile('acceptation-runner.mjs');

/** Fiche du lot : celle de l'étape spec, ou la fiche retrouvée dans le dépôt (reprise). */
export function ficheOf(c: LotCtx): string | null {
  const l = c.lot;
  return l.spec && 'fiche' in l.spec ? l.spec.fiche : findFiche(wd(c), c.config.spec.dir, l.lot);
}

/** Les règles de la fiche pour le brief : celles du lot seulement (une fiche partagée par plusieurs lots pèse ~270 Ko, comme l'étape accept, L559, issue #27) et le nombre des autres. Des ids qui ne désignent aucune règle de la fiche ne vident pas le brief : toutes les règles. */
function lotRules(c: LotCtx, doc: unknown, fiche: string, acceptation: string | undefined): { rules: string[]; others: number } {
  const all = ficheRules(doc);
  const own = ficheRules(doc, reglesDuLotPourBrief({ repo: wd(c), lot: c.lot.lot, fiche, acceptation, partage: { dir: c.config.spec.dir, refsOf: c.loadPlan().refs } }));
  const rules = own.length ? own : all;
  return { rules, others: all.length - rules.length };
}

/**
 * Consigne de la fiche pour les étapes en aval d'un lot qui en a une (L174) : implement, fix, revue de code, UX de conformité.
 * Vide quand le lot n'a pas de fiche (sous le seuil, ou pas encore écrite) ou qu'elle est illisible.
 */
function avalOf(c: LotCtx, kind: SessionKind): string {
  const l = c.lot;
  const step = kind === 'implement' || kind === 'fix' || kind === 'ux' ? kind : kind === 'review' || kind === 'review-small' ? 'review' : null;
  const fiche = step ? ficheOf(c) : null;
  if (!step || !fiche) return '';
  const acceptation = l.accept?.acceptation ?? findAcceptation(wd(c), c.config.spec.dir, l.lot) ?? undefined;
  let rules: string[];
  let others = 0;
  let contracts: string[];
  let screen: boolean;
  try {
    const doc = parse(readFileSync(join(wd(c), fiche), 'utf8'));
    ({ rules, others } = lotRules(c, doc, fiche, acceptation));
    contracts = ficheContracts(doc);
    screen = hasScreenPart(doc);
  } catch {
    return '';
  }
  if (!rules.length || (step === 'ux' && !screen)) return '';
  const o = { fiche, rules, others, acceptation, rouge: l.accept?.rouge, contracts, screen };
  const text = avalFicheText(step, o);
  // la revue courte d'un petit lot visible est sa seule passe : elle porte aussi la conformité à la maquette
  return kind === 'review-small' && l.small && l.visible && screen ? `${text}\n${avalFicheText('ux', o)}` : text;
}

/** Les étapes dont le programme rejoue la porte après la session (L399) : elles reçoivent ses commandes exactes et la part de machine (L350). La sonde écrit des tests : sans la porte, elle joue le runner seul et commite un test que `tsc` ou la qualité mettent au rouge, d'où une passe de correction pour rien. */
const writesCode = (kind: SessionKind): boolean => kind === 'implement' || kind === 'fix' || kind === 'probe';

/** Consigne de la part de machine de la session (L350) ; vide quand la vague n'en a pas calculé. */
const workersText = (c: LotCtx): string => (c.wave.testWorkers ? testWorkersText(c.wave.testWorkers) : '');

/** Les bornes de fichiers (L626, `boundsText` de la clé `bounds` du cadence.yaml du lot, toutes : un lot cite rarement le fichier qu'il finira par toucher) ajoutées au brief des sessions qui écrivent le code du lot (implement, fix), de même que les dépôts tiers : sans passer par un gabarit. Rien quand le cadence.yaml manque ou ne se lit pas (la porte le refuse déjà, `configRefusee` : un brief ne s'arrête pas pour lui). */
function withBounds(brief: string, c: LotCtx, kind: SessionKind): string {
  if (kind !== 'implement' && kind !== 'fix') return brief;
  try {
    const text = boundsText(readBounds(join(wd(c), 'cadence.yaml')));
    return text ? `${brief}\n${text}\n` : brief;
  } catch {
    return brief;
  }
}

/** Les lignes de doc et d'aide que le travail du lot laisse périmées (L648, `docsFollowText`), ajoutées au brief fix : sans gabarit, comme les bornes. Rien sans commit du lot ou sans parent lisible. */
function withDocsFollow(brief: string, c: LotCtx, kind: SessionKind): string {
  if (kind !== 'fix') return brief;
  try {
    const oldest = lotWork(histPlan(c), wd(c), c.lot.lot).at(-1);
    const text = oldest ? docsFollowText(wd(c), `${oldest.sha}^`) : '';
    return text ? `${brief}\n${text}\n` : brief;
  } catch {
    return brief;
  }
}

export function briefFor(c: LotCtx, kind: SessionKind, local = false): string {
  const plan = c.loadPlan();
  const l = c.lot;
  const lot = plan.lot(l.lot);
  const tmpDir = c.wave.store.tmpDir(l.project, l.lot);
  const vars: BriefVars = { chemin: wd(c), lot: l.lot, titre: headline(lot, l.goal), objectif: objective(lot, l.goal), commits: '', reponse: '', constats: '', spec: '', ux: uxText(c), choix: choixText(c.lot.choix ?? []), checks: kind === 'review' || kind === 'review-small' ? checksText(c) : '', docs: kind === 'review' || kind === 'review-small' ? docsText(c) : '', news: '', captures: '', express: kind === 'implement' && l.express ? EXPRESS_BRIEF : '', tmp: tmpText(tmpDir), workers: writesCode(kind) ? workersText(c) : '', gate: writesCode(kind) ? gateText(c.config) : '', repos: reposText(kind === 'implement' || kind === 'fix' ? 'write' : 'read', l.lot, l.repos ?? []), integration: c.integration ? integrationText(c.integration.base) : '', converge: convergeText(c, kind) };
  if (l.visible) {
    const pwDir = playwrightDir(c.wave.store.lotDir(l.project, l.lot));
    vars.news = l.express ? expressNewsText(pwDir) : newsText(l.lot, pwDir);
    vars.captures = capturesText(pwDir);
    Object.assign(vars, visibleFixVars(kind, visibleFix(l, lot), pwDir, vars, c.config.ux));
  }
  if (mcpServersFor(kind, l.visible, '', l.small, !!l.screen).playwright) vars.shots = shotsText(playwrightDir(c.wave.store.lotDir(l.project, l.lot)));
  vars.fiche = hasSpecStage(l) ? avalOf(c, kind) : '';
  // la vérification des ids d'un document de référence sur l'écran fini : la passe ux, ou la revue courte d'un petit lot visible qui n'a que celle-là (comme la conformité, avalOf)
  if (kind === 'ux' || (kind === 'review-small' && l.small && l.visible)) vars.ux = [vars.ux, worstUxText(kind, !!l.screen, plan.qaWorstData), referenceIdsText('ux', lotIds({ ...lot, goal: l.goal ?? lot.goal }))].filter(Boolean).join('\n');
  if (kind === 'probe') Object.assign(vars, probeVars(ficheOf(c), lotCommitLines(c), startSha(c), l.lot));
  if (kind === 'implement' || kind === 'fix') vars.decisions = decisionsText(humanDecisions(lot, lot.parent ? plan.lots().find((x) => x.id === lot.parent) : undefined));
  if (kind === 'precheck' && local) vars.lecture = localReading({ ...lot, goal: l.goal ?? lot.goal });
  if (kind === 'spec') {
    const reviewed = [...(l.ficheConstats ?? []), ...(l.maquetteConstats ?? [])];
    const written = ficheOf(c);
    const back = partsOf(c, written).back;
    const session = { run: (l.specRuns ?? 0) + 1, max: specMax(c) };
    vars.spec = specText({
      dir: c.config.spec.dir,
      render: c.config.spec.render,
      screen: l.screen, light: lightLot(l, lot, c.config.maquette, wd(c), c.config.spec.dir),
      back, worst: plan.qaWorstData,
      problems: l.specProblems,
      review: !reviewed.length ? undefined : back ? reviewedSheetText(reviewed, !!l.screen, session) : reviewedText(reviewed, session),
      template: l.screen ? ficheTemplate() : undefined,
      templateBack: back || l.screen ? ficheBackTemplate() : undefined,
    });
    vars.spec = [vars.spec, referenceIdsText('spec', lotIds({ ...lot, goal: l.goal ?? lot.goal }))].filter(Boolean).join('\n\n');
    const mine = lotCommitLines(c);
    if (mine) vars.commits = `Commits of the lot already present (do not redo them; fix or complete the spec from them):\n${mine}`;
    if (l.pendingAnswer) vars.reponse = l.specAsked?.length ? answeredText(l.specAsked, l.pendingAnswer, ruleIdsSourcedByLead(wd(c), ficheOf(c) ?? '', l.specAskedRules ?? [])) : `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  if (kind === 'fiche') {
    vars.fiche = ficheReviewText({ fiche: ficheOf(c) ?? '', passes: l.fiche?.passes ?? 0, previous: l.ficheConstats });
    vars.reponse = '';
  }
  if (kind === 'maquette') {
    vars.maquette = maquetteText({ fiche: ficheOf(c) ?? '', passes: l.maquette?.passes ?? 0, max: c.config.maquetteReviews, previous: l.maquetteConstats, light: lightLot(l, lot, c.config.maquette, wd(c), c.config.spec.dir), worst: plan.qaWorstData });
    vars.reponse = '';
  }
  if (kind === 'accept') {
    const fiche = ficheOf(c) ?? '';
    const folder = posix.dirname(fiche);
    vars.accept = acceptText({ fiche, maquette: `${folder}/maquette.html`, screen: !!l.screen, back: !!l.screen && partsOf(c, fiche).back, acceptation: acceptationFile(fiche, l.lot), command: c.config.accept ?? '', test: c.config.test, runner: acceptRunner(), problems: l.acceptProblems });
    vars.objectif = ''; // l'oracle est écrit depuis la fiche et la maquette seules, pas depuis le texte du lot
    vars.commits = '';
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  if (kind === 'implement' || kind === 'fix') {
    const interrupted = [...l.steps].reverse().find((s) => s.kind === kind && s.status === 'interrupted');
    if (kind === 'fix') {
      vars.commits = lotCommitLines(c);
      vars.constats = fixConstatsText(l.constats, briefName(l, 'fix'));
      if (l.docsFix) {
        vars.elsewhere = articlesBrief(l.repo, docsConfig(c).articles ?? []);
        vars.ack = wd(c) === l.repo && histPlan(c).readonly
          ? `run \`raf docs-ok ${l.lot} --reason "why the documentation stays true"\` (a reason is required): the plan is kept by another tool and is not written, the acknowledgement goes to \`.cadence/docs-ok.yaml\`; then commit that file alone (\`git add -- .cadence/docs-ok.yaml\`; message \`chore(${l.lot}): docs-ok\`).`
          : wd(c) === l.repo
          ? `run \`raf docs-ok ${l.lot} --reason "why the documentation stays true"\` (a reason is required), then commit the plan file alone (\`git add -- .cadence/raf.yaml\`, or the path of the plan; message \`chore(${l.lot}): docs-ok\`).`
          : `this is a worktree, where only the program writes the plan: do not run \`raf docs-ok\` and do not touch the plan file. Make no commit and say under "choix" why the documentation stays true: the lot is handed back to the lead, who acknowledges it in the main checkout (\`raf docs-ok ${l.lot} --reason "…"\`).`;
      }
    } else if (interrupted) {
      const mine = lotCommitLines(c);
      vars.commits = mine
        ? `A previous session was interrupted; resume from these commits of the lot already present:\n${mine}`
        : 'A previous session was interrupted before any commit of the lot; start again from the current state of the repository.';
    }
    // La lecture ne va qu'à la première passe implement : la session en cours (« running ») ne compte pas, toute autre passe implement déjà jouée l'exclut.
    const firstPass = !l.steps.some((s) => s.kind === 'implement' && s.status !== 'running');
    if (kind === 'implement') vars.commits = [precheckBrief(vars.commits, l.precheck, firstPass ? l.precheckLu : undefined), partageBrief(l.partage)].filter(Boolean).join('\n\n');
    if (l.pendingAnswer) vars.reponse = `Answer from the human to your earlier question: ${l.pendingAnswer}`;
  }
  const brief = renderBrief(briefName(l, kind, !!c.integration), vars, c.wave.templates);
  // Les dépôts tiers (L456) : la consigne s'ajoute à tout brief d'écriture, sans passer par un gabarit (un gabarit modifié change l'empreinte que d'autres tests gardent).
  return withClusterLine(withDocsFollow(withBounds(['implement', 'fix', 'spec', 'accept', 'probe'].includes(kind) ? `${brief}\n${tiersText(l.project, l.lot)}\n` : brief, c, kind), c, kind), c.config.prodAccess);
}

/** Plafond de sessions `spec` du lot (L230) : les revues de maquette d'un lot à écran, sinon deux. Fiche et maquette partagent `l.specRuns`. */
export const specBudget = (c: LotCtx): number => (c.lot.screen && c.config.maquette ? c.config.maquetteReviews : 2);

/** Revue de fiche qui converge (L572) : une 3ᵉ revue de plus quand la 2ᵉ revue compte moins de constats bloquants+majeurs que la 1ʳᵉ et qu'un seul reste. */
export const ficheConverging = (l: LotCtx['lot']): boolean => {
  const n = l.ficheCounts ?? [];
  return n.length >= 2 && n[1] === 1 && n[1] < n[0]; // lu sur les deux premières revues : la 3ᵉ ne change pas le plafond qu'elle a elle-même obtenu
};

/** Sessions spec permises : le budget du lot, relevé à 3 quand la revue de fiche converge (la 3ᵉ revue suit une 3ᵉ passe spec). */
export const specMax = (c: LotCtx): number => (ficheConverging(c.lot) ? Math.max(specBudget(c), 3) : specBudget(c));
