import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { nextUp } from '../audit.js';
import { planLoader, type OrchestrateConfig } from '../config.js';
import { gitRoot } from '../git.js';
import { findProjects, isProject } from '../lead.js';
import { RafError, type Lot } from '../plan.js';
import { lotBudget, projectEnv, type Args, type OrchestrateIo, type Target } from './command.js';
import { readyFree } from '../ready-free.js';
import { lotFinished, lotKey, type LotState, type RunStore } from './state.js';
import type { Budget } from './cycle.js';
import { budgetStage, stageScreen } from './spec.js';
import { STOP_REQUESTED } from './cycle.js';

/** `--until 18:00` : l'heure d'aujourd'hui (date de `now`) à partir de laquelle la vague ne tire plus de lot. */
export function parseUntil(text: string, now: Date): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new RafError(`--until invalide : ${text} (HH:MM, ex. 18:00)`);
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) throw new RafError(`--until ${text} : heure déjà passée aujourd'hui`);
  return at;
}

/** `--priority cadence,maritime` : noms de projets, du plus prioritaire au moins prioritaire. */
export function parsePriority(text: string): string[] {
  const names = text.split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new RafError(`--priority invalide : ${text} (noms de projets séparés par des virgules)`);
  return names;
}

/** Clé `priority:` du cadence.yaml du dossier de lancement (le dossier parent des projets) ; absente : aucune priorité déclarée. */
export function readPriority(launchDir: string): string[] {
  const file = join(launchDir, 'cadence.yaml');
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const p = (raw as { priority?: unknown } | null)?.priority;
  if (p == null) return [];
  if (!Array.isArray(p) || p.length === 0 || p.some((n) => typeof n !== 'string' || !n.trim())) throw new RafError(`${file} : priority doit être une liste de noms de projets`);
  return p.map((n: string) => n.trim());
}

/** Rang d'un projet dans la priorité : son nom, ou un nom suivi de « - » (`maritime` couvre `maritime-atlas`) ; les autres passent après tous les déclarés. */
export function priorityRank(project: string, priority: string[]): number {
  const i = priority.findIndex((n) => project === n || project.startsWith(`${n}-`));
  return i < 0 ? priority.length : i;
}

/** Un lot « à décider » (« à décider avec Sylvain », « (à décider) » ; titre ou note) attend une décision humaine : jamais tiré. */
export function decisionPending(lot: Pick<Lot, 'title' | 'notes'>): boolean {
  return /à décider/i.test([lot.title, ...lot.notes.map((n) => n.text)].join('\n'));
}

/** Un lot marqué « non tirable » (titre ou note) n'est jamais tiré par `--continue` (L390) ; il reste lançable à la main. */
export function nonDrawable(lot: Pick<Lot, 'title' | 'notes'>): boolean {
  return /non tirable/i.test([lot.title, ...lot.notes.map((n) => n.text)].join('\n'));
}

/** Pourquoi le réglage `orchestrate.continue` du projet (et le marqueur « non tirable ») écarte ce lot du tirage, ou null quand il reste tirable (L390). */
export function drawFilter(lot: Pick<Lot, 'id' | 'title' | 'notes' | 'estimate'>, setting: OrchestrateConfig['continue']): string | null {
  if (setting?.exclude?.includes(lot.id)) return 'listé dans continue.exclude';
  if (nonDrawable(lot)) return 'marqué « non tirable »';
  if (setting?.maxEstimate !== undefined && lot.estimate !== undefined && lot.estimate > setting.maxEstimate) return `estimate ${lot.estimate} > continue.maxEstimate ${setting.maxEstimate}`;
  return null;
}

export interface Candidate {
  project: string;
  dir: string;
  lot: Lot;
}

export interface DrawOpts {
  priority: string[];
  /** Clés `projet:lot` déjà dans la vague (jouées, rendues ou en cours). */
  exclude: Set<string>;
  /** Tokens comptés restant au budget : un lot dont le budget (estimate, plus l'étape spec d'un lot à écran) n'y tient pas n'est pas tiré. */
  remaining: number;
  /** Reçoit une ligne par lot prêt écarté par le réglage de tirage du projet (L390), pour que le dry-run le dise. */
  skipped?: string[];
}

/**
 * Les lots tirables sous `launch` : prêts (à faire, `after` levé, ni récurrents ni en cours), ni « à décider avec Sylvain », ni écartés par le réglage `orchestrate.continue` du projet ou marqués « non tirable » (L390), ni déjà
 * dans la vague, dont le budget tient dans `remaining` ; projets dans l'ordre de priorité (puis alphabétique), lots dans l'ordre du plan
 * (gains rapides d'abord). `launch` est un projet : lui seul ; sinon ses sous-dossiers qui en sont. Un plan illisible est sauté.
 */
export function candidates(launch: string, o: DrawOpts): Candidate[] {
  const dirs = isProject(launch) ? [launch] : findProjects(launch);
  const out: Candidate[] = [];
  const ranked = dirs.map((dir) => ({ dir, project: basename(dir) })).sort((a, b) => priorityRank(a.project, o.priority) - priorityRank(b.project, o.priority) || a.project.localeCompare(b.project));
  for (const { dir, project } of ranked) {
    let ready: Lot[];
    try {
      ready = nextUp(planLoader(gitRoot(dir) ?? dir)().lots()).ready;
    } catch {
      continue;
    }
    let specDir = 'docs/specs';
    let escalating = false;
    let maquette = true;
    let setting: OrchestrateConfig['continue'];
    try {
      const config = projectEnv(dir).config;
      specDir = config.spec.dir;
      escalating = !!config.escalation;
      maquette = config.maquette;
      setting = config.continue;
    } catch {
      // configuration illisible : le dossier par défaut
    }
    for (const lot of ready) {
      if (o.exclude.has(`${project}:${lot.id}`) || decisionPending(lot)) continue;
      const why = drawFilter(lot, setting);
      if (why) {
        o.skipped?.push(`${project}:${lot.id} écarté du tirage : ${why}`);
        continue;
      }
      if (lotBudget(lot.estimate, budgetStage(lot, stageScreen(dir, specDir, lot, maquette), maquette), escalating) > o.remaining) continue;
      out.push({ project, dir, lot });
    }
  }
  return out;
}

/**
 * Pour `--dry-run --continue` (L390) : une ligne par projet qui règle son tirage (`réglage de tirage — <projet> : maxEstimate 1, exclude L3`),
 * puis une par lot prêt que ce réglage écarte (hors lots déjà dans `exclude`, donnés à la main : ceux-là se jouent).
 */
export function drawSettingsReport(launch: string, exclude: Set<string>): string[] {
  const dirs = isProject(launch) ? [launch] : findProjects(launch);
  const lines: string[] = [];
  for (const dir of dirs) {
    try {
      const setting = projectEnv(dir).config.continue;
      const parts = [setting?.maxEstimate !== undefined ? `maxEstimate ${setting.maxEstimate}` : '', setting?.exclude?.length ? `exclude ${setting.exclude.join(' ')}` : ''].filter(Boolean);
      if (parts.length) lines.push(`réglage de tirage — ${basename(dir)} : ${parts.join(', ')}`);
    } catch {
      // configuration illisible : le projet est signalé par ailleurs
    }
  }
  const skipped: string[] = [];
  candidates(launch, { priority: [], exclude, remaining: Infinity, skipped });
  return [...lines, ...skipped.map((s) => `lot écarté — ${s}`)];
}

export interface StopFacts {
  now: Date;
  until?: Date;
  quotaHit: boolean;
  /** Lots de la vague qui attendent une réponse. */
  questions: number;
  /** Lots rendus ou en échec de suite, depuis le dernier lot prêt. */
  streak: number;
  /** Vague interrompue (incident, signal). */
  interrupted: boolean;
  /** `--stop-after-current` demandé (L79) : même quand tous les lots ont fini, rien ne doit être tiré. */
  stopRequested?: boolean;
  remaining: number;
}

/** Pourquoi la vague ne tire plus de lot, ou null quand elle peut continuer. */
export function stopReason(f: StopFacts): string | null {
  if (f.stopRequested) return STOP_REQUESTED;
  if (f.interrupted) return 'vague interrompue (incident ou signal)';
  if (f.quotaHit) return "limite d'usage atteinte";
  if (f.questions > 0) return `${f.questions} question(s) posée(s) à la vague`;
  if (f.streak >= 2) return 'deux lots rendus de suite';
  if (f.until && f.now.getTime() >= f.until.getTime()) return 'fenêtre horaire close (--until)';
  if (f.remaining <= 0) return 'budget épuisé';
  return null;
}

/** Lots rendus ou en échec de suite, en comptant depuis le dernier lot de la vague. */
export function handedBackStreak(all: LotState[]): number {
  let n = 0;
  for (const l of [...all].reverse()) {
    if (l.status === 'handed-back' || l.status === 'failed') n++;
    else break;
  }
  return n;
}

/** Les lots que le créneau libre peut recevoir, leurs ressources, et le budget qui leur reste une fois celui des lots qui jouent réservé. */
export interface FillPlan {
  targets: Array<Target & { uses: string[] }>;
  room: number;
}

export interface FillFacts {
  args: Pick<Args, 'priority' | 'untilAt'>;
  io: Pick<OrchestrateIo, 'now'>;
  launch: string;
  home: string;
  store: Pick<RunStore, 'control'>;
  /** Les lots de la vague, jouées ou non, reprise et ajouts compris. */
  all: LotState[];
  budget: Budget;
  quotaHit: boolean;
  incident: boolean;
}

/**
 * L527 : les lots que le créneau libre d'une vague `--continue` peut recevoir, dans l'ordre de priorité : ceux du plan que `candidates` tire (hors lots de la vague) et dont aucune ressource
 * n'est prise (`readyFree` : lots en cours, vagues vivantes dont celle-ci). Vide quand une borne de `stopReason` joue (arrêt demandé, limite d'usage, question, deux lots rendus de suite, `--until`, budget).
 * Le budget que les lots qui jouent encore n'ont pas dépensé reste réservé : le lot suivant doit tenir dans le reste (`room`, que `AddFeed.fill` décompte de chaque lot qu'il prend, comme les ressources `uses`).
 */
export function fillTargets(f: FillFacts): FillPlan {
  const reserved = f.all.filter((l) => !lotFinished(l)).reduce((n, l) => n + Math.max(0, (l.budget ?? 0) - l.steps.reduce((t, s) => t + (s.tokens?.counted ?? 0), 0)), 0);
  const remaining = f.budget.limit - f.budget.consumed - reserved;
  const why = stopReason({ now: f.io.now(), until: f.args.untilAt, quotaHit: f.quotaHit, questions: f.all.filter((l) => l.status === 'question').length, streak: handedBackStreak(f.all), interrupted: f.incident, stopRequested: f.store.control().stopAfterCurrent, remaining });
  if (why) return { targets: [], room: 0 };
  const dirs = isProject(f.launch) ? [f.launch] : findProjects(f.launch);
  const libres = readyFree(dirs, f.home);
  const exclude = new Set(f.all.map((l) => lotKey(l.project, l.lot)));
  const targets = candidates(f.launch, { priority: f.args.priority ?? readPriority(f.launch), exclude, remaining }).flatMap((c) => {
    const repo = gitRoot(c.dir);
    return repo && libres.get(c.dir)?.some((l) => l.id === c.lot.id) ? [{ project: c.project, projectDir: c.dir, repo, lot: c.lot.id, model: 'sonnet' as const, uses: c.lot.uses ?? [] }] : [];
  });
  return { targets, room: remaining };
}
