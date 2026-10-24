import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, type OrchestrateConfig } from '../src/config.js';
import { loadTemplates, TEMPLATES_DIR } from '../src/orchestrate/briefs.js';
import { Budget, type LotCtx, type WaveCtx } from '../src/orchestrate/cycle.js';
import type { AgentDef, ClaudeFn, LaunchOpts } from '../src/orchestrate/launch.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { gitRepo, tempDir } from './helpers.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/claude-result.sample.json', import.meta.url), 'utf8'));

export const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Sortie `claude -p --output-format json` au format de l'échantillon réel, avec la sortie structurée voulue. */
export function claudeOut(structured: unknown, tokens: { input?: number; cacheWrite?: number; cacheRead?: number; output?: number } = {}, extra: Record<string, unknown> = {}) {
  const raw = {
    ...sample,
    session_id: `sess-${Math.random().toString(36).slice(2, 10)}`,
    structured_output: structured,
    result: JSON.stringify(structured),
    usage: { ...sample.usage, input_tokens: tokens.input ?? 100, cache_creation_input_tokens: tokens.cacheWrite ?? 1000, cache_read_input_tokens: tokens.cacheRead ?? 50_000, output_tokens: tokens.output ?? 400 },
    ...extra,
  };
  return { code: 0, stdout: JSON.stringify(raw), stderr: '', timedOut: false };
}

export const workReport = (over: Record<string, unknown> = {}) => ({
  commits: [],
  tests: { commande: 'npm test', resultat: '12 passed', vert: true },
  build: { commande: 'npm run build', resultat: 'ok', vert: true },
  nonVerifie: [],
  questions: [],
  resume: 'fait',
  ...over,
});

export const reviewReport = (over: Record<string, unknown> = {}) => ({
  bloquants: 0,
  majeurs: 0,
  mineurs: 0,
  constats: [],
  sousTaches: [],
  nonVerifie: [],
  verdict: 'conforme : rien à signaler',
  ...over,
});

export interface Call {
  args: string[];
  opts: LaunchOpts;
  kind: 'implement' | 'fix' | 'review' | 'ux' | 'review-small' | 'precheck' | 'spec' | 'accept' | 'maquette' | 'fiche';
  model: string;
  effort?: string;
  brief: string;
  local: boolean;
}

/** Rapport d'une étape spec : `sousSeuil` vide = un écran est spécifié ; `fiche` = chemin de la fiche écrite. */
export const specReport = (over: Record<string, unknown> = {}) => ({ commits: [], nonVerifie: [], questions: [], choix: [], sousSeuil: '', fiche: '', resume: 'spec écrite', ...over });

/** Rapport d'une étape accept. */
export const acceptReport = (over: Record<string, unknown> = {}) => ({ commits: [], nonVerifie: [], questions: [], choix: [], resume: 'tests rouges écrits', ...over });

export const precheckReport = (over: Record<string, unknown> = {}) => ({ dejaPresent: 'non', preuves: [], resume: 'rien de présent', ...over });

/** Le brief : après `-p` pour `claude`, premier argument pour `claude-local` (L146). */
export const briefOf = (args: string[]): string => (args[0] === '-p' ? args[1] : args[0]);

export function kindOf(args: string[]): Call['kind'] {
  const brief = briefOf(args);
  if (brief.includes('Pre-check for lot')) return 'precheck';
  const agent = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
  if (agent === 'ux-reviewer') return brief.includes('UX review of the mockup') ? 'maquette' : 'ux';
  if (agent === 'spec-writer') return 'spec';
  if (agent === 'acceptance-writer') return 'accept';
  if (agent === 'code-reviewer' && brief.includes('Sheet review of lot')) return 'fiche';
  if (agent === 'code-reviewer') return brief.includes('single pass') || brief.includes('short re-review') ? 'review-small' : 'review';
  return brief.includes('found the defects below') || brief.includes('found only minor findings') ? 'fix' : 'implement';
}

export type Handler = (call: Call) => ReturnType<ClaudeFn> | { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Fait un commit dans le dépôt de la session, comme le ferait un agent. */
export function commitFile(cwd: string, file: string, message: string): { sha: string; sujet: string } {
  writeFileSync(join(cwd, file), `${Math.random()}\n`);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '-m', message, '--', file);
  return { sha: git(cwd, 'rev-parse', 'HEAD'), sujet: message };
}

export interface Harness {
  repo: string;
  launch: string;
  store: RunStore;
  wave: WaveCtx;
  calls: Call[];
  lot(id: string, over?: Partial<LotState>, config?: Partial<OrchestrateConfig>): LotCtx;
  plan(): Plan;
}

/**
 * Dépôt jetable avec un plan, lots donnés ; le lanceur est un scénario : `script[kind]` est la file des
 * réponses de chaque type d'étape. Rien ne lance le vrai claude.
 */
export function harness(opts: { lots?: { title: string; visible?: boolean; screen?: 'page' | 'component' | 'journey'; spec?: boolean; estimate?: number; quickwin?: boolean; status?: 'todo' | 'doing' }[]; script?: Partial<Record<Call['kind'], Handler[]>>; budget?: number; templatesDir?: string; planRel?: string } = {}): Harness {
  const repo = gitRepo();
  const planRel = opts.planRel ?? 'docs/plan/raf.yaml';
  const planFile = join(repo, planRel);
  const plan = Plan.create(planFile, 'demo', 'L', '2026-09-01');
  for (const l of opts.lots ?? [{ title: 'Un lot, suite du constat de revue' }]) {
    const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, visible: l.visible || !!l.screen, screen: l.screen, spec: l.spec, quickwin: l.quickwin });
    if (l.status === 'doing') plan.setStatus(id, 'doing', '2026-10-01');
  }
  plan.save();
  git(repo, 'add', '--', planRel);
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  const launch = tempDir();
  const store = new RunStore(launch, 'w1');
  const calls: Call[] = [];
  const script = opts.script ?? {};
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    const call: Call = { args, opts: o, kind, model: args[args.indexOf('--model') + 1], effort: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined, brief: briefOf(args), local: !!o.local };
    calls.push(call);
    const next = script[kind]?.shift();
    if (!next) throw new Error(`pas de réponse scénarisée pour ${kind}`);
    return next(call);
  };
  const agents: Record<string, AgentDef> = { 'code-reviewer': { description: 'd', prompt: 'p', tools: ['Read', 'StructuredOutput'] }, 'ux-reviewer': { description: 'd', prompt: 'p' }, 'precheck-reader': { description: 'd', prompt: 'p', tools: ['Read', 'Grep', 'Glob', 'Bash', 'StructuredOutput'] }, 'spec-writer': { description: 'd', prompt: 'p', tools: ['Read', 'Write', 'Edit', 'Bash', 'StructuredOutput'] }, 'acceptance-writer': { description: 'd', prompt: 'p', tools: ['Read', 'Write', 'Edit', 'Bash', 'StructuredOutput'] } };
  const wave: WaveCtx = {
    id: 'w1',
    store,
    budget: new Budget(opts.budget ?? 2_000_000),
    claude,
    agents,
    templates: loadTemplates(opts.templatesDir ?? TEMPLATES_DIR),
    today: '2026-10-04',
    quota: { hit: false },
    incident: null,
    log: () => {},
    saveWave: () => {},
  };
  const h: Harness = {
    repo,
    launch,
    store,
    wave,
    calls,
    plan: () => Plan.load(planFile),
    lot(id, over = {}, config = {}) {
      const state = newLot({ project: 'demo', repo, lot: id, title: h.plan().lot(id).title, visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
      Object.assign(state, over);
      return { wave, lot: state, config: { ...readOrchestrateConfig('/nope'), precheck: false, maquette: false, ...config }, loadPlan: () => Plan.load(planFile) };
    },
  };
  return h;
}
