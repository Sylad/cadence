import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { audit, nextUp, planCommits } from './audit.js';
import { readPlanConfig } from './config.js';
import { diffDays, type Day } from './dates.js';
import { gitRoot, repoStatus } from './git.js';
import { linkCommits } from './link.js';
import { Plan } from './plan.js';
import { lastActivity, lockStatus } from './session.js';
import { readNext, sharedStateDir, stateDir } from './state.js';

export const NOTES_MAX = 120;
export const TITLE_MAX = 60;
/** Au-delà de ce nombre de jours sans activité, un lot en cours est dit silencieux. */
export const TOUR_IDLE = 3;

export interface TourRow {
  project: string;
  /** Renseigné quand le projet n'a pas pu être lu : les autres champs sont alors vides. */
  error?: string;
  doing: { id: string; silentDays?: number }[];
  drift: string[];
  notes: string[];
  next: { id: string; title: string } | null;
  /** « non commité », « non poussé », « livraison en cours » ; vide quand le dépôt est propre. */
  repo: string[];
}

const empty = (project: string): TourRow => ({ project, doing: [], drift: [], notes: [], next: null, repo: [] });

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Sous-dossiers directs qui portent un plan : docs/plan/raf.yaml, ou un cadence.yaml avec `plan:`. */
export function findProjects(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(parent, e.name))
    .filter((dir) => {
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
    })
    .sort();
}

/** Les faits de `cadence session start` pour un projet, sous forme de données ; lecture seule. */
export function tourRow(dir: string, today: Day, idle = TOUR_IDLE): TourRow {
  const row = empty(basename(dir));
  try {
    const root = gitRoot(dir) ?? dir;
    const configPath = join(root, 'cadence.yaml');
    const planConfig = readPlanConfig(configPath, root);
    const planPath = resolve(root, planConfig?.path ?? 'docs/plan/raf.yaml');
    const plan = Plan.load(planPath, { ...planConfig?.settings, config: configPath });
    const lots = plan.lots();
    const all = linkCommits(lots, planCommits(plan, root), plan.refs);
    const { doing, ready } = nextUp(lots);

    row.doing = doing.map((l) => {
      const last = lastActivity(l, all.byLot.get(l.id) ?? []);
      const days = last ? diffDays(last, today) : 0;
      return days > idle ? { id: l.id, silentDays: days } : { id: l.id };
    });
    row.drift = audit(plan, root, join(root, 'docs/nouveautes'), today).map((i) => `${i.warning ? '⚠' : '✗'} ${i.message}`);
    row.notes = readNext(stateDir(root))?.lines ?? [];
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

export function leadTour(parent: string, today: Day, idle = TOUR_IDLE): TourRow[] {
  return findProjects(parent).map((dir) => tourRow(dir, today, idle));
}

const DRIFT_SHOWN = 2;

/** Une ligne par projet : projet · en cours · dérive · notes · prochain lot prêt · dépôt. */
export function tourLine(r: TourRow): string {
  if (r.error) return `${r.project} · ✗ erreur : ${r.error}`;
  const doing = r.doing.length ? r.doing.map((d) => (d.silentDays === undefined ? d.id : `${d.id} (silencieux ${d.silentDays}j)`)).join(', ') : 'rien';
  const drift = r.drift.length
    ? `${r.drift.length} (${r.drift.slice(0, DRIFT_SHOWN).join(' ; ')}${r.drift.length > DRIFT_SHOWN ? ' ; …' : ''})`
    : 'aucune';
  const notes = r.notes.length ? truncate(r.notes.join(' / '), NOTES_MAX) : 'aucune';
  const next = r.next ? `${r.next.id} ${truncate(r.next.title, TITLE_MAX)}` : 'aucun';
  return [r.project, `en cours ${doing}`, `dérive ${drift}`, `notes : ${notes}`, `prochain ${next}`, `dépôt ${r.repo.length ? r.repo.join(', ') : 'propre'}`].join(' · ');
}
