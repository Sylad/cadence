import { gateProgress, gateText } from '../audit.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLAN_DEFAULT, PLAN_LEGACY, planLoader, readOrchestrateConfig, type OrchestrateConfig } from '../config.js';
import { gitRoot } from '../git.js';
import { localLotRefusal } from '../local-task.js';
import { Plan, isOpen } from '../plan.js';
import { budgetStage } from './spec.js';
import { launchScreen, launchedLot } from './cycle/retreci.js';
import { ESCALATION_RESERVE } from './cycle.js';
import { addableHandBack, droppedAddSuffix } from './geste.js';
import { type AnyModel } from './launch.js';
import { projectName, type KnownLot } from './ajout.js';
import { repoRefusals } from './depot.js';
import { resolveLotRepos } from '../repos.js';
import { lotKey, newLot, type LotState } from './state.js';
import { isExpress } from './express.js';
import { nvmVersionsDir, resolveNode } from './node-env.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';
import { measuredBudgetsAt } from './budget-mesure.js';
import { lotBudget } from './lot-budget.js';
import { readAgents, type AgentDef } from './launch.js';

export interface Target {
  project: string;
  projectDir: string;
  repo: string;
  lot: string;
  model: AnyModel;
}

/** Ce qu'un projet fournit à l'orchestrateur : sa configuration et la lecture de son plan (comme le CLI). */
export function projectEnv(repo: string): { config: OrchestrateConfig; loadPlan: () => Plan; configPath: string } {
  const configPath = join(repo, 'cadence.yaml');
  const loadPlan = planLoader(repo);
  return { config: readOrchestrateConfig(configPath), loadPlan, configPath };
}

const isProject = (dir: string) => existsSync(join(dir, PLAN_DEFAULT)) || existsSync(join(dir, PLAN_LEGACY)) || (existsSync(join(dir, 'cadence.yaml')) && /^plan\s*:/m.test(readFileSync(join(dir, 'cadence.yaml'), 'utf8')));

export function resolveTargets(args: Pick<Args, 'lots'>, io: OrchestrateIo, refusals: string[]): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const l of args.lots) {
    const projectDir = l.project ? resolve(io.cwd, l.project) : io.cwd;
    const project = projectName(io.cwd, l.project); // L421 : `.:L2` depuis le dépôt et `L2` désignent le même projet que les lots de la vague
    const key = lotKey(project, l.lot);
    if (seen.has(key)) {
      refusals.push(`${key} : lot donné deux fois`);
      continue;
    }
    seen.add(key);
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      refusals.push(`${key} : ${l.project ? `dossier ${projectDir} introuvable (le projet est un sous-dossier du dossier courant ; dans un dépôt, \`.:${l.lot}\`)` : 'dossier courant illisible'}`);
      continue;
    }
    if (!isProject(projectDir)) {
      refusals.push(`${key} : ${projectDir} n'est pas un projet cadence (${PLAN_DEFAULT}, ${PLAN_LEGACY}, ou cadence.yaml avec une clé plan:)`);
      continue;
    }
    const repo = gitRoot(projectDir);
    if (!repo) {
      refusals.push(`${key} : ${projectDir} n'est pas dans un dépôt git`);
      continue;
    }
    out.push({ project, projectDir, repo, lot: l.lot, model: l.model ?? 'sonnet' });
  }
  return out;
}

/** `--effort` date de claude 2.1.284 (L137). Une version illisible n'est pas refusée. */
function olderThanEffort(version: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a < 2 || (a === 2 && (b < 1 || (b === 1 && c < 284)));
}

/** L378 : claude installé mais non connecté échoue à la première session, après le démarrage du lot dans le plan. Null si connecté ou état illisible. */
export function notLoggedIn(deps: OrchestrateDeps): string | null {
  return deps.claudeAuth?.()?.loggedIn === false ? "claude n'est pas connecté : lancer `claude` puis /login (état : `claude auth status`)" : null;
}

/** Préconditions : tout ce qui peut être refusé l'est ici, avant d'agir, sans verrou ni écriture. */
export async function preflight(args: Pick<Args, 'dryRun' | 'goal'>, targets: Target[], io: OrchestrateIo, deps: OrchestrateDeps, launch: string, opts: { resume?: boolean; addTo?: { wave: string; lots: KnownLot[] } } = {}): Promise<{ refusals: string[]; lots: LotState[] }> {
  const refusals: string[] = [];
  if (io.env.CADENCE_ORCHESTRATED) refusals.push(`orchestrate ne se lance pas depuis une session orchestrée (vague ${io.env.CADENCE_ORCHESTRATED})`);
  const info = deps.claudeInfo();
  if (!info) refusals.push('claude introuvable (CADENCE_CLAUDE_BIN, ou claude dans le PATH)');
  else if (!info.jsonSchema) refusals.push(`claude ${info.version} n'a pas --json-schema : mettre claude à jour`);
  const login = info && !args.dryRun ? notLoggedIn(deps) : null; // la simulation n'ouvre pas de session : elle le signale (dryRun) sans refuser
  if (login) refusals.push(login);

  const lots: LotState[] = [];
  const repoChecked = new Set<string>();
  const byProject = new Map<string, string[]>();
  // L421 : les lots déjà portés par la vague qui reçoit l'ajout comptent comme « plus tôt dans la vague » pour les dépendances.
  for (const l of opts.addTo?.lots ?? []) byProject.set(l.project, [...(byProject.get(l.project) ?? []), l.lot]);
  for (const t of targets) {
    const key = lotKey(t.project, t.lot);
    // L563 : un lot rendu en fin de cycle (liste blanche, geste.ts) se reprend : il n'est pas « déjà dans la vague » (son arbre est contrôlé par `--add`, ajout.ts).
    const already = opts.addTo?.lots.find((l) => l.project === t.project && l.lot === t.lot && !addableHandBack(l));
    if (already) {
      refusals.push(`${key} : lot déjà ${already.queued ? "en file d'ajout dans" : 'dans'} la vague ${opts.addTo!.wave}${droppedAddSuffix(already, key, launch)}`);
      continue;
    }
    let env: ReturnType<typeof projectEnv>;
    let plan: Plan;
    try {
      env = projectEnv(t.repo);
      plan = env.loadPlan();
    } catch (e) {
      refusals.push(`${key} : ${(e as Error).message}`);
      continue;
    }
    if (info && olderThanEffort(info.version) && Object.entries(env.config.effort).some(([step, e]) => e !== 'default' && (step !== 'probe' || env.config.probe))) {
      refusals.push(`${key} : claude ${info.version} n'a pas --effort (2.1.284 requise) : mettre claude à jour, ou orchestrate.effort à « default » pour chaque passe`);
      continue;
    }
    const lot = plan.lots().find((l) => l.id === t.lot);
    if (!lot) {
      refusals.push(`${key} : lot inconnu`);
      continue;
    }
    const shut = !isOpen(lot.status) ? `le lot est ${lot.status}` : localLotRefusal(lot); // un lot local (L519) est au lead, jamais à une vague
    if (shut) {
      refusals.push(`${key} : ${shut}`);
      continue;
    }
    if (plan.readonly && lot.status === 'todo' && !env.config.start) {
      refusals.push(`${key} : plan en lecture seule : démarrer le lot avec l'outil du projet (ou déclarer orchestrate.start dans cadence.yaml)`);
      continue;
    }
    const earlier = byProject.get(t.project) ?? [];
    const open = lot.after.filter((d) => {
      const dep = plan.lots().find((x) => x.id === d);
      return dep && isOpen(dep.status) && !earlier.includes(d);
    });
    if (open.length) {
      refusals.push(`${key} : dépendance(s) ni terminée(s) ni plus tôt dans la vague : ${open.join(', ')}`);
      continue;
    }
    // Condition de tirage (L219) : seuls les lots done du plan la lèvent, jamais un lot de la même vague ; un lot déjà doing n'est pas refusé pour elle.
    const gate = lot.status === 'todo' ? gateProgress(plan.lots(), lot) : undefined;
    if (gate && !gate.met) {
      refusals.push(`${key} : condition de tirage non remplie : ${gate.n === 0 ? 'gate invalide (raf check)' : gateText(gate)}`);
      continue;
    }
    // Dépôts voisins du lot (L62) : chacun doit exister et être un dépôt git, sinon refus avant d'agir comme pour le dépôt du projet.
    const neighbours = resolveLotRepos(t.repo, lot);
    if (neighbours.problems.length) {
      refusals.push(...neighbours.problems.map((p) => `${key} : ${p}`));
      continue;
    }
    byProject.set(t.project, [...earlier, t.lot]);
    for (const repo of [t.repo, ...neighbours.repos.map((r) => r.path)]) {
      if (repoChecked.has(repo)) continue;
      repoChecked.add(repo);
      refusals.push(...(await repoRefusals(repo, t, { io, deps, launch }, opts)));
    }
    const node = resolveNode(t.repo, nvmVersionsDir(io.env));
    if (node.kind === 'missing') {
      refusals.push(`${key} : ${node.message}`);
      continue;
    }
    const small = lot.estimate <= 0.5 || lot.quickwin;
    const goal = args.goal ?? lot.goal;
    const { screen, skipped } = launchScreen(plan, t.repo, env.config, lot, goal), launched = launchedLot(lot, skipped);
    const state = newLot({ project: t.project, repo: t.repo, lot: t.lot, title: lot.title, ...(goal ? { goal } : {}), visible: lot.visible, small, ...(screen ? { screen } : {}), ...(launched.spec && !screen ? { specLot: true as const } : {}), model: t.model, readOnlyPlan: plan.readonly });
    if (neighbours.repos.length) state.repos = neighbours.repos;
    state.estimate = lot.estimate;
    if (isExpress({ estimate: lot.estimate, screen, planScreen: lot.screen, specLot: state.specLot })) state.express = true;
    state.light = lot.estimate <= env.config.review.threshold;
    const escalating = !!env.config.escalation;
    state.budget = lotBudget(lot.estimate, budgetStage(launched, screen, env.config.maquette, t.repo, env.config.spec.dir), escalating, measuredBudgetsAt(launch, io));
    if (escalating) state.escalationReserve = ESCALATION_RESERVE;
    state.dependsOn = lot.after.filter((d) => earlier.includes(d));
    if (node.kind === 'ok') state.node = { version: node.version, wanted: node.wanted, bin: node.bin, ...(node.skipped ? { skipped: node.skipped } : {}) };
    lots.push(state);
  }
  return { refusals, lots };
}

/** Version du `node` que le PATH donné résout (`node --version`), null s'il n'y en a pas ou s'il ne répond pas. */
export function pathNodeVersion(env: Record<string, string | undefined>): string | null {
  try {
    return execFileSync('node', ['--version'], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** La version (`v24.1.0`) commence-t-elle par ce que demande le .nvmrc (`24`, `v24`, `24.1`) ? */
export function matchesNvmrc(version: string, wanted: string): boolean {
  const v = version.replace(/^v/, '');
  const w = wanted.replace(/^v/, '');
  return v === w || v.startsWith(`${w}.`);
}

export const agentsOf = (deps: OrchestrateDeps): Record<string, AgentDef> => readAgents(deps.agentsDir);
