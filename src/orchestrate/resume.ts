import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { planLoader } from '../config.js';
import { type Day } from '../dates.js';
import { heldRefusal, localLotOf } from '../local-task.js';
import { RafError } from '../plan.js';
import { pidAlive, sharedStateDir } from '../state.js';
import { cadenceHome, liveWaves, registerWave, unregisterWave } from './registry.js';
import { Budget, DROPPED, REVIEW_RESERVE, budgetStep, heldForEscalation, lotSpent, countInterrupted, planNoteHandBack, leadReviewedHandBack, HYPOTHESES_HANDBACK } from './cycle.js';
import { snapshot } from './guard.js';
import { type SessionKind } from './launch.js';
import { activeLock, REPO_LOCK, releaseLock, takeLock } from './lock.js';
import { trackedDirty } from './depot.js';
import { adoptLeadReview, depositIntegrations, depositsOnly, integrationText, runsElsewhere } from './integration-vivante.js';
import { mainTreeWorkers } from './main-tree.js';
import { baseBranchOf, keptLines, lotBranch, lotTreeDir } from './worktree.js';
import { lotFinished, lotKey, lotRepoPaths, RunStore, type LotState } from './state.js';
import { linkNodeBin, nvmVersionsDir, resolveNode, type NodeChoice } from './node-env.js';
import { launchPrices, renderTable } from './table.js';
import { gestureSuffix, stillRunningRefusal } from './geste.js';
import { SnapshotRefusal, repairSnapshotModules, snapshotExists, waveReadsIntegrate, waveReadsLotBudget, waveReadsReplay, toolDirOf } from './snapshot.js';
import { answerLive, control, singleUnfinished } from './status.js';
import { continueRounds, execute } from './execute.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import { LOT_LIKE, type Args } from './command-args.js';

const REPO_WAIT_MS = 3 * 60 * 60_000;
const REPO_WAIT_POLL_MS = 5_000;

/**
 * L309 : l'instantané d'une vague antérieure relit `--wave <id>` comme un simple nom et `--resume` seul comme « la dernière vague non terminée » :
 * on lui transmet la vague choisie en clair (`--resume <id>`, sans `--wave`), quel que soit le parseur qui la lira.
 */
export function resumeArgv(argv: string[], id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--wave') i++;
    else if (t === '--resume') {
      out.push(t, id);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !LOT_LIKE.test(next)) i++;
    } else if (t === '--answer') out.push(t, argv[++i] ?? '', argv[++i] ?? '');
    else out.push(t);
  }
  return out;
}

export async function resume(args: Args, argv: string[], io: OrchestrateIo, deps: OrchestrateDeps, launch: string, today: Day): Promise<number> {
  const store = typeof args.resume === 'string' ? RunStore.find(launch, args.resume) : singleUnfinished(launch);
  if (!store) throw new RafError(`vague inconnue : ${args.resume}`);
  // L532 : `--integrate` seul sur une vague qui tourne encore dépose l'intégration dans sa file au lieu de refuser ; dit avant l'instantané (le dépôt ne demande rien à son code) ; une reprise qui attend le dépôt (L443) est inscrite vivante mais ne joue pas encore : la vague doit être « running ». Avec une autre option de reprise ou --replay, le refus ci-dessous reste.
  if (depositsOnly(args, runsElsewhere(store, launch))) return depositIntegrations(args.integrate, io, store);
  if (deps.snapshot) {
    // La reprise tourne sur l'instantané de la vague, jamais sur le dist/ courant ; une vague d'avant L61 n'en a pas.
    if (LOT_LIKE.test(store.id) && snapshotExists(store.dir)) {
      // L309 : `--resume suite2` serait relu par n'importe quel parseur comme un lot à lancer ; `--wave suite2`, un instantané d'avant L309 le prendrait pour un simple nom et reprendrait une autre vague.
      io.err(`orchestrate : vague ${store.id} : son nom ressemble à un lot, l'instantané ne saurait pas le relire comme une vague : reprise avec le dist/ et les gabarits courants`);
    } else if (snapshotExists(store.dir)) {
      // Une vague d'avant L223 refuserait « projet:lot=+N » comme budget invalide : seul le lot visé justifie de la rejouer avec le dist/ courant.
      if ((!args.lotBudgets.length || waveReadsLotBudget(store.dir)) && (!args.integrate.length || waveReadsIntegrate(store.dir)) && (!args.integrate.some((t) => t.replay) || waveReadsReplay(store.dir))) {
        // L330 : la copie dont l'instantané lie le node_modules a pu être purgée par une mise en service ; on relie, on le journalise, ou on refuse proprement.
        try {
          const healed = repairSnapshotModules(store.dir, deps.snapshot.packageRoot);
          if (healed) {
            store.journal(healed);
            io.err(`orchestrate : vague ${store.id} : ${healed}`);
          }
        } catch (e) {
          if (!(e instanceof SnapshotRefusal)) throw e;
          io.err(`orchestrate : vague ${store.id} : ${e.message}`);
          return 2;
        }
        return deps.snapshot.reexec(toolDirOf(store.dir), resumeArgv(argv, store.id), io.env, io);
      }
      io.err(`orchestrate : vague ${store.id} : son instantané ne connaît pas ${args.lotBudgets.length && !waveReadsLotBudget(store.dir) ? '--budget projet:lot=+N (antérieur à L223)' : `${args.integrate.some((t) => t.replay) && waveReadsIntegrate(store.dir) ? '--replay' : '--integrate'} (antérieur à L279)`} : reprise avec le dist/ et les gabarits courants`);
    } else {
      io.err(`orchestrate : vague ${store.id} sans instantané (antérieure à L61) : reprise avec le dist/ et les gabarits courants`);
    }
  }
  // L407 : la forme documentée sur une vague qui tourne encore dépose la réponse dans sa file au lieu de refuser ; avec une autre option de reprise, le refus ci-dessous reste.
  if (args.answers.length && !args.lotBudgets.length && !args.drop.length && !args.integrate.length && args.budget === undefined && !args.continue && liveWaves(cadenceHome()).some((w) => w.wave === store.id && w.cwd === launch && w.pid !== process.pid)) return answerLive(args, io, store);
  const wave = store.readWave()!;
  const refusals: string[] = [];
  const info = deps.claudeInfo();
  if (!info) refusals.push('claude introuvable (CADENCE_CLAUDE_BIN, ou claude dans le PATH)');
  const alive = liveWaves(cadenceHome()).find((w) => w.wave === wave.id && w.cwd === launch && w.pid !== process.pid);
  if (alive) refusals.push(stillRunningRefusal(alive, args.integrate));
  // Une vague terminée ne se reprend que pour rejouer un lot visé par --budget projet:lot=+N (L223) ; ce lot est vérifié plus bas.
  if (wave.status === 'done' && !args.lotBudgets.length && !args.integrate.length) refusals.push(`la vague ${wave.id} est terminée`);

  const lots = store.lots();
  for (const a of args.answers) {
    const l = lots.find((x) => x.lot === a.lot && (a.project ? x.project === a.project : true));
    if (!l) refusals.push(`--answer ${a.project ? `${a.project}:` : ''}${a.lot} : lot inconnu dans la vague ${wave.id}`);
    else if (l.status !== 'question') refusals.push(`--answer ${lotKey(l.project, l.lot)} : le lot n'attend pas de réponse (${l.status})`);
    else {
      l.pendingAnswer = a.text;
      l.answers.push(a.text);
      l.questions = [];
    }
  }
  // --resume --drop projet:lot (L79) : le lot est retiré avant d'être rejoué — le seul moyen de retirer un lot d'une vague arrêtée, --drop seul refusant une vague qui ne tourne plus.
  const drops: string[] = [];
  for (const d of args.drop) {
    const matches = lots.filter((x) => x.lot === d.lot && (d.project ? x.project === d.project : true));
    const where = `${d.project ? `${d.project}:` : ''}${d.lot}`;
    if (matches.length !== 1) refusals.push(matches.length ? `--drop ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--drop ${where} : lot inconnu dans la vague ${wave.id}`);
    else if (lotFinished(matches[0])) refusals.push(`--drop ${lotKey(matches[0].project, matches[0].lot)} : le lot est déjà fini (${matches[0].status})`);
    else drops.push(lotKey(matches[0].project, matches[0].lot));
  }
  // --resume --budget projet:lot=+N (L223) : un lot rendu sur budget est remis en jeu avec son budget relevé (N reste la marge des passes ordinaires : la part de l'escalade encore retenue, L349, s'y ajoute). Il subit ensuite les gardes d'un lot vivant.
  const raised = new Map<LotState, { from: number; to: number; step: SessionKind }>();
  const answered = args.answers.map((a) => lots.filter((x) => x.lot === a.lot && (a.project ? x.project === a.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  const dropped = args.drop.map((d) => lots.filter((x) => x.lot === d.lot && (d.project ? x.project === d.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  for (const b of args.lotBudgets) {
    const matches = lots.filter((x) => x.lot === b.lot && (b.project ? x.project === b.project : true));
    const where = `${b.project ? `${b.project}:` : ''}${b.lot}`;
    if (matches.length !== 1) {
      refusals.push(matches.length ? `--budget ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--budget ${where} : lot inconnu dans la vague ${wave.id}`);
      continue;
    }
    const l = matches[0];
    const key = lotKey(l.project, l.lot);
    if (raised.has(l)) refusals.push(`--budget ${key} : lot visé deux fois`);
    else if (dropped.includes(l)) refusals.push(`--budget ${key} : lot aussi retiré par --drop`);
    else if (answered.includes(l)) refusals.push(`--budget ${key} : lot aussi visé par --answer`);
    else if (!budgetStep(l)) refusals.push(`--budget ${key} : le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer (${l.status}${l.status === 'handed-back' ? `, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'}` : ''})`);
    else if (budgetStep(l) === 'fix' && b.raise <= REVIEW_RESERVE) refusals.push(`--budget ${key}=+${b.text} : un fix ne part qu'au-dessus de ${REVIEW_RESERVE} tokens de réserve`);
    else raised.set(l, { from: l.budget ?? lotSpent(l), to: lotSpent(l) + b.raise + heldForEscalation(l), step: budgetStep(l)! });
  }
  // --resume --integrate projet:lot (L279, R27) : un lot rendu à l'étape d'intégration (next: integrate) n'est rejoué que si le lead le nomme. Ni --resume seul, ni --drop, --answer ou --budget ne le rejouent.
  const integ: LotState[] = [];
  // L370 : un lot rendu hors de l'intégration que le lead a fait corriger puis revoir hors vague (revue conforme au dernier commit du worktree) est repris à l'intégration avec ce verdict.
  const leadReviewed = new Map<LotState, { head: string; verdict: string }>();
  const budgeted = args.lotBudgets.map((b) => lots.filter((x) => x.lot === b.lot && (b.project ? x.project === b.project : true))).filter((m) => m.length === 1).map((m) => m[0]);
  for (const t of args.integrate) {
    const matches = lots.filter((x) => x.lot === t.lot && (t.project ? x.project === t.project : true));
    const opt = t.replay ? '--replay' : '--integrate';
    const where = `${t.project ? `${t.project}:` : ''}${t.lot}`;
    if (matches.length !== 1) {
      refusals.push(matches.length ? `${opt} ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `${opt} ${where} : lot inconnu dans la vague ${wave.id}`);
      continue;
    }
    const l = matches[0];
    const key = lotKey(l.project, l.lot);
    if (integ.includes(l)) refusals.push(`${opt} ${key} : lot visé deux fois`);
    else if (dropped.includes(l)) refusals.push(`${opt} ${key} : lot aussi retiré par --drop`);
    else if (answered.includes(l)) refusals.push(`${opt} ${key} : lot aussi visé par --answer`);
    else if (budgeted.includes(l)) refusals.push(`${opt} ${key} : lot aussi visé par --budget`);
    else if (!t.replay && l.next !== 'integrate' && (() => {
      // La revue du lead est écrite par `raf review` lancé dans le worktree : c'est le plan du worktree qui la porte, pas celui du dépôt principal.
      const tree = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      const r = existsSync(join(tree, '.git')) ? leadReviewedHandBack(l, planLoader(tree)(), tree) : null;
      if (r) leadReviewed.set(l, r);
      return r;
    })()) integ.push(l);
    else if (l.status !== 'handed-back' || (l.next !== 'integrate' && !(t.replay && planNoteHandBack(l)))) refusals.push(`${opt} ${key} : le lot n'est pas rendu ${t.replay ? "à l'étape d'intégration ni sur une écriture de plan refusée" : "à l'étape d'intégration"} (${l.status}, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'})${gestureSuffix(wave, l)}`);
    else integ.push(l);
  }
  // Un lot retiré ne jouera rien : il ne subit ni le verrou du dépôt, ni le .nvmrc, ni l'arbre sale — un refus pour LUI ne doit pas faire échouer la reprise des autres.
  const [live, removed]: LotState[][] = [[], []];
  for (const l of lots) {
    if (lotFinished(l) && !raised.has(l) && !integ.includes(l)) continue;
    for (const s of l.steps) {
      if (s.status !== 'running') continue;
      if (s.pid && pidAlive(s.pid)) refusals.push(`${lotKey(l.project, l.lot)} : session encore en vie, pid ${s.pid}`);
      else s.status = 'interrupted';
    }
    (drops.includes(lotKey(l.project, l.lot)) ? removed : live).push(l);
  }
  // Comme au départ : un dépôt tenu par une autre orchestration vivante est refusé avant toute écriture.
  // L443 : une reprise d'intégration (--integrate, --replay) attend la fin de l'autre vague au lieu de sortir en 2 ; toute autre reprise refuse comme avant.
  // Un refus déjà connu (vague qui tourne encore, claude introuvable, session en vie…) sort en 2 tout de suite : attendre 3 h ne le lèverait pas.
  const waitFor = integ.length && !refusals.length ? { waitMs: deps.repoWait?.waitMs ?? REPO_WAIT_MS, pollMs: deps.repoWait?.pollMs ?? REPO_WAIT_POLL_MS } : null;
  const deadline = Date.now() + (waitFor?.waitMs ?? 0);
  // Pendant l'attente (jusqu'à 3 h) la reprise est inscrite parmi les vagues vivantes : le garde « la vague tourne encore » d'une seconde reprise la voit, et ne vient pas attendre à son tour.
  let waiting = false;
  // Verrous pris à la fin de l'attente : tenus jusqu'à `execute` (qui les retrouve à son pid), pour qu'une autre reprise qui attendait le même dépôt ne le voie pas libre pendant le .nvmrc, l'arbre et l'écriture des lots.
  const taken: string[] = [];
  // L553 : dépôts tenus par une AUTRE vague vivante (la porteuse) dont la reprise ne prend pas le verrou (voir `passesBetweenSteps`).
  const shared = new Map<string, { wave: string; pid: number }>();
  const stopBefore = store.control().stopAfterCurrent;
  const playsIntegrationOnly = (l: LotState) => integ.includes(l) && (l.next === 'integrate' || leadReviewed.has(l)) && existsSync(join(lotTreeDir(store.dir, l.project, l.lot, l.repo), '.git'));
  try {
    for (const repo of new Set(live.flatMap(lotRepoPaths))) {
      const file = join(sharedStateDir(repo), REPO_LOCK);
      let announced: string | null = null;
      for (;;) {
        let busy = activeLock(file);
        if (waitFor && (!busy || busy.pid === process.pid)) {
          const t = takeLock(file, { pid: process.pid, wave: wave.id, started: new Date().toISOString() });
          if (t.ok) {
            taken.push(file);
            if (t.stale) io.err(`orchestrate : verrou de dépôt périmé retiré (${basename(repo)}, pid ${t.stale.pid} mort)`);
            break;
          }
          busy = t.held;
        }
        if (!busy || busy.pid === process.pid) break;
        // Le verrou porte l'id de la vague : tenu par un processus vivant de CETTE vague, c'est une autre reprise de la même vague,
        // entre son verrou et son inscription par `execute` (le garde « tourne encore » ci-dessus ne la voit pas encore) : refus, pas d'attente.
        if (busy.wave === wave.id) {
          refusals.push(`la vague ${wave.id} tourne encore (pid ${busy.pid}, verrou de ${basename(repo)})`);
          break;
        }
        // L553 : l'intégration d'un lot en worktree n'attend pas la fin d'une autre vague : comme un push du lead, elle passe entre ses étapes (son rebase rejoue si `main` avance, le verrou d'intégration les départage).
        if (waitFor && passesBetweenSteps(live, playsIntegrationOnly, repo, busy)) {
          shared.set(repo, { wave: busy.wave, pid: busy.pid });
          io.out(`orchestrate : ${basename(repo)} : tenu par la vague ${busy.wave} (pid ${busy.pid}) : l'intégration passe entre ses étapes, sans attendre sa fin`);
          break;
        }
        // Un refus déjà posé sur un dépôt précédent (même vague, attente échue) : les suivants ne font plus attendre, la reprise sort en 2.
        if (!waitFor || refusals.length || Date.now() >= deadline) {
          refusals.push(heldRefusal(repo, busy));
          break;
        }
        if (!waiting) {
          registerWave(cadenceHome(), { pid: process.pid, wave: wave.id, started: new Date().toISOString(), cwd: launch, repos: [] });
          waiting = true;
        }
        if (announced !== busy.wave) io.out(`orchestrate : ${basename(repo)} : tenu par la vague ${busy.wave} (pid ${busy.pid}) : attente de sa fin avant de reprendre l'intégration (l'attente ne réserve aucun créneau de session : les autres sessions ne sont pas bloquées)`);
        announced = busy.wave;
        await new Promise<void>((res) => setTimeout(res, Math.min(waitFor.pollMs, Math.max(1, deadline - Date.now()))));
      }
    }
  } finally {
    if (waiting) unregisterWave(cadenceHome(), process.pid);
  }
  // Avant `execute`, tout refus ou échec rend les verrous pris ; `execute` les garde ensuite et les rend à sa fin.
  let played = false;
  try {
    // Comme au départ : le .nvmrc est relu à chaque reprise (version désinstallée, .nvmrc changé, vague d'avant L80),
    // et un Node introuvable refuse le lot — jamais de repli silencieux sur le Node par défaut.
    const nodes = new Map<LotState, NodeChoice>();
    for (const l of live) {
      const node = resolveNode(l.repo, nvmVersionsDir(io.env));
      if (node.kind === 'missing') refusals.push(`${lotKey(l.project, l.lot)} : ${node.message}`);
      else nodes.set(l, node);
    }
    // Tous les refus avant la moindre écriture (l'arbre sale compris) : une reprise refusée ne change pas l'état de la vague.
    const dirty = new Set<string>();
    for (const repo of live.flatMap(lotRepoPaths)) if (!dirty.has(repo)) {
      dirty.add(repo);
      const d = await trackedDirty(repo);
      if (d.length) refusals.push(`${basename(repo)} : arbre sale, ${d.length} fichier(s) suivi(s) modifié(s) : ${d.join(', ')}`);
    }
    // Les worktrees des lots repris suivent les mêmes gardes qu'un dépôt (R11) : un fichier suivi modifié refuse la reprise.
    for (const l of live) {
      const dir = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      if (!existsSync(join(dir, '.git'))) continue;
      const d = await trackedDirty(dir);
      if (d.length) refusals.push(`${basename(dir)} : arbre sale, ${d.length} fichier(s) suivi(s) modifié(s) : ${d.join(', ')}`);
    }
    if (refusals.length) {
      for (const r of refusals) io.err(`orchestrate : ${r}`);
      return 2;
    }
    for (const [l, node] of nodes) {
      if (node.kind === 'ok') l.node = { version: node.version, wanted: node.wanted, bin: node.bin, link: (deps.linkNode ?? linkNodeBin)(store.dir, node.version, node.bin) };
      else delete l.node;
    }
    // Une étape interrompue (signal, crash) dont les tokens n'ont pas été comptés : relue dans le journal de sa session.
    const recovered = new Budget(0);
    // La session d'un lot en worktree a travaillé dans son worktree : c'est là que son journal se range.
    const workdirOf = (l: LotState): string => {
      const dir = lotTreeDir(store.dir, l.project, l.lot, l.repo);
      return existsSync(join(dir, '.git')) ? dir : l.repo;
    };
    for (const l of [...live, ...removed]) for (const s of l.steps) if (s.status === 'interrupted') countInterrupted(deps.claudeHome, workdirOf(l), s, recovered);
    wave.consumed += recovered.consumed;
    wave.cacheRead += recovered.cacheRead;
    if (recovered.consumed || recovered.cacheRead) store.writeWave(wave);
    for (const [l, r] of raised) {
      const k = lotKey(l.project, l.lot);
      const text = `budget relevé de ${r.from} à ${r.to} (--resume --budget)`;
      l.budget = r.to;
      l.status = 'suspended';
      l.next = r.step;
      l.outcome = null;
      l.warnings.push(text);
      store.journal(`${k} → suspended — ${text}`);
      io.out(`${k} → suspended — ${text}`);
    }
    for (const l of integ) resumeIntegration(l, leadReviewed.get(l), store, io);
    for (const l of live) {
      if (l.status === 'implementing' || l.status === 'reviewing' || l.status === 'fixing') l.status = 'suspended';
      store.writeLot(l);
    }
    if (args.budget !== undefined) wave.budget = wave.consumed + args.budget;
    // Un arrêt demandé à la vague d'avant ne doit pas arrêter celle-ci ; celui demandé pendant l'attente (la reprise est alors visible de --stop-after-current) est gardé.
    if (!(waiting && !stopBefore && store.control().stopAfterCurrent)) store.clearStopRequest();
    // L557 (issue #26) : un lot nommé par --integrate qui portait un retrait déjà appliqué (--drop d'une reprise précédente) est repris à la main puis revu : le retrait est consommé, sinon la vague le rendrait au lead sans l'intégrer.
    store.consumeDrops(integ.map((l) => lotKey(l.project, l.lot)));
    for (const l of removed) markRemoved(l, wave.id, store, io);
    if (live.length === 0) {
      if (lots.every(lotFinished)) {
        wave.status = 'done';
        store.writeWave(wave);
      }
      for (const line of renderTable(wave, lots, { prices: launchPrices(launch, (w) => io.err(`orchestrate : ${w}`)) })) io.out(line);
      for (const line of keptLines(lots.map((l) => l.repo))) io.out(line);
      return removed.length && !lots.every((l) => l.status === 'ready') ? 1 : 0;
    }
    played = true;
    return continueRounds(await execute(wave, live, store, io, deps, today, { ...args, shared }, lots), wave, lots, store, io, deps, today, args, launch);
  } finally {
    if (!played) for (const f of taken) releaseLock(f, process.pid);
  }
}

/** Un lot retiré par `--drop` : la demande est déposée, le lot est rendu au lead sans être rejoué ; son worktree et sa branche restent (R12). */
function markRemoved(l: LotState, waveId: string, store: RunStore, io: OrchestrateIo): void {
  const k = lotKey(l.project, l.lot);
  store.requestDrop(k);
  store.journal(`demande : retirer ${k} de la vague (--resume --drop)`);
  io.out(`${k} : retrait demandé — le lot est rendu au lead sans être rejoué`);
  l.next = null;
  l.status = 'handed-back';
  l.outcome = DROPPED;
  store.writeLot(l);
  store.journal(`${k} → handed-back — ${DROPPED}`);
  // Un lot retiré garde son worktree et sa branche (R12) : le journal en donne le chemin.
  const branch = lotBranch(waveId, l.project, l.lot);
  if (baseBranchOf(l.repo, branch)) {
    const line = `orchestrate : ${k} : worktree conservé : ${lotTreeDir(store.dir, l.project, l.lot, l.repo)} (branche ${branch})`;
    io.out(line);
    store.journal(line);
  }
}

/**
 * L553 : le verrou du dépôt est celui d'une autre VAGUE (pas une tâche locale du lead, qui écrit dans l'arbre principal), aucune de ses sessions ne travaille dans l'arbre principal
 * (`mainTreeWorkers`, L475 : `main` avancerait sous elle) et la reprise n'y joue que des intégrations de lots qui ont leur worktree (rendus à l'étape d'intégration, ou revus par le lead :
 * pas un `--replay` qui rejoue des sessions) : rien d'autre n'écrit dans le dépôt, l'intégration est déjà sérialisée par son propre verrou.
 */
function passesBetweenSteps(live: LotState[], playsIntegrationOnly: (l: LotState) => boolean, repo: string, busy: { wave: string; pid: number }): boolean {
  return localLotOf(busy.wave) === null && live.filter((l) => lotRepoPaths(l).includes(repo)).every(playsIntegrationOnly) && mainTreeWorkers(cadenceHome(), busy.pid, repo)?.length === 0;
}

/** Un lot repris par `--integrate` ou `--replay` repart suspendu : à l'intégration, ou à l'étape d'écriture de plan gardée ; avec la revue du lead hors vague quand elle tient lieu de revue (L370). */
function resumeIntegration(l: LotState, lead: { head: string; verdict: string } | undefined, store: RunStore, io: OrchestrateIo): void {
  const k = lotKey(l.project, l.lot);
  if (lead) adoptLeadReview(l, lead);
  const planNote = l.next !== 'integrate'; // rendu sur une écriture de plan refusée (--replay) : le lot repart de l'étape gardée
  if (planNote && l.outcome?.startsWith(HYPOTHESES_HANDBACK)) l.hypotheses = undefined; // les notes d'hypothèses se posent de nouveau (sans doublon) à l'entrée de l'étape
  l.status = 'suspended';
  l.outcome = null;
  const text = planNote ? `écriture du plan reprise à l'étape ${l.next} (--resume --replay)` : integrationText(lead ?? null);
  store.journal(`${k} → suspended — ${text}`);
  io.out(`${k} → suspended — ${text}`);
}
