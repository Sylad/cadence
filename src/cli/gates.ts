// Les portes : raf ux / raf review, et les trois hooks git (pre-commit, post-commit, pre-push) (L488, sorti de cli.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readHookConfig, readOrchestrateConfig } from '../config.js';
import { repoShas, resolveLotRepos } from '../repos.js';
import { exemptPlanOnly, isPlanOnly, lotWork, ownFiles } from '../audit.js';
import { type Day } from '../dates.js';
import { PLAN_ACTIONS } from '../plan-commit.js';
import { printUncommittedPlan } from '../plan-uncommitted.js';
import { matchesHead, readCommits, stage, stagedFiles, syncIndexWithHead } from '../git.js';
import { installHook, pendingCommitMessage, REFUSED } from '../hook.js';
import { gateRefusal, pushRefusal, UNGATED_ENV } from '../push-guard.js';
import { citedRefs } from '../link.js';
import { loadEntries } from '../news.js';
import { Plan, RafError } from '../plan.js';
import { dueLine, isRecurring } from '../recurring.js';
import { TITLE_MAX, truncate } from '../lead.js';
import { waveHolding } from '../repo-busy.js';
import { cadenceHome, waveLotsIn } from '../orchestrate/registry.js';
import { localLotOf } from '../local-task.js';
import { type Ctx, type Io, planFileIn, touchedLot } from './context.js';

const GATES = {
  ux: { on: 'revue UX obligatoire pour les lots visibles', already: 'revue UX déjà active', action: PLAN_ACTIONS.uxRecorded },
  review: { on: 'revue de code obligatoire pour les lots à commits', already: 'revue de code déjà active', action: PLAN_ACTIONS.reviewRecorded },
};

/** « raf ux … » et « raf review … » ont la même forme : activer la porte, ou noter le verdict d'un lot. */
function gate(kind: keyof typeof GATES, rest: string[], loadPlan: () => Plan, root: string, today: Day, io: Io, opts: { verbose: boolean; commit: string | undefined }): number {
  if (rest.length < 1) throw new RafError(`usage : raf ${kind} enable | ${kind} <lot> "verdict"`);
  const plan = loadPlan();
  if (rest[0] === 'enable') {
    const changed = kind === 'ux' ? plan.enableUx(today) : plan.enableReview(today);
    plan.save();
    io.out(changed ? `${GATES[kind].on} à partir du ${today}` : `${GATES[kind].already} depuis le ${kind === 'ux' ? plan.uxSince : plan.reviewSince}`);
    return 0;
  }
  if (rest.length < 2) throw new RafError(`usage : raf ${kind} <lot> "verdict"`);
  // Le plan refuse lui-même une sous-tâche, un verdict vide, un lot inconnu.
  const verdict = rest.slice(1).join(' ');
  if (kind === 'ux') plan.recordUx(rest[0], verdict, today);
  // Le verdict vaut jusqu'au dernier commit compté du lot ; un plan en lecture seule refuse sans lire git.
  else {
    // Les dépôts voisins du lot : un dépôt qu'on ne peut pas lire ferait enregistrer un verdict sur un sha non lu.
    const neighbours = plan.readonly || rest[0].includes('/') ? undefined : resolveLotRepos(root, plan.lots().find((l) => l.id === rest[0]) ?? {});
    if (neighbours?.problems.length) throw new RafError(`${neighbours.problems.join(' ; ')} — la revue de code relit aussi les dépôts du lot`);
    plan.recordReview(rest[0], verdict, today, plan.readonly ? null : (lotWork(plan, root, rest[0])[0]?.sha ?? null), neighbours?.repos.length ? repoShas(plan, neighbours.repos, rest[0]) : undefined);
  }
  plan.save();
  touchedLot(plan, rest[0], opts.verbose, io);
  // Comme `raf done` (L371) : le plan et la copie publiée que `plan.onWrite` vient de régénérer partent dans le même commit (L509).
  printUncommittedPlan(io.out, plan, root, rest[0], opts.commit, GATES[kind].action);
  return 0;
}

/** Un titre de lot n'est jamais rendu en entier par défaut (L453) : ~300 caractères répétés à chaque commande, chaque commit de plan. */
function shortTitle(title: string, verbose: boolean | undefined): string {
  return verbose ? title : truncate(title, TITLE_MAX);
}

/**
 * Pre-commit : un commit qui cite un lot encore todo. `warn` (défaut) : rien ici, le post-commit avertit ; `refuse` :
 * échoue (REFUSED) avec « raf start <id> » ; `start` : démarre le lot et met le plan dans l'index, donc dans CE commit,
 * mais seulement si le plan est identique à HEAD : sinon rien n'est démarré (message, puis avertissement du post-commit).
 * Ne rend REFUSED que pour un refus : toute autre panne laisse le commit passer. Sans message lisible (éditeur), rien.
 */
function preCommit(load: (() => Plan) | null, mode: 'warn' | 'refuse' | 'start' | undefined, root: string, today: Day, io: Io): number {
  if (!load || !mode || mode === 'warn') return 0;
  try {
    const message = pendingCommitMessage(io.env);
    if (message === null) return 0;
    const plan = load();
    const [subject = '', ...body] = message.split('\n');
    const refs = citedRefs({ sha: '', day: today, subject, body: body.join('\n').trim() }, plan.refs);
    const staged = stagedFiles(root);
    const own = ownFiles(plan, root);
    // Entretien du plan : tous les fichiers du commit sont ceux du plan (la configuration seule ne compte pas).
    if (staged.length > 0 && staged.every((f) => own.has(f) && f !== relative(root, plan.configFile ?? join(root, 'cadence.yaml')))) return 0;
    const todo = [...new Set(refs.map((r) => r.lot))].filter((id) => {
      const lot = plan.lots().find((l) => l.id === id);
      return lot?.status === 'todo' && !isRecurring(lot);
    });
    if (todo.length === 0) return 0;
    if (mode === 'refuse') {
      for (const id of todo) io.err(`raf: ${id} est encore todo — commit refusé (hook.autostart: refuse)${plan.readonly ? '' : ` : raf start ${id}`} (--no-verify pour passer outre)`);
      return REFUSED;
    }
    if (plan.readonly) return 0;
    const file = relative(root, plan.path);
    // Un plan déjà modifié (stagé ou non) : le restager emporterait ces modifications dans ce commit, ou, sur un
    // commit partiel, les perdrait. On ne démarre rien ; le post-commit avertit comme en mode warn.
    if (!matchesHead(root, file)) {
      io.err(`raf: plan modifié non commité : démarrage automatique sauté (hook.autostart: start), raf start ${todo.join(' ')} à la main`);
      return 0;
    }
    for (const id of todo) plan.setStatus(id, 'doing', today, {});
    try {
      plan.save();
    } catch (e) {
      if (!(e instanceof RafError)) throw e;
      // plan.onWrite en échec (L346) : le plan est resté tel quel, le commit part sans lui et le dit.
      io.err(`raf: démarrage automatique refusé : ${e.message} ; raf start ${todo.join(' ')} à la main`);
      return 0;
    }
    for (const id of todo) io.err(`raf: ${id} était todo — raf start ${id} fait par le hook, plan inclus dans ce commit`);
    stage(root, file);
    for (const f of plan.produced) stage(root, f);
  } catch {
    // Un hook ne doit jamais gêner un commit, hors refus.
  }
  return 0;
}

function postCommit(load: (() => Plan) | null, newsDir: string, root: string, today: Day, io: Io, mode?: 'warn' | 'refuse' | 'start', verbose?: boolean): number {
  if (!load) return 0;
  try {
    const plan = load();
    if (mode === 'start' && !plan.readonly) syncIndexWithHead(root, relative(root, plan.path));
    const head = readCommits(root, { range: '-1' })[0];
    if (!head) return 0;
    const refs = citedRefs(head, plan.refs);
    if (refs.length === 0) {
      const planOnly = exemptPlanOnly({ byLot: new Map(), orphans: [head], unknown: [] }, plan, root).orphans.length === 0;
      if (!planOnly && !/^Merge\b/.test(head.subject)) {
        io.err('raf: commit sans lot — citer un identifiant la prochaine fois (raf now)');
      }
      return 0;
    }
    const lots = new Map(plan.lots().map((l) => [l.id, l]));
    const planning = isPlanOnly(head.sha, plan, root);
    for (const r of refs) {
      const lot = lots.get(r.lot);
      if (!lot) io.err(`raf: ${r.lot} n'existe pas dans le plan`);
      else if (isRecurring(lot)) io.err(`raf: ${r.lot} est récurrent (${dueLine(lot, today)})${plan.readonly ? '' : ` — raf did ${r.lot}`}`);
      else if (lot.status === 'todo' && !planning) io.err(`raf: ${r.lot} est encore todo${plan.readonly ? '' : ` — raf start ${r.lot}`}`);
      else io.err(`raf: ${r.lot} (${lot.status}) ${shortTitle(lot.title, verbose)}`);
    }
    const entries = loadEntries(newsDir);
    for (const id of new Set(refs.map((r) => r.lot))) {
      if (lots.get(id)?.visible && !entries.some((e) => e.lots.includes(id))) io.err(`raf: ${id} est visible : cadence news new ${id}`);
    }
  } catch {
    // Un hook ne doit jamais gêner un commit.
  }
  return 0;
}

/**
 * `raf hook pre-push` (L405), appelé par le hook que la vague pose : refuse (code 3) un push qui emporte un commit d'un lot pas prêt de la vague vivante
 * du dépôt, ou dont un lot pas prêt a des commits illisibles (la garde de `deliver --sha`). Puis (L426), quand le projet déclare une porte, refuse un push dont
 * le sha de tête n'a pas de verdict vert de `cadence verify --gate` (`CADENCE_PUSH_UNGATED=1` passe outre, et le dit) ; un commit qui ne change que le plan reprend le verdict de son parent (L432). Sans vague qui tient le dépôt, ou avec un état de vague illisible
 * (avertissement), la première garde ne gêne jamais un push ; une config illisible laisse passer la seconde.
 */
function prePush(root: string, io: Io, remoteName: string | undefined, configPath: string, planFile: string): number {
  let input = '';
  try {
    input = io.stdin ? io.stdin() : readFileSync(0, 'utf8');
  } catch {
    return 0;
  }
  const holding = waveHolding(root);
  // Une tâche locale du lead (L519) tient le dépôt comme une vague, mais n'a pas de lots de vague : rien à vérifier pour la première garde, et pas de faux « état illisible ».
  if (holding && !localLotOf(holding.wave)) {
    const lots = waveLotsIn(cadenceHome(), holding.pid, root);
    if (lots === null) {
      io.err(`raf: vague ${holding.wave} : état illisible, push non vérifié`);
    } else {
      const refusal = pushRefusal(root, holding.wave, lots, input, remoteName || undefined);
      if (refusal) {
        io.err(`raf: ${refusal}`);
        return REFUSED;
      }
    }
  }
  // La porte du projet (L426) : une config illisible ne gêne pas un push, comme un état de vague illisible.
  let gate = false;
  try {
    const config = readOrchestrateConfig(configPath);
    gate = Boolean(config.test || config.build);
  } catch {
    return 0;
  }
  const refusal = gateRefusal(root, gate, input, planFile);
  if (!refusal) return 0;
  if (io.env[UNGATED_ENV] === '1') {
    io.err(`raf: ${refusal.replace(/^push refusé/, 'push passé outre')} — ${UNGATED_ENV}=1 est posée`);
    return 0;
  }
  io.err(`raf: ${refusal}`);
  return REFUSED;
}

/** raf hook install|pre-commit|post-commit|pre-push. */
export function cmdHook(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, configPath, planPath, loadPlan, newsDir } = c;
  if (rest[0] === 'install') {
    const { path, changed } = installHook(io.cwd);
    io.out(changed ? `hook installé : ${path}` : `hook déjà présent : ${path}`);
    return 0;
  }
  if (rest[0] === 'post-commit') return postCommit(existsSync(planPath) ? loadPlan : null, newsDir, root, today, io, readHookConfig(configPath).autostart, !!values.verbose);
  if (rest[0] === 'pre-commit') return preCommit(existsSync(planPath) ? loadPlan : null, readHookConfig(configPath).autostart, root, today, io);
  if (rest[0] === 'pre-push') return prePush(root, io, rest[1], configPath, planFileIn(root, planPath));
  throw new RafError('usage : raf hook install|pre-commit|post-commit|pre-push');
}

/** raf ux|review : active la porte, ou note le verdict d'un lot. */
export function cmdGate(c: Ctx): number {
  const { command, rest, values, io, today, root, planConfig, loadPlan } = c;
  return gate(command as keyof typeof GATES, rest, loadPlan, root, today, io, { verbose: !!values.verbose, commit: planConfig?.commit });
}
