import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { nextUp } from '../audit.js';
import { planLoader } from '../config.js';
import { gitRoot } from '../git.js';
import { findProjects, isProject } from '../lead.js';
import { RafError, type Lot } from '../plan.js';
import { lotBudget } from './command.js';
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

export interface Candidate {
  project: string;
  dir: string;
  lot: Lot;
}

export interface DrawOpts {
  priority: string[];
  /** Clés `projet:lot` déjà dans la vague (jouées, rendues ou en cours). */
  exclude: Set<string>;
  /** Tokens comptés restant au budget : un lot dont le budget dérivé de l'estimate n'y tient pas n'est pas tiré. */
  remaining: number;
}

/**
 * Les lots tirables sous `launch` : prêts (à faire, `after` levé, ni récurrents ni en cours), ni « à décider avec Sylvain » ni déjà
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
    for (const lot of ready) {
      if (o.exclude.has(`${project}:${lot.id}`) || decisionPending(lot) || lotBudget(lot.estimate) > o.remaining) continue;
      out.push({ project, dir, lot });
    }
  }
  return out;
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
