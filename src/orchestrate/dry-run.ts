import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readPlanConfig } from '../config.js';
import { PLAN_ACTIONS, commitMsgHook, leadAnswerMessage, indexCompletedMessage, commitMsgRefusal, planCommitMessage } from '../plan-commit.js';
import { decisionsText, humanDecisions } from './decisions.js';
import { headline, newsText, objective, renderBrief, type BriefVars } from './briefs.js';
import { acceptationFile, acceptText, redAcceptations } from './accept.js';
import type { Plan } from '../plan.js';
import { reportCiParity } from './ci-parity.js';
import { noTestGate, noTestText } from './no-test.js';
import { ficheReviewText } from './fiche.js';
import { maquetteText } from './maquette.js';
import { budgetStage, costlyHypotheses, lightLot, specText } from './spec.js';
import { fichesDuDossier } from '../spec.js';
import { drawSettingsReport } from './continue.js';
import { precheckNothingToFind, MAX_PASSES, MAX_PASSES_CONVERGING, briefName, needsPrecheck } from './cycle.js';
import { buildArgs, buildLocalArgs, MODEL_ALIASES, mcpServersFor, enabledPlugins, settingsFiles, type StepModel } from './launch.js';
import { repoBranch } from './integrate.js';
import { keptBranchesOfLot, legacyLotSlug, lotBranch, planFileSet, recoveryRefusal, type KeptTree } from './worktree.js';
import { effortKey, schemaFor, stepAgent } from './schemas.js';
import { lotKey, lotSlug, neighbourDirs, RunStore, type LotState } from './state.js';
import { matchesNvmrc, notLoggedIn, pathNodeVersion, projectEnv } from './preflight.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';
import { draw, priorityOf } from './draw.js';
import { agentsOf } from './preflight.js';
import { lotBudgetBasis, type MeasuredBudgets } from './lot-budget.js';

/**
 * Ce avec quoi le dry-run mesure les messages de la fiche d'un lot à étape spec (L343) : la fiche du lot quand elle est déjà écrite (son sujet pour les hypothèses
 * notées, ses hypothèses coûteuses pour la réponse du lead, qui ne source que les règles posées en question — `costlyHypotheses` — et n'est pas commitée sans elles),
 * sinon le sujet le plus long du dossier des fiches et autant de règles coûteuses que la fiche du dossier qui en porte le plus (1 au moins). Un sujet de 7 caractères
 * (« <sujet> ») faisait accepter un message que `header-max-length` refuse avec un sujet réel ; toutes les hypothèses d'une fiche (13) faisaient refuser une réponse qui n'en cite que les coûteuses.
 */
function ficheMeasure(repo: string, dir: string, lot: string): { sujet: string; regles: string[]; line: string } {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const costly = (doc: Record<string, unknown>): string[] => costlyHypotheses(doc).map((x) => x.id);
  const fiches = fichesDuDossier(repo, dir);
  const mine = fiches.find(({ doc }) => (isObj(doc.sujet) && doc.sujet.lot === lot) || (isObj(doc.ecran) && doc.ecran.lot === lot));
  if (mine) {
    const sujet = isObj(mine.doc.sujet) && typeof mine.doc.sujet.id === 'string' ? mine.doc.sujet.id : mine.name;
    const regles = costly(mine.doc);
    const about = regles.length ? `réponse du lead mesurée avec ${regles.length > 1 ? 'les règles coûteuses' : 'la règle coûteuse'} ${regles.join(', ')}` : 'aucune hypothèse coûteuse : pas de réponse du lead à commiter';
    return { sujet, regles, line: `  fiche du lot : ${dir}/${mine.name}/fiche.yaml (${about})` };
  }
  if (!fiches.length) return { sujet: '<sujet>', regles: ['R1'], line: `  aucune fiche dans ${dir} : les messages de la fiche sont mesurés avec « <sujet> » (7 caractères) et 1 règle ; un sujet réel plus long peut dépasser une limite du hook` };
  const sujet = fiches.map((f) => f.name).reduce((a, b) => (b.length > a.length ? b : a));
  const n = Math.max(1, ...fiches.map((f) => costly(f.doc).length));
  return { sujet, regles: Array.from({ length: n }, (_, i) => `R${i + 1}`), line: `  fiche du lot pas encore écrite : mesure avec le sujet le plus long de ${dir} (${sujet}) et ${n} règle(s) coûteuse(s) pour la réponse du lead` };
}

/**
 * Les messages de commit de plan que la vague écrirait pour ce lot, passés au hook commit-msg réel du dépôt : un refus se lit ici, avant une vague payante (L343).
 * Les messages de la fiche (hypothèses, mineurs de sa revue, réponse du lead) ne sont joués que pour un lot à étape spec, avec un sujet de longueur réelle (`ficheMeasure`) ;
 * les hypothèses ne sont notées que pour un lot `spec: true` sans écran (`settleHypotheses`), la réponse du lead n'est commitée que pour une hypothèse coûteuse (`sourceAnsweredRules`).
 */
function planMessageLines(repo: string, l: LotState, wave: string, dir: string): string[] {
  const template = readPlanConfig(join(repo, 'cadence.yaml'), repo)?.commit;
  const specStage = !!(l.screen || l.specLot);
  const measure = specStage ? ficheMeasure(repo, dir, l.lot) : null;
  const actions = [PLAN_ACTIONS.started, PLAN_ACTIONS.reviewRecorded, PLAN_ACTIONS.reviewNoted];
  if (measure) {
    if (l.specLot && !l.screen) actions.push(PLAN_ACTIONS.hypotheses(measure.sujet));
    actions.push(PLAN_ACTIONS.minors('la fiche'));
  }
  const indexMessage = l.screen ? [indexCompletedMessage(template, l.lot, wave)] : [];
  const planMessages = actions.map((action) => planCommitMessage(template, { lot: l.lot, action, wave }));
  const messages = [...new Set((measure?.regles.length ? planMessages.concat(leadAnswerMessage(template, l.lot, measure.regles, wave)) : planMessages).concat(indexMessage))];
  const hook = commitMsgHook(repo);
  if (!hook) return template ? [`  messages de plan : « ${messages[0]} » (gabarit plan.commit ; aucun hook commit-msg dans ce dépôt)`] : [];
  const refused = messages.map((m) => ({ m, why: commitMsgRefusal(repo, m) })).filter((r) => r.why !== null);
  const about = measure ? [measure.line] : [];
  if (!refused.length) return [`  messages de plan : ${messages.length} message(s) acceptés par le hook commit-msg du dépôt (${hook})${template ? ' — gabarit plan.commit' : ''}`, ...about];
  return [
    ...refused.map((r) => `  ✗ message de plan refusé par le hook commit-msg : « ${r.m} » — ${r.why}`),
    ...about,
    `  ✗ le lot échouerait au premier commit de plan refusé, avant ou pendant ses sessions : régler plan.commit dans cadence.yaml (gabarit avec {lot}, {action}, {vague})`,
  ];
}

/** Les dépôts dont une remarque de porte a déjà été écrite : chacune l'est une fois par dépôt, pas par lot. */
interface RepoSaid {
  noTestSaid: Set<string>;
  ciSaid: Set<string>;
  redSaid: Set<string>;
}

/** Ce que le dry-run dit une fois d'un dépôt de la vague : porte de tests absente (L327), parité porte ↔ CI (L499), acceptation rouge d'un lot clos (L366). */
function repoNotices(repo: string, io: OrchestrateIo, said: RepoSaid, specDir: string, loadPlan: () => Plan): void {
  const noTest = said.noTestSaid.has(repo) ? null : noTestGate(repo);
  said.noTestSaid.add(repo);
  if (noTest) io.out(`  ${basename(repo)} · ${noTestText(noTest)}`);
  if (!said.ciSaid.has(repo)) {
    said.ciSaid.add(repo);
    reportCiParity(repo, io.out, `  ⚠ ${basename(repo)} · `);
  }
  if (said.redSaid.has(repo)) return;
  said.redSaid.add(repo);
  // L366 : l'acceptation à vert: false d'un lot clos à la main verrouille ses tests pour tous les lots du dépôt, sans que ce lot y ait touché.
  const closed = new Set(loadPlan().lots().filter((x) => x.status === 'done').map((x) => x.id));
  for (const red of redAcceptations(repo, specDir)) {
    if (closed.has(red.lot)) io.out(`  ⚠ ${basename(repo)} · acceptation rouge d'un lot clos : ${red.lot} (${red.path}, vert: false) — le verrou des tests d'acceptation peut bloquer les lots de la vague ; cadence spec green ${red.lot}`);
  }
}

/**
 * Ce que la vague ferait des branches gardées d'une vague passée qui portent le travail du lot (L581, issue #38), sous le nom actuel ou l'ancien (`<repo>--<lot>`) :
 * une ligne par branche non intégrée, qui dit si elle est reprise ou pas, et pourquoi, avec les refus mêmes de `recoverTree` (`recoveryRefusal` : worktree modifié, plan touché).
 * Le lot d'un dry-run est neuf (`next` à null) : la reprise à part d'un lot rendu à l'intégration (`next: integrate`, execute.ts) n'y est pas simulée.
 * Un `git worktree move` ou `git branch -m` refusé ne se voit qu'à la vraie vague.
 */
function keptBranchLines(l: LotState, id: string, worktrees: boolean, planFiles: ReadonlySet<string>): string[] {
  const branch = repoBranch(l.repo);
  const legacy = legacyLotSlug(l.project, l.lot);
  const found = keptBranchesOfLot(l.repo, lotBranch(id, l.project, l.lot), [lotSlug(l.project, l.lot), ...(legacy ? [legacy] : [])]);
  const first = worktrees && branch ? found.find((t) => t.base === branch) : undefined;
  const refused = first ? recoveryRefusal(l.repo, first, first.base, planFiles) : null;
  return found.map((t) => `  branche ${t.branch} d'une vague précédente (${t.unintegrated} commit(s) non intégré(s)) : ${t !== first ? notTakenCause(t, branch, worktrees, first, refused) : refused ? `n'est pas reprise, ${refused}` : 'reprise par la vague (le lot repart de son travail)'}`);
}

/** Pourquoi `recoverTree` ne prend pas cette branche gardée, quand ce n'est pas la plus récente partie de la branche du dépôt (L581). */
function notTakenCause(t: KeptTree, branch: string | null, worktrees: boolean, first: KeptTree | undefined, refused: string | null): string {
  if (!worktrees) return "n'est pas reprise, orchestrate.worktrees n'est pas actif";
  if (!branch) return "n'est pas reprise, le dépôt est en HEAD détaché";
  if (t.base !== branch) return `n'est pas reprise, elle est partie de ${t.base} et le dépôt est sur ${branch}`;
  return refused ? `n'est pas reprise, seule la plus récente du lot (${first?.branch}) est examinée, et elle est refusée` : `n'est pas reprise, une branche plus récente du lot (${first?.branch}) l'est`;
}

/** `wave` : la vague simulée — son identifiant, son budget et si elle a plus d'un créneau (L527 : tout lot d'un dépôt en worktrees y joue alors dans le sien). */
export function dryRun(lots: LotState[], io: OrchestrateIo, deps: OrchestrateDeps, { budget, id, multiSlot, measured }: { budget: number; id: string; multiSlot: boolean; measured?: MeasuredBudgets }): void {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-orchestrate-'));
  const agents = agentsOf(deps);
  io.out(`vague ${id} — simulation, rien n'est lancé (budget ${budget} tokens comptés)`);
  const login = notLoggedIn(deps);
  if (login) io.out(`⚠ ${login} — sans cela le vrai lancement est refusé`);
  const repos = [...new Set(lots.map((l) => l.repo))];
  const said = { noTestSaid: new Set<string>(), ciSaid: new Set<string>(), redSaid: new Set<string>() };
  for (const l of lots) {
    const env = projectEnv(l.repo);
    const lot = env.loadPlan().lot(l.lot);
    const slot = repos.indexOf(l.repo);
    io.out(`${lotKey(l.project, l.lot)} — ${l.title}`);
    if (l.goal) io.out(`  objectif donné : ${l.goal} (à la place du titre dans les briefs)`);
    io.out(`  budget du lot : ${l.budget} tokens comptés (base : ${lotBudgetBasis(lot.estimate, budgetStage(lot, l.screen, env.config.maquette, l.repo, env.config.spec.dir), l.escalationReserve ? env.config.escalation?.model : undefined, measured)})`);
    const mine = lots.filter((o) => o.repo === l.repo);
    const together = env.config.worktrees && (mine.length > 1 || multiSlot) && !mine.some((o) => o.repos?.length) && !!repoBranch(l.repo);
    io.out(together ? `  file ${basename(l.repo)} · en parallèle des autres lots du dépôt, dans son worktree (cadence/${id}/${lotSlug(l.project, l.lot)}, créé à la prise du créneau)` : `  file ${basename(l.repo)} · ${slot < 2 ? `créneau ${slot + 1}` : 'en attente d\'un créneau'}`);
    if (l.repos?.length) io.out(`  dépôts voisins : ${l.repos.map((r) => r.rel).join(', ')} (verrou, garde de push et --add-dir ; leurs commits citent ${l.lot})`);
    if (l.node) {
      const sk = l.node.skipped;
      const skipped = sk?.length ? ` ; ${sk.join(', ')} ${sk.length > 1 ? 'écartées' : 'écartée'} : pas de node exécutable` : '';
      io.out(`  node : ${l.node.version} (.nvmrc ${l.node.wanted}${skipped})`);
      const gate = env.config.test || env.config.build;
      const onPath = gate ? (deps.pathNode ?? (() => pathNodeVersion(io.env)))() : null;
      if (onPath && !matchesNvmrc(onPath, l.node.wanted)) io.out(`  ⚠ .nvmrc ${l.node.wanted} ≠ node du PATH ${onPath} : la porte et les autres commandes du programme tournent sous ${l.node.version} (lien node-bin en tête du PATH), pas sous ${onPath}`);
    }
    const steps: { kind: 'precheck' | 'spec' | 'maquette' | 'fiche' | 'accept' | 'implement' | 'probe' | 'ux' | 'review' | 'review-small'; model: StepModel }[] = [{ kind: 'implement', model: l.model }];
    const specStage = !!(l.screen || l.specLot);
    if (specStage && env.config.accept && !lightLot(l, lot, env.config.maquette, l.repo, env.config.spec.dir)) steps.unshift({ kind: 'accept', model: 'sonnet' });
    if (l.screen && env.config.maquette) steps.unshift({ kind: 'maquette', model: env.config.review.full });
    if (l.specLot && env.config.fiche) steps.unshift({ kind: 'fiche', model: 'sonnet' });
    if (specStage) steps.unshift({ kind: 'spec', model: 'sonnet' });
    if (!l.express && needsPrecheck(env.config, env.loadPlan(), l.repo, l.lot, l.repos, l.goal)) {
      const nothingToFind = precheckNothingToFind(env.loadPlan(), l.repo, l.lot, l.repos, l.goal);
      if (nothingToFind) io.out(`  contrôle préalable sauté : ${nothingToFind}`);
      else steps.unshift({ kind: 'precheck', model: env.config.precheckLocal ? 'local' : 'sonnet' });
    }
    steps.push(...(env.config.probe && !l.express ? [{ kind: 'probe' as const, model: 'sonnet' }] : [])); // L497 : entre l'écriture et la revue
    const { light, full } = env.config.review;
    if (l.express) {
      // L519 : une seule session, le lead lit le diff
    } else if (l.small) steps.push({ kind: l.visible ? 'review-small' : 'review', model: l.light ? light : full });
    else {
      steps.push({ kind: 'review', model: l.light ? light : full });
      if (l.visible && env.config.ux) steps.push({ kind: 'ux', model: full }); // L221 : l'UX est jouée une fois, après la revue de code conforme
    }
    io.out(`  étapes : ${steps.map((s) => `${s.kind} (${s.model})`).join(' → ')}${l.small ? ' — petit lot' : ''}${l.express ? ' — voie express (pas de précheck, de sonde ni de revue séparée : le lead lit le diff)' : ''}${l.light && !l.express ? ` — revue légère (${light}, pas de passe des mineurs ; un bloquant ou un majeur → correction puis revue ${full})` : ''}${l.visible && !env.config.ux ? ' — UX à faire par le lead (orchestrate.ux absent)' : ''}`);
    for (const m of new Set(steps.map((s) => s.model))) {
      if (m !== 'local' && !MODEL_ALIASES.includes(m)) io.out(`  ⚠ modèle « ${m} » hors des alias ${MODEL_ALIASES.join(', ')} : passé tel quel à claude --model (un nom que le compte ne connaît pas fait échouer la session)`);
    }
    for (const line of [...keptBranchLines(l, id, env.config.worktrees, planFileSet(env.loadPlan(), l.repo)), ...planMessageLines(l.repo, l, id, env.config.spec.dir)]) io.out(line);
    repoNotices(l.repo, io, said, env.config.spec.dir, env.loadPlan);
    io.out(`  corrections : ${MAX_PASSES} passe(s) au plus (${MAX_PASSES_CONVERGING} si la revue converge), en session neuve`);
    io.out(l.light ? '  revue conforme avec mineurs : pas de passe des mineurs, ils sont rendus en notes' : '  revue conforme avec mineurs : une passe de correction des mineurs (session neuve), puis une revue courte ; les mineurs refusés sont rendus en « choix »');
    const pwDir = join(resolve(RunStore.runsDir(io.cwd)), id, lotSlug(l.project, l.lot), 'playwright');
    // brief écrit par --dry-run = base d'une délégation à la main : aucun dossier de vague (il n'existe pas)
    const vars: BriefVars = { chemin: l.repo, lot: l.lot, titre: headline(lot, l.goal), objectif: objective(lot, l.goal), commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: l.visible ? newsText(l.lot) : '', captures: '', diff: 'git diff <sha de départ>..HEAD' };
    vars.decisions = decisionsText(humanDecisions(lot, lot.parent ? env.loadPlan().lots().find((x) => x.id === lot.parent) : undefined));
    if (specStage) vars.spec = specText({ dir: env.config.spec.dir, render: env.config.spec.render, screen: l.screen, light: lightLot(l, lot, env.config.maquette, l.repo, env.config.spec.dir), back: !!l.specLot, worst: env.loadPlan().qaWorstData });
    if (l.screen && env.config.maquette) vars.maquette = maquetteText({ fiche: `${env.config.spec.dir}/<écran>/fiche.yaml`, passes: 0, max: env.config.maquetteReviews, light: lightLot(l, lot, env.config.maquette, l.repo, env.config.spec.dir), worst: env.loadPlan().qaWorstData });
    if (l.specLot && env.config.fiche) vars.fiche = ficheReviewText({ fiche: `${env.config.spec.dir}/<sujet>/fiche.yaml`, passes: 0 });
    if (specStage && env.config.accept && !lightLot(l, lot, env.config.maquette, l.repo, env.config.spec.dir)) {
      const folder = `${env.config.spec.dir}/${l.screen ? '<écran>' : '<sujet>'}`;
      vars.accept = acceptText({ fiche: `${folder}/fiche.yaml`, maquette: `${folder}/maquette.html`, screen: !!l.screen, back: false, acceptation: acceptationFile(`${folder}/fiche.yaml`, l.lot), command: env.config.accept ?? '', test: env.config.test });
    }
    for (const s of steps) {
      const file = join(tmp, `${lotSlug(l.project, l.lot)}--${s.kind}.md`);
      writeFileSync(file, renderBrief(briefName(l, s.kind), s.kind === 'fiche' || vars.fiche === undefined ? vars : { ...vars, fiche: '' }, deps.templatesDir)); // la consigne de revue de fiche ne sert qu'au brief de la fiche : implement et review en sont la base d'une délégation à la main
      const playwright = !!mcpServersFor(s.kind, l.visible, '', l.small, !!l.screen).playwright;
      const local = s.model === 'local';
      const args = (local ? buildLocalArgs : buildArgs)(
        { kind: s.kind, sessionId: '<uuid>', brief: '<brief>', model: s.model === 'local' ? 'sonnet' : s.model, local, effort: env.config.effort[effortKey(s.kind)], schema: schemaFor(s.kind), agent: stepAgent(s.kind), cwd: l.repo, wave: id, permissionMode: env.config.permissionMode, addDirs: [...env.config.addDirs, ...(playwright && (s.kind === 'implement' || s.kind === 'spec') ? [pwDir] : []), ...neighbourDirs(l)], timeoutMs: 0, mcpConfig: '<mcp>', playwright, disablePlugins: enabledPlugins(settingsFiles(deps.claudeHome, l.repo)) },
        agents,
      ).map((a) => (a.startsWith('{') ? '<json>' : a));
      io.out(`  ${s.kind} : ${local ? 'claude-local' : 'claude'} ${args.join(' ')}`);
      io.out(`    brief : ${file}`);
      const servers = Object.keys(mcpServersFor(s.kind, l.visible, '', l.small, !!l.screen));
      io.out(`    mcp : ${servers.length ? `${servers.join(', ')} (captures dans le dossier de la vague : <vague>/${lotSlug(l.project, l.lot)}/playwright)` : 'aucun'}`);
    }
  }
}

/** Le plus de lots que `--dry-run --continue` liste après le premier tirage. */
const DRY_RUN_LOTS = 10;

/**
 * `--dry-run --continue` : ce que le remplissage des créneaux libres tirerait ensuite (L527), avec la même fonction `draw` que la vague, un lot à la fois
 * (`n = 1` : le premier lot prêt dans l'ordre de priorité, contrôle préalable, budget), comme la vague remplit chaque créneau libre ; les lots sautés disent pourquoi.
 * Le budget est décompté sur l'estimation des lots tirés (la consommation réelle n'est pas connue) et la simulation ne sait pas quel dépôt sera occupé à chaque
 * regard : elle liste les lots dans l'ordre où le remplissage les prendrait si chaque dépôt était libre. `firstSkipped` : causes écartées au premier tirage, quand il a fourni les lots donnés.
 */
export async function continueDryRun(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string, given: LotState[], budget: number, firstSkipped: string[]): Promise<void> {
  io.out(`--continue : priorité ${priorityOf(args, launch).join(' > ') || '(aucune déclarée : ordre alphabétique)'}${args.until ? ` · jusqu'à ${args.until}` : ''}`);
  const said = new Set<string>();
  const skip = (causes: string[]) => {
    for (const s of causes) {
      if (said.has(s)) continue;
      said.add(s);
      io.out(`  lot sauté — ${s}`);
    }
  };
  skip(firstSkipped);
  const exclude = new Set(given.map((l) => lotKey(l.project, l.lot)));
  for (const line of drawSettingsReport(launch, exclude)) io.out(`  ${line}`);
  let remaining = budget - given.reduce((sum, l) => sum + (l.budget ?? 0), 0);
  const next: string[] = [];
  while (next.length < DRY_RUN_LOTS && remaining > 0) {
    const drawn = await draw(args, io, deps, launch, exclude, remaining, 1);
    skip(drawn.skipped);
    const lot = drawn.lots[0];
    if (!lot) break;
    next.push(lotKey(lot.project, lot.lot));
    remaining -= lot.budget ?? 0;
  }
  io.out(next.length ? `  tirés ensuite, un par un au fil des créneaux libres, dans l'ordre de priorité (budget décompté sur les estimations) : ${next.join(', ')}${next.length === DRY_RUN_LOTS ? ' · …' : ''}` : '  aucun autre lot prêt à tirer');
}
