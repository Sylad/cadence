import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { audit, nextUp, planCommits } from './audit.js';
import { planLoader, readPlanConfig } from './config.js';
import { diffDays, type Day } from './dates.js';
import { gitRoot, repoStatus } from './git.js';
import { linkCommits } from './link.js';
import { lastActivity, lockStatus } from './session.js';
import { priorityRank, readPriority } from './orchestrate/continue.js';
import { readNext, sharedStateDir, stateDir } from './state.js';

export const NOTES_MAX = 120;
export const TITLE_MAX = 60;
/** Au-delà de ce nombre de jours sans activité, un lot en cours est dit silencieux. */
export const TOUR_IDLE = 3;
/** Un lot créé depuis moins de ce nombre de jours (aujourd'hui compris : 0 à 6 jours d'écart) compte parmi les « ajoutés cette semaine ». */
export const ADDED_DAYS = 7;

/** Avancement du plan (L149) : lots faits / en cours / à faire, abandonnés et récurrents exclus ; `added7` = créés sur les 7 derniers jours. */
export interface TourProgress {
  done: number;
  doing: number;
  todo: number;
  added7: number;
}

export interface TourRow {
  project: string;
  /** Renseigné quand le projet n'a pas pu être lu : les autres champs sont alors vides. */
  error?: string;
  doing: { id: string; silentDays?: number; /** ni `started`, ni commit, ni note : le lot le plus silencieux */ noActivity?: true }[];
  drift: string[];
  notes: string[];
  next: { id: string; title: string } | null;
  progress: TourProgress;
  /** « non commité », « non poussé », « livraison en cours » ; vide quand le dépôt est propre. */
  repo: string[];
}

const empty = (project: string): TourRow => ({ project, doing: [], drift: [], notes: [], next: null, progress: { done: 0, doing: 0, todo: 0, added7: 0 }, repo: [] });

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Un dossier est un projet s'il porte docs/plan/raf.yaml, ou un cadence.yaml avec `plan:`. */
export function isProject(dir: string): boolean {
  if (existsSync(join(dir, 'docs/plan/raf.yaml'))) return true;
  const conf = join(dir, 'cadence.yaml');
  if (!existsSync(conf) || !statSync(conf).isFile()) return false;
  try {
    const c = readPlanConfig(conf);
    // Une clé qa: seule ne désigne aucun plan.
    return !!c && (!!c.path || Object.keys(c.settings).some((k) => k !== 'qaExpectations'));
  } catch {
    return true; // un cadence.yaml illisible reste un projet : sa ligne dit l'erreur
  }
}

/** Les projets sous `parent`, jusqu'à `depth` niveaux (1 : sous-dossiers directs) ; on ne descend pas dans un projet. */
export function findProjects(parent: string, depth = 1): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return found; // dossier illisible : on le saute, les autres projets tournent
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = join(parent, e.name);
    if (isProject(dir)) found.push(dir);
    else if (depth > 1) found.push(...findProjects(dir, depth - 1));
  }
  return found.sort();
}

/** Les faits de `cadence session start` pour un projet, sous forme de données ; lecture seule. */
export function tourRow(dir: string, today: Day, idle = TOUR_IDLE): TourRow {
  const row = empty(basename(dir));
  try {
    const root = gitRoot(dir) ?? dir;
    const plan = planLoader(root)();
    const lots = plan.lots();
    const all = linkCommits(lots, planCommits(plan, root), plan.refs);
    const { doing, ready } = nextUp(lots);

    row.doing = doing.map((l) => {
      const last = lastActivity(l, all.byLot.get(l.id) ?? []);
      if (!last) return { id: l.id, noActivity: true as const };
      const days = diffDays(last, today);
      return days > idle ? { id: l.id, silentDays: days } : { id: l.id };
    });
    row.drift = audit(plan, root, join(root, 'docs/nouveautes'), today).map((i) => `${i.warning ? '⚠' : '✗'} ${i.message}`);
    row.notes = readNext(stateDir(root))?.lines ?? [];
    const counted = lots.filter((l) => l.status !== 'dropped' && l.every === undefined);
    row.progress = {
      done: counted.filter((l) => l.status === 'done').length,
      doing: counted.filter((l) => l.status === 'doing').length,
      todo: counted.filter((l) => l.status === 'todo').length,
      added7: counted.filter((l) => l.created !== undefined && diffDays(l.created, today) >= 0 && diffDays(l.created, today) < ADDED_DAYS).length,
    };
    row.next = ready[0] ? { id: ready[0].id, title: ready[0].title } : null;

    const s = repoStatus(root);
    if (s.dirty || s.untracked) row.repo.push('non commité');
    if (s.ahead) row.repo.push('non poussé');
    if (lockStatus(sharedStateDir(root))?.live) row.repo.push('livraison en cours');
  } catch (e) {
    return { ...empty(row.project), error: (e instanceof Error ? e.message : String(e)).split('\n')[0]! };
  }
  return row;
}

/**
 * Les projets rangés par la clé `priority:` du cadence.yaml du dossier (L149) ; les autres après, par ordre alphabétique.
 * Une priorité illisible ou invalide ne vide pas le tableau : l'ordre alphabétique reste, et une première ligne `cadence.yaml` en erreur le dit.
 * Un dossier qui n'a aucun sous-projet mais est lui-même un projet donne la ligne de ce projet seul (la bande l'interroge depuis le dossier de la session).
 */
export function leadTour(parent: string, today: Day, idle = TOUR_IDLE): TourRow[] {
  const dirs = findProjects(parent);
  if (dirs.length === 0 && isProject(parent)) return [tourRow(parent, today, idle)];
  const rows = dirs.map((dir) => tourRow(dir, today, idle));
  let priority: string[] = [];
  let problem: TourRow | undefined;
  try {
    priority = readPriority(parent);
  } catch (e) {
    problem = { ...empty('cadence.yaml'), error: (e instanceof Error ? e.message : String(e)).split('\n')[0]! };
  }
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => priorityRank(a.r.project, priority) - priorityRank(b.r.project, priority) || a.i - b.i).map((x) => x.r);
  return problem ? [problem, ...sorted] : sorted;
}

const DRIFT_SHOWN = 2;

/** Une ligne par projet : projet · en cours · dérive · notes · prochain lot prêt · dépôt. */
export function tourLine(r: TourRow): string {
  if (r.error) return `${r.project} · ✗ erreur : ${r.error}`;
  const doing = r.doing.length ? r.doing.map((d) => (d.noActivity ? `${d.id} (aucune activité)` : d.silentDays === undefined ? d.id : `${d.id} (silencieux ${d.silentDays}j)`)).join(', ') : 'rien';
  const drift = r.drift.length
    ? `${r.drift.length} (${r.drift.slice(0, DRIFT_SHOWN).join(' ; ')}${r.drift.length > DRIFT_SHOWN ? ' ; …' : ''})`
    : 'aucune';
  const notes = r.notes.length ? truncate(r.notes.join(' / '), NOTES_MAX) : 'aucune';
  const next = r.next ? `${r.next.id} ${truncate(r.next.title, TITLE_MAX)}` : 'aucun';
  return [r.project, `en cours ${doing}`, `dérive ${drift}`, `notes : ${notes}`, `prochain ${next}`, `dépôt ${r.repo.length ? r.repo.join(', ') : 'propre'}`].join(' · ');
}
