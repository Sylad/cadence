import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { audit, gateWaiting, nextUp, planCommits, workByLot } from './audit.js';
import { PLAN_DEFAULT, PLAN_LEGACY, planLoader, readPlanConfig } from './config.js';
import { diffDays, type Day } from './dates.js';
import { gitRoot, repoStatus } from './git.js';
import { linkCommits } from './link.js';
import { commitCount, lastActivity, lockStatus } from './session.js';
import { parse } from 'yaml';
import { isOpen, RafError, type Lot } from './plan.js';
import { isRecurring } from './recurring.js';
import { priorityRank, readPriority } from './orchestrate/continue.js';
import { readNext, sharedStateDir, stateDir } from './state.js';
import { freeLine, readyFree, type FreeLot } from './ready-free.js';
import { cadenceHome } from './orchestrate/registry.js';
import { staleNotes, staleText } from './stale-notes.js';
import { noTestGate, noTestText, type NoTestGate } from './orchestrate/no-test.js';
import { KEPT_TITLE, keptLine, keptTrees, type KeptTree } from './orchestrate/worktree.js';

/** Clé `lead.ux` du cadence.yaml du dossier parent (L197) : qui pose le verdict UX (`raf ux`) d'un lot visible. `human` (défaut) : l'humain ; `lead` : le lead, l'humain n'étant consulté qu'en cas de doute. */
export function readLeadUx(parent: string): 'lead' | 'human' {
  const file = join(parent, 'cadence.yaml');
  if (!existsSync(file)) return 'human';
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const l = (raw as { lead?: unknown } | null)?.lead;
  if (l == null) return 'human';
  const ux = (l as { ux?: unknown }).ux;
  if (typeof l !== 'object' || Array.isArray(l)) throw new RafError(`${file} : lead.ux doit être « lead » ou « human »`);
  if (ux == null) return 'human';
  if (ux !== 'lead' && ux !== 'human') throw new RafError(`${file} : lead.ux doit être « lead » ou « human »`);
  return ux;
}

/** Clé `depth:` du cadence.yaml du dossier parent (L201, issue #8), à côté de `priority:` : combien de niveaux `lead tour` parcourt (1 : sous-dossiers directs, le défaut). */
export function readDepth(parent: string): number {
  const file = join(parent, 'cadence.yaml');
  if (!existsSync(file)) return 1;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const d = (raw as { depth?: unknown } | null)?.depth;
  if (d == null) return 1;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1) throw new RafError(`${file} : depth doit être un entier ≥ 1`);
  return d;
}

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

/** Un lot non clos du tableau (L401) ou, dans un plan natif, une sous-tâche non close (`<lot>/<n>`, `parent` = le lot, jamais d'`after`). */
export interface TourLot {
  id: string;
  title: string;
  status: 'todo' | 'doing';
  /** Ids tels que le plan les écrit, clos ou inconnus compris : c'est au lecteur de dire s'ils sont satisfaits. */
  after: string[];
  /** Lot parent : `Lot.parent` d'un plan tenu par un autre outil, le lot lui-même pour une sous-tâche. */
  parent?: string;
  /** La revue de code du lot est posée au plan (`raf review`, L413) : l'étape « revue posée » de la frise du panneau ; absent sans revue et d'une sous-tâche. */
  reviewed?: true;
}

export interface TourRow {
  project: string;
  /** Renseigné quand le projet n'a pas pu être lu : les autres champs sont alors vides. */
  error?: string;
  doing: { id: string; /** commits liés au lot, comme raf now (0 compris) */ commits: number; silentDays?: number; /** ni `started`, ni commit, ni note : le lot le plus silencieux */ noActivity?: true }[];
  drift: string[];
  notes: string[];
  /** Lots déjà finis que les notes de clôture citent (« L217 done le 24-10 », L347) ; absent quand aucune note n'est périmée. */
  staleNotes?: string[];
  next: { id: string; title: string } | null;
  /** Lots en attente d'une condition de tirage (L219) ; absent quand aucun lot n'en porte. */
  waiting?: string[];
  /** Lots prêts dont aucune ressource (`uses:`) n'est prise par un lot en cours ni par une vague (L252) ; absent quand aucun n'est libre. */
  free?: FreeLot[];
  progress: TourProgress;
  /** Lots non clos hors récurrents, sous-tâches ouvertes de ces lots comprises (L401) ; absent d'une ligne en erreur. */
  lots?: TourLot[];
  /** Lots clos (`done`, hors lots à échéance `every`) avec leur jour de clôture (L415) : le panneau des lots en tire les lots clos non livrés ; absent sans lot clos daté. */
  closed?: { id: string; finished: Day }[];
  /** « non commité », « non poussé », « livraison en cours » ; vide quand le dépôt est propre. */
  repo: string[];
  /** Worktrees de lot conservés par une vague (L279, R19) ; absent quand il n'y en a aucun. */
  worktrees?: KeptTree[];
  /** Le projet ne déclare pas `orchestrate.test` (L327) : la vague ne lancera pas la suite ; absent quand il le déclare. */
  noTest?: NoTestGate;
}

const empty = (project: string): TourRow => ({ project, doing: [], drift: [], notes: [], next: null, progress: { done: 0, doing: 0, todo: 0, added7: 0 }, repo: [] });

/** Les lots non clos du plan, hors récurrents, chacun suivi de ses sous-tâches non closes ; celles d'un lot clos ou récurrent sortent avec lui. */
export function openLots(lots: Lot[]): TourLot[] {
  return lots
    .filter((l) => isOpen(l.status) && !isRecurring(l))
    .flatMap((l): TourLot[] => [
      { id: l.id, title: l.title, status: l.status as 'todo' | 'doing', after: l.after, ...(l.parent ? { parent: l.parent } : {}), ...(l.review ? { reviewed: true as const } : {}) },
      ...l.tasks.filter((t) => isOpen(t.status)).map((t): TourLot => ({ id: `${l.id}/${t.id}`, title: t.title, status: t.status as 'todo' | 'doing', after: [], parent: l.id })),
    ]);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Un dossier est un projet s'il porte .cadence/raf.yaml ou docs/plan/raf.yaml, ou un cadence.yaml avec `plan:`. */
export function isProject(dir: string): boolean {
  if (existsSync(join(dir, PLAN_DEFAULT)) || existsSync(join(dir, PLAN_LEGACY))) return true;
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

/** Les projets sous `parent`, jusqu'à `depth` niveaux (1 : sous-dossiers directs) ; on ne descend pas dans un projet, ni dans `tmp/` (copies de travail jetables, L241). */
export function findProjects(parent: string, depth = 1): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return found; // dossier illisible : on le saute, les autres projets tournent
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'tmp') continue;
    const dir = join(parent, e.name);
    if (isProject(dir)) found.push(dir);
    else if (depth > 1) found.push(...findProjects(dir, depth - 1));
  }
  return found.sort();
}

/** Les faits de `cadence session start` pour un projet, sous forme de données ; lecture seule. */
export function tourRow(dir: string, today: Day, idle = TOUR_IDLE, name = basename(dir)): TourRow {
  const row = empty(name);
  try {
    const root = gitRoot(dir) ?? dir;
    const plan = planLoader(root)();
    const lots = plan.lots();
    const all = linkCommits(lots, planCommits(plan, root), plan.refs);
    const { doing, ready, blocked } = nextUp(lots);
    const work = workByLot(plan, root, all, doing.map((l) => l.id));

    row.doing = doing.map((l) => {
      const count = work.get(l.id)?.length ?? 0;
      const last = lastActivity(l, all.byLot.get(l.id) ?? []);
      if (!last) return { id: l.id, commits: count, noActivity: true as const };
      const days = diffDays(last, today);
      return days > idle ? { id: l.id, commits: count, silentDays: days } : { id: l.id, commits: count };
    });
    row.drift = audit(plan, root, join(root, 'docs/nouveautes'), today).map((i) => `${i.warning ? '⚠' : '✗'} ${i.message}`);
    row.notes = readNext(stateDir(root))?.lines ?? [];
    const stale = [...new Set(staleNotes(row.notes, lots).flatMap((n) => n.stale))];
    if (stale.length) row.staleNotes = stale;
    const counted = lots.filter((l) => l.status !== 'dropped' && l.every === undefined);
    row.progress = {
      done: counted.filter((l) => l.status === 'done').length,
      doing: counted.filter((l) => l.status === 'doing').length,
      todo: counted.filter((l) => l.status === 'todo').length,
      added7: counted.filter((l) => l.created !== undefined && diffDays(l.created, today) >= 0 && diffDays(l.created, today) < ADDED_DAYS).length,
    };
    row.lots = openLots(lots);
    const closed = lots.filter((l) => l.status === 'done' && l.every === undefined && l.finished !== undefined).map((l) => ({ id: l.id, finished: l.finished! }));
    if (closed.length) row.closed = closed;
    const waiting = gateWaiting(lots, blocked).map((g) => g.lot.id);
    if (waiting.length) row.waiting = waiting;
    row.next = ready[0] ? { id: ready[0].id, title: ready[0].title } : null;

    const s = repoStatus(root);
    if (s.dirty || s.untracked) row.repo.push('non commité');
    if (s.ahead) row.repo.push('non poussé');
    if (lockStatus(sharedStateDir(root))?.live) row.repo.push('livraison en cours');
    const kept = keptTrees(root);
    if (kept.length) row.worktrees = kept;
    const noTest = noTestGate(root);
    if (noTest) row.noTest = noTest;
  } catch (e) {
    return { ...empty(row.project), error: (e instanceof Error ? e.message : String(e)).split('\n')[0]! };
  }
  return row;
}

/**
 * Les projets rangés par la clé `priority:` du cadence.yaml du dossier (L149) ; les autres après, par ordre alphabétique.
 * Une clé `depth:` invalide se signale de même. Une priorité illisible ou invalide ne vide pas le tableau : l'ordre alphabétique reste, et une première ligne `cadence.yaml` en erreur le dit.
 * Un dossier qui n'a aucun sous-projet mais est lui-même un projet donne la ligne de ce projet seul (la bande l'interroge depuis le dossier de la session).
 */
export function leadTour(parent: string, today: Day, idle = TOUR_IDLE, depth?: number): TourRow[] {
  const problems: TourRow[] = [];
  const attempt = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      if (!problems.some((p) => p.error === error)) problems.push({ ...empty('cadence.yaml'), error }); // un yaml illisible l'est pour les deux clés : une seule ligne
      return fallback;
    }
  };
  // --depth l'emporte sur la clé `depth:` ; une clé invalide se signale et laisse un seul niveau
  const levels = depth ?? attempt(() => readDepth(parent), 1);
  const dirs = findProjects(parent, levels);
  if (dirs.length === 0 && isProject(parent)) return [...problems, ...withFree([{ dir: parent, row: tourRow(parent, today, idle) }])];
  // un projet imbriqué est nommé par son chemin depuis le dossier : unique, et adressable par `orchestrate <projet>:<lot>` lancé d'ici ; la priorité et l'ordre alphabétique lisent le nom du dossier, comme orchestrate --continue
  const rows = dirs.map((dir) => ({ dir, key: basename(dir), row: tourRow(dir, today, idle, relative(parent, dir).split(sep).join('/')) }));
  const priority = attempt(() => readPriority(parent), [] as string[]);
  const sorted = withFree(rows.sort((a, b) => priorityRank(a.key, priority) - priorityRank(b.key, priority) || a.key.localeCompare(b.key) || a.row.project.localeCompare(b.row.project)));
  return [...problems, ...sorted];
}

/** Joint à chaque ligne ses lots prêts aux ressources libres (L252), calculés sur tous les projets du tour : ce qu'un projet tient en retire aux autres. */
function withFree(rows: { dir: string; row: TourRow }[]): TourRow[] {
  const ok = rows.filter((x) => !x.row.error);
  const free = readyFree(ok.map((x) => x.dir), cadenceHome());
  for (const x of ok) if (free.has(x.dir)) x.row.free = free.get(x.dir);
  return rows.map((x) => x.row);
}

/** La ligne « prêts, ressources libres » du tour, ou null quand aucun lot prêt n'est libre. */
export function tourFreeLine(rows: TourRow[]): string | null {
  return freeLine(rows.filter((r) => r.free).map((r) => ({ project: r.project, free: r.free! })), TITLE_MAX);
}

/** Les worktrees de lot conservés du tour (L279, R19) : un titre puis une ligne chacun — dépôt, lot, âge, commits non intégrés, chemin ; rien quand il n'y en a pas. */
export function tourWorktreeLines(rows: TourRow[], now = Date.now()): string[] {
  const lines = rows.flatMap((r) => (r.worktrees ?? []).map((t) => keptLine(r.project, t, now)));
  return lines.length ? [KEPT_TITLE, ...lines] : [];
}

/** Une ligne par projet sans `orchestrate.test` (L327) : la vague ne lancera pas la suite ; rien quand tous le déclarent. */
export function tourNoTestLines(rows: TourRow[]): string[] {
  return rows.filter((r) => r.noTest).map((r) => `${r.project} · ${noTestText(r.noTest!)}`);
}

const DRIFT_SHOWN = 2;

/** Une ligne par projet : projet · en cours · dérive · notes · prochain lot prêt · dépôt. */
export function tourLine(r: TourRow): string {
  if (r.error) return `${r.project} · ✗ erreur : ${r.error}`;
  const doing = r.doing.length ? r.doing.map((d) => `${d.id} (${[commitCount(d.commits), ...(d.noActivity ? ['aucune activité'] : d.silentDays === undefined ? [] : [`silencieux ${d.silentDays}j`])].join(', ')})`).join(', ') : 'rien';
  const drift = r.drift.length
    ? `${r.drift.length} (${r.drift.slice(0, DRIFT_SHOWN).join(' ; ')}${r.drift.length > DRIFT_SHOWN ? ' ; …' : ''})`
    : 'aucune';
  const notes = r.notes.length ? `${truncate(r.notes.join(' / '), NOTES_MAX)}${r.staleNotes ? ` ${staleText(r.staleNotes)}` : ''}` : 'aucune';
  const next = r.next ? `${r.next.id} ${truncate(r.next.title, TITLE_MAX)}` : 'aucun';
  return [r.project, `en cours ${doing}`, `dérive ${drift}`, `notes : ${notes}`, `prochain ${next}`, ...(r.waiting?.length ? [`attend ${r.waiting.join(', ')}`] : []), `dépôt ${r.repo.length ? r.repo.join(', ') : 'propre'}`].join(' · ');
}
