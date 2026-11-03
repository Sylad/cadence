// deliver, verify (et sa porte --gate) et local : la livraison du projet (L488, sorti de cli.ts).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultPlan, readDocsConfig, readOrchestrateConfig, readPlanConfig, readVerifyConfig } from '../config.js';
import { type Day } from '../dates.js';
import { blockProblem } from '../deliver-blocks.js';
import { deliver, type DeliveredCtx, parseDeliverConfig, realDeps } from '../deliver.js';
import { defaultTarget, realCheckDeps, verifyCommand } from '../verify.js';
import { verifyGate } from '../verify-gate.js';
import { gitRoot, resolveCommit } from '../git.js';
import { loadEntries } from '../news.js';
import { type Lot, Plan, RafError } from '../plan.js';
import { waveHolding } from '../repo-busy.js';
import { cadenceHome, waveLotsIn } from '../orchestrate/registry.js';
import { blockingLots, LABEL } from '../orchestrate/table.js';
import { localCommand, localLotOf } from '../local-task.js';
import { sharedStateDir } from '../state.js';
import { type Ctx, type Io, planFileIn } from './context.js';

/**
 * Ce qu'une livraison verte annonce et ouvre (lots livrés, article à rafraîchir, L144) : pour `cadence deliver` et pour la ligne verte
 * que `cadence verify` inscrit (L435). Sans `public:`, un lot visible tire son titre de sa Nouveauté la plus récente.
 */
function deliveredEffects(p: { root: string; configPath: string; planPath: string; loadPlan: () => Plan; newsDir: string; today: Day; waveId: string | undefined; io: Io }): DeliveredCtx {
  const { root, configPath, newsDir, io } = p;
  const publicTitle = (lot: Lot) => lot.public ?? (lot.visible ? loadEntries(newsDir).find((e) => e.lots.includes(lot.id))?.title : undefined);
  const plan = existsSync(p.planPath) ? p.loadPlan() : null;
  return { root, plan, today: p.today, articles: readDocsConfig(configPath).articles, publicTitle, planCommit: readPlanConfig(configPath, root)?.commit, waveId: p.waveId, out: io.out, err: io.err };
}

/** `verify --gate --sha rév [--project dossier]` (L348) : la porte du projet rejouée au sha ; `--project` est un sous-dossier du dossier courant qui a son propre dépôt. */
async function verifyGateCommand(values: { sha?: string; project?: string; retry?: string; config?: string }, io: Io): Promise<number> {
  if (values.sha === undefined) throw new RafError('verify --gate : --sha obligatoire (le sha à re-vérifier, jamais la tête mouvante d\'une vague)');
  if (values.retry !== undefined) throw new RafError('verify --gate : --retry ne va qu\'à verify seul (deliver.verify)');
  const dir = values.project === undefined ? io.cwd : resolve(io.cwd, values.project);
  if (values.project !== undefined && !existsSync(dir)) throw new RafError(`verify --gate : --project ${values.project} : dossier introuvable sous ${io.cwd}`);
  const top = gitRoot(dir);
  if (!top) throw new RafError('verify --gate : à lancer dans un dépôt git (ou --project vers le dossier d\'un projet)');
  if (values.project !== undefined && realpathSync(top) !== realpathSync(dir)) throw new RafError(`verify --gate : ${values.project} n'a pas son propre dépôt git (dépôt parent : ${top})`);
  const configPath = resolve(io.cwd, values.config ?? join(top, 'cadence.yaml'));
  const sha = resolveCommit(top, values.sha);
  if (!sha) throw new RafError(`verify --gate : --sha ${values.sha} : commit introuvable dans ${top}`);
  // Le plan du projet (L444) : les commits qui ne changent que lui au-dessus du sha reprennent la porte du sha dessous. Illisible, il n'est pas cherché : la porte se rejoue.
  let planFile: string | undefined;
  try {
    const configured = readPlanConfig(configPath, top)?.path;
    planFile = planFileIn(top, configured !== undefined ? resolve(top, configured) : defaultPlan(top).path);
  } catch {
    planFile = undefined;
  }
  return verifyGate({ repo: top, sha, config: readOrchestrateConfig(configPath), verify: readVerifyConfig(configPath), launchDirs: [io.cwd, top, dirname(top)], planFile, now: io.now, out: io.out });
}

/** cadence deliver : refusé pendant une vague sauf un sha livrable, puis la livraison du projet. */
export function cmdDeliver(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, configPath, planPath, loadPlan, newsDir } = c;
  if (!gitRoot(io.cwd)) throw new RafError('deliver : à lancer dans un dépôt git');
  const orchestrating = waveHolding(root, 'deliver');
  if (orchestrating) {
    const refusal = `deliver : orchestration en cours (vague ${orchestrating.wave}, pid ${orchestrating.pid})`;
    if (values.sha === undefined) throw new RafError(`${refusal} — livrer une fois les lots de ce dépôt finis (le verrou tombe dès que tous sont prêts ou rendus), ou un sha « livrable jusqu'à » de la vague (--sha)`);
    // L277 : un sha dont tous les commits de la vague citent des lots prêts se livre au fil de l'eau ; l'état de la vague illisible ou un sha inconnu : refus.
    const lots = waveLotsIn(cadenceHome(), orchestrating.pid, root);
    const target = resolveCommit(root, values.sha);
    if (lots === null) throw new RafError(`${refusal} — état de la vague illisible : --sha ${values.sha} ne peut pas être vérifié`);
    if (!target) throw new RafError(`${refusal} — --sha ${values.sha} : commit introuvable`);
    const { blocking, unreadable } = blockingLots(lots, root, target);
    if (blocking.length > 0) {
      throw new RafError(`${refusal} — ${target.slice(0, 7)} contient des commits de lots pas prêts : ${blocking.map((l) => `${l.project}:${l.lot} (${LABEL[l.status]})`).join(', ')} ; livrer un sha antérieur (« livrable jusqu'à » du tableau de la vague) ou attendre leur fin`);
    }
    if (unreadable.length > 0) {
      throw new RafError(`${refusal} — commits illisibles (plan du projet ou dépôt) des lots pas prêts ${unreadable.map((l) => `${l.project}:${l.lot} (${LABEL[l.status]})`).join(', ')} : --sha ${values.sha} ne peut pas être vérifié ; rétablir le plan ou attendre la fin de ces lots`);
    }
  }
  if (!existsSync(configPath)) throw new RafError(`pas de configuration de livraison : ${configPath} (voir « cadence.yaml » dans docs/deliver.md du paquet @sylad/cadence)`);
  const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
  // Refusé avant toute étape (aucun script, aucune ligne de journal) : un bloc inconnu livrerait sans filtre.
  const refused = values.block === undefined ? null : blockProblem(values.block, config);
  if (refused) {
    io.err(`deliver : ${refused}`);
    return 1;
  }
  const effects = deliveredEffects({ root, configPath, planPath, loadPlan, newsDir, today, waveId: orchestrating?.wave, io });
  return deliver({ ...effects, state: sharedStateDir(root), config, dryRun: !!values['dry-run'], sha: values.sha, block: values.block, duringWave: !!orchestrating, args: rest }, realDeps(root));
}

/** cadence verify [--gate] : rejoue deliver.verify, ou la porte du projet. */
export function cmdVerify(c: Ctx): number | Promise<number> {
  const { values, io, today, root, configPath, planPath, loadPlan, newsDir } = c;
  if (values.gate) return verifyGateCommand(values, io);
  if (!gitRoot(io.cwd)) throw new RafError('verify : à lancer dans un dépôt git');
  if (!existsSync(configPath)) throw new RafError(`pas de configuration : ${configPath} (voir « cadence.yaml » dans docs/deliver.md du paquet @sylad/cadence)`);
  const retry = values.retry === undefined ? 0 : Number(values.retry);
  if (!Number.isFinite(retry) || retry < 0) throw new RafError(`--retry invalide : ${values.retry} (secondes, 0 ou plus)`);
  const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
  const target = values.sha ? { sha: resolveCommit(root, values.sha) ?? '', note: null } : defaultTarget(root, config);
  if (values.sha && !target.sha) throw new RafError(`--sha ${values.sha} : commit introuvable`);
  // Une ligne verte écrite par verify (L435) est une livraison : mêmes effets que deliver (lots annoncés, article à rafraîchir, L144).
  // verify lit le verrou sans refuser : une tâche locale du lead (L519) n'empêche pas de rejouer les vérifications, et n'est pas une vague à citer.
  const holding = waveHolding(root);
  const waveId = holding && !localLotOf(holding.wave) ? holding.wave : undefined;
  const effects = () => deliveredEffects({ root, configPath, planPath, loadPlan, newsDir, today, waveId, io });
  return verifyCommand({ config, sha: target.sha, note: target.note, retry, out: io.out, journal: { dir: sharedStateDir(root), day: today, effects } }, realCheckDeps(root));
}

/** cadence local start|done|abort : la tâche locale du lead. */
export function cmdLocal(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, loadPlan } = c;
  return localCommand(rest, values.ttl, { repo: gitRoot(root) ?? root, loadPlan, today, now: io.now, gate: (sha) => verifyGateCommand({ sha }, io), out: io.out, err: io.err });
}
