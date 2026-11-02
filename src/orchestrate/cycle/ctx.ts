import { coveredTasks, lotWork } from '../../audit.js';
import { type OrchestrateConfig } from '../../config.js';
import { Day } from '../../dates.js';
import { type Plan } from '../../plan.js';
import { isPlanOnly } from '../../audit.js';
import { type AppState } from '../app.js';
import { type Templates } from '../briefs.js';
import { journalTokens, peakContext, type AgentDef, type ClaudeFn, type SessionKind } from '../launch.js';
import { type Tokens } from '../result.js';
import { lotStartHead } from '../accept.js';
import { lotKey, type LotState, type RunStore, type StepState } from '../state.js';
import { INTEGRATE_WAIT_MS } from '../integrate.js';
import { planSeenFrom } from '../worktree.js';

/** Passes de correction au plus, puis la main est rendue au lead. */
export const MAX_PASSES = 2;
/** Plafond quand la revue converge (L205) : le nombre de bloquants+majeurs a baissé d'une revue à l'autre et il n'en reste qu'un. */
export const MAX_PASSES_CONVERGING = MAX_PASSES + 1;

export class Budget {
  consumed = 0;
  cacheRead = 0;
  constructor(public limit: number) {}
  add(t: Tokens): void {
    this.consumed += t.counted;
    this.cacheRead += t.cacheRead;
  }
  get exhausted(): boolean {
    return this.consumed >= this.limit;
  }
}

/**
 * Compte au budget les tokens d'une étape tuée (signal) ou retrouvée morte (reprise), relus dans le journal de sa
 * session (`--session-id`). Une étape déjà comptée (`tokens`) ne l'est jamais deux fois. Vrai quand quelque chose a été compté.
 */
export function countInterrupted(claudeHome: string | undefined, repo: string, step: StepState, budget: Budget): boolean {
  if (!claudeHome || !step.sessionId || step.tokens || step.model === 'local') return false; // le modèle local n'a rien pris au quota
  const spent = journalTokens(claudeHome, repo, step.sessionId);
  if (!spent) return false;
  step.tokens = spent.tokens;
  step.peakContext = peakContext(claudeHome, repo, step.sessionId);
  budget.add(spent.tokens);
  return true;
}

export interface WaveCtx {
  id: string;
  store: RunStore;
  budget: Budget;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  today: Day;
  /** ~/.claude : pour relire le pic de contexte des sessions. */
  claudeHome?: string;
  /** Gabarits des briefs, lus une fois au début de la vague (et à sa reprise) : modifier un fichier en cours de vague ne change rien. */
  templates: Templates;
  quota: { hit: boolean; message?: string };
  /** Part de la machine de chaque session (L350) : posée en CADENCE_TEST_WORKERS dans les sessions et la porte, et dite aux gabarits. Absent (vague construite à la main) : rien n'est posé. */
  testWorkers?: number;
  /** Push ou revue qui a modifié le dépôt : la vague s'arrête. */
  incident: string | null;
  /** Dépôts salis par une revue (L133) → lot en cause : les lots qui restent dans leur file sont suspendus, ceux des autres dépôts continuent. */
  dirtyRepos?: Map<string, string>;
  /** Parmi `dirtyRepos`, ceux laissés en HEAD déplacé par une session d'écriture (L214) : même file retenue, autre message. */
  movedRepos?: Set<string>;
  /** Pourquoi le modèle local est écarté pour la suite de la vague (L322) : posé au premier échec d'une session locale, il envoie les lots suivants droit à Sonnet. */
  localOut?: string;
  log: (line: string) => void;
  saveWave: () => void;
  /** Attente du verrou d'intégration du dépôt (L279, R25) : bornes par défaut INTEGRATE_WAIT_MS et INTEGRATE_POLL_MS ; réglables pour les tests. */
  integrate?: { waitMs?: number; pollMs?: number };
}

/** Le worktree prévu pour un lot (L279) : créé à la prise du créneau (`active` une fois prêt), retrouvé à la reprise. */
export interface LotTree {
  dir: string;
  branch: string;
  /** Branche du dépôt sur laquelle le lot est parti et à laquelle il s'intègre (R24). */
  base: string;
  active: boolean;
}

export interface LotCtx {
  wave: WaveCtx;
  lot: LotState;
  config: OrchestrateConfig;
  loadPlan: () => Plan;
  /** Issue du lancement de l'application par le programme, le temps de l'étape qui la voit (L60). */
  app?: AppState;
  /** Worktree du lot (L279) ; absent : le lot joue dans le dépôt lui-même. */
  tree?: LotTree;
  /** Posé le temps de la revue courte du diff rebasé (R17) : le brief le dit à la session. */
  integration?: { base: string };
}

/**
 * Où le lot travaille (L279) : son worktree quand il en a un, sinon le dépôt du projet. Tout ce que le cycle lit ou écrit du travail du lot — sessions,
 * commits, contrôles, fiche, acceptation — passe par là ; le plan, lui, n'est jamais lu ni écrit ici que dans le dépôt du projet (`c.lot.repo`, R21).
 */
export const workDir = (c: LotCtx): string => (c.tree?.active ? c.tree.dir : c.lot.repo);
const wd = workDir;

/** Le plan tel que les lectures d'historique (lotWork, isPlanOnly, coveredTasks, unreviewedWork) le voient depuis `wd(c)` : son chemin est celui du fichier correspondant dans le worktree (R21). */
export const histPlan = (c: LotCtx): Plan => (wd(c) === c.lot.repo ? c.loadPlan() : planSeenFrom(c.loadPlan(), c.lot.repo, wd(c)));

export const short = (c: { sha: string; subject: string }) => `${c.sha.slice(0, 7)} ${c.subject}`;

export function save(c: LotCtx): void {
  c.wave.store.writeLot(c.lot);
}

export function transition(c: LotCtx, status: LotState['status'], outcome?: string): void {
  c.lot.status = status;
  if (outcome !== undefined) c.lot.outcome = outcome;
  save(c);
  c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} → ${status}${outcome ? ` — ${outcome}` : ''}`);
}

/** Une session jouée au modèle d'escalade (L337) : la correction escaladée et la revue neuve qui la suit. L'UX, la fiche, le précheck… gardent leur modèle. */
export const escalatedSession = (c: LotCtx, kind: SessionKind): boolean =>
  c.lot.escalation?.stage === 'fix' && (kind === 'fix' || kind === 'review' || kind === 'review-small');

/**
 * Rend ou échoue le lot. `noResult` : la session escaladée n'a rien rendu (sortie vide, erreur de lancement, coupure, délai) — seul cas où l'escalade est dite
 * « en échec » (L338) : le modèle n'a pas jugé le lot. Un retrait (--drop) ou un incident du dépôt pendant l'escalade laisse l'escalade sans issue : ce n'est pas
 * un échec du modèle et `cadence perf` ne le compte pas contre lui.
 */
export const stop = (c: LotCtx, status: 'handed-back' | 'failed', outcome: string, noResult = false): null => {
  c.lot.next = null;
  const e = c.lot.escalation;
  if (e && !e.issue && noResult) {
    // Une session escaladée a échoué ou été coupée (L337) : le modèle n'a pas jugé le lot. `toFix` pose `rendu` avant de rendre un lot sur un verdict.
    e.stage = 'done';
    e.issue = 'échec';
    c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · escalade ${e.model} : session sans résultat, le lot n'a pas été jugé par ce modèle`);
  }
  transition(c, status, outcome);
  return null;
};
/**
 * Sha d'où le lot est parti : le parent de son plus ancien commit de travail (un lot relancé, ou déjà en partie commité, a ses propres
 * commits avant la vague), à défaut le HEAD d'avant la première session de la vague.
 */
export const startSha = (c: LotCtx): string | undefined => lotStartHead(wd(c), lotWork(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha)) ?? c.lot.steps.find((s) => s.headBefore)?.headBefore;

/** Le lot passe par l'étape spec : il déclare `screen:` (écran) ou `spec: true` (comportement sans écran, L188). */
export const hasSpecStage = (l: LotState): boolean => !!(l.screen || l.specLot);

export function propose(c: LotCtx, text: string, head?: string): void {
  if (!c.lot.proposals.includes(text)) c.lot.proposals.push(text);
  if (head) (c.lot.proposalHeads ??= {})[text] ??= head;
}
