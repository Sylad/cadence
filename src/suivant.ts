// L931 (D-44) : `cadence suivant`, l'orchestrateur minimal. Sans modèle et sans rien lancer, il dit depuis un dossier parent le prochain
// `projet:lot` à lancer, ou « rien » avec la raison. Il ne recalcule ni l'ordre ni les lots tirables : il lit le tour (`leadTourEntries`,
// la ligne « tirables, ressources libres ») et y ajoute ce que le tour ne tranche pas — créneaux, dépôts tenus (run, vague, livraison, porte, banc), lots en cours sans run ni commit.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planLoader, readOrchestrateConfig } from './config.js';
import { gitRoot } from './git.js';
import type { Day } from './dates.js';
import { leadTourEntries, TITLE_MAX, truncate, type TourEntry } from './lead.js';
import type { FreeLot } from './ready-free.js';
import type { Lot, Plan } from './plan.js';
import { isRecurring } from './recurring.js';
import { decisionPending, drawFilter } from './orchestrate/continue.js';
import { cadenceHome, freeSlots, liveRuns, liveWaves, outsideSessions } from './orchestrate/registry.js';
import { repoHolders } from './repo-held.js';
import { waveHolding } from './repo-busy.js';
import { startedElsewhere } from './started-elsewhere.js';
import { lockStatus } from './session.js';
import { sharedStateDir } from './state.js';
import { lastRunByLot } from './perf-runs.js';
import { linkCommits } from './link.js';
import { planCommits, workCommits } from './audit.js';
import { passageEnCours, racineBanc } from '../scripts/verrou-banc.mjs';

/** Le lot rendu : `en cours` (doing au plan, sans run ni commit : à reprendre) passe avant `neuf` (tirable, ressources libres). */
interface NextLot {
  project: string;
  lot: string;
  title: string;
  kind: 'en cours' | 'neuf';
  dir: string;
}

interface Suivant {
  next: NextLot | null;
  /** Pourquoi rien, quand `next` est null. */
  reason?: string;
  slots: { free: number; cap: number };
  /** Projets sautés, dans l'ordre du tour, avec leur raison (dépôt tenu, plan illisible). */
  skipped: { project: string; reason: string }[];
  /** Lots en cours qui ne sont pas à relancer (run fini, commits : en revue ou en livraison), avec leur raison (« attend la revue… »). */
  waiting: { project: string; lot: string; reason: string }[];
}

/** Le banc de cadence en cours sur ce dépôt : seul un dépôt qui porte un v2 construit est benché (comme `tourBancLines`) ; le verrou du passage se lit comme v2 le pose (scripts/verrou-banc.mjs). */
const benchHolding = (root: string, env: NodeJS.ProcessEnv): boolean => existsSync(join(root, 'v2', 'bin', 'cadence2.js')) && passageEnCours(racineBanc(env)) !== null;

/** Pourquoi le dépôt de `dir` est tenu, ou null : un run par dépôt (cadence run vivant), une vague qui y joue, une livraison (verrou de cadence deliver, comme la colonne du tour),
 * une porte (publication, verify --gate), un banc. */
function repoHeldReason(dir: string, env: NodeJS.ProcessEnv, home = cadenceHome()): string | null {
  const root = gitRoot(dir) ?? resolve(dir);
  const run = liveRuns(home).find((r) => resolve(r.repo) === resolve(root));
  if (run) return `cadence run ${run.id}${run.lot ? ` (${run.lot})` : ''} vivant`;
  try {
    const wave = waveHolding(root);
    if (wave) return `vague ${wave.wave} en cours`;
  } catch { /* verrou illisible : la vague se dit dans son tour */ }
  if (lockStatus(sharedStateDir(root))?.live) return 'livraison en cours (cadence deliver)';
  const holder = repoHolders(root, false).find((h) => h.kind !== 'run');
  if (holder) return `tenu par ${holder.label} depuis ${holder.since.slice(11, 16)}`;
  if (benchHolding(root, env)) return 'banc en cours';
  return null;
}

/** Le réglage de tirage du projet (`orchestrate.continue`, L390) ; cadence.yaml illisible ou absent : aucun. */
function drawSetting(dir: string) {
  try {
    return readOrchestrateConfig(join(gitRoot(dir) ?? dir, 'cadence.yaml')).continue;
  } catch {
    return undefined;
  }
}

/** Le lot est-il écarté du tirage (« à décider », continue.exclude, « non tirable », maxEstimate) ? */
const excluded = (lot: Lot, setting: ReturnType<typeof drawSetting>): boolean => decisionPending(lot) || drawFilter(lot, setting) !== null;

/**
 * Les lots `doing` du plan qu'aucun run vivant ni `raf start` en attente ne sert, partagés en deux. `waiting` : le lot a un run du registre (intégré, rendu,
 * ou en attente d'une réponse) ou des commits de travail — il est en revue ou en livraison, jamais à relancer (revue L931, B1 : claude-code-codex:L110,
 * run intégré, était rendu « à reprendre »). `resume` : commencé sans run ni commit, à reprendre avant un neuf.
 */
function doingLots(x: OpenRepo, home: string): { resume: Lot[]; waiting: { lot: string; reason: string }[] } {
  const root = gitRoot(x.dir) ?? resolve(x.dir);
  const started = startedElsewhere(root, home);
  const candidates = x.plan.lots().filter((l) => l.status === 'doing' && !isRecurring(l) && !started.has(l.id) && !excluded(l, x.setting));
  if (!candidates.length) return { resume: [], waiting: [] };
  const runs = lastRunByLot(root);
  const commits = candidates.some((l) => !runs.has(l.id)) ? workByLotId(x.plan, root) : new Map<string, unknown[]>();
  const why = candidates.map((l) => ({ lot: l, reason: waitingReason(l.id, runs.get(l.id), commits.get(l.id)?.length ?? 0) }));
  return {
    resume: why.filter((w) => w.reason === null).map((w) => w.lot),
    waiting: why.flatMap((w) => (w.reason === null ? [] : [{ lot: w.lot.id, reason: w.reason }])),
  };
}

/** Pourquoi un lot en cours n'est pas à relancer (son dernier run, sinon ses commits de travail), ou null : ni run ni commit, à reprendre. */
function waitingReason(id: string, run: { id: string; etat: string; fini: boolean } | undefined, commits: number): string | null {
  if (run) {
    const state = run.etat === 'integre' ? 'intégré' : run.fini ? `rendu au lead (${run.etat})` : `en ${run.etat}, se reprend par ce run`;
    return `${id} attend la revue (run ${run.id} ${state})`;
  }
  return commits ? `${id} attend la revue (${commits} commit${commits > 1 ? 's' : ''}, sans run)` : null;
}

/** Les commits de travail de chaque lot (ni plan seul, ni version, ni acquittés), d'un seul `git log` ; git illisible : aucun. */
function workByLotId(plan: Plan, root: string): Map<string, unknown[]> {
  try {
    const linked = linkCommits(plan.lots(), planCommits(plan, root), plan.refs);
    return new Map([...linked.byLot].map(([id, cs]) => [id, workCommits(plan, root, cs)]));
  } catch {
    return new Map();
  }
}

/**
 * Le prochain `projet:lot` à lancer depuis `parent`, sans rien lancer ni écrire au plan. Ordre : celui du tour (`priority:` du cadence.yaml du dossier,
 * puis alphabétique). Créneaux libres du registre à 0 : rien. Un dépôt tenu est sauté. Un lot en cours sans run (vivant ou fini) ni commit, dans l'ordre des projets,
 * passe avant tout lot neuf ; sinon le premier lot de la ligne « tirables, ressources libres » que le réglage de tirage du projet n'écarte pas.
 * `entries` : le tour déjà calculé (lead tour l'a), sinon il est lu ici.
 */
export function suivant(parent: string, today: Day, o: { cap: number; env: NodeJS.ProcessEnv; now: Date; depth?: number; entries?: TourEntry[] }): Suivant {
  const home = cadenceHome();
  const free = freeSlots(liveWaves(home), o.cap, outsideSessions(home, o.now));
  const slots = { free, cap: o.cap };
  const entries = o.entries ?? leadTourEntries(parent, today, undefined, o.depth);
  if (!entries.some((e) => e.dir)) return { next: null, reason: `aucun projet sous ${parent}`, slots, skipped: [], waiting: [] };
  if (free <= 0) return { next: null, reason: `créneaux pleins, ${free} libre sur ${o.cap}`, slots, skipped: [], waiting: [] };
  const { open, skipped } = openRepos(entries, o.env, home);
  const waiting: Suivant['waiting'] = [];
  const pick = (x: OpenRepo, l: Pick<Lot, 'id' | 'title'>, kind: NextLot['kind']): Suivant => ({ next: { project: x.project, lot: l.id, title: l.title, kind, dir: x.dir }, slots, skipped, waiting });
  for (const x of open) {
    const d = doingLots(x, home);
    waiting.push(...d.waiting.map((w) => ({ project: x.project, ...w })));
    if (d.resume[0]) return pick(x, d.resume[0], 'en cours');
  }
  for (const x of open) {
    const byId = new Map(x.plan.lots().map((l) => [l.id, l]));
    const ready = x.free.find((f) => {
      const lot = byId.get(f.id);
      return lot && !excluded(lot, x.setting);
    });
    if (ready) return pick(x, ready, 'neuf');
  }
  return { next: null, reason: skipped.length ? 'aucun lot tirable aux ressources libres dans un dépôt libre' : 'aucun lot tirable aux ressources libres', slots, skipped, waiting };
}

/** Un projet du tour dont le dépôt est libre, avec son plan lu et son réglage de tirage. */
interface OpenRepo {
  project: string;
  dir: string;
  plan: Plan;
  free: FreeLot[];
  setting: ReturnType<typeof drawSetting>;
}

/** Les projets du tour, dans son ordre, partagés entre dépôts libres et projets sautés (dépôt tenu, plan illisible) avec leur raison. */
function openRepos(entries: TourEntry[], env: NodeJS.ProcessEnv, home: string): { open: OpenRepo[]; skipped: Suivant['skipped'] } {
  const open: OpenRepo[] = [];
  const skipped: Suivant['skipped'] = [];
  for (const { dir, row } of entries) {
    if (!dir) continue; // ligne d'erreur du cadence.yaml du dossier : l'ordre retombe sur l'alphabétique, le tour la dit
    const held = row.error ? null : repoHeldReason(dir, env, home);
    if (held) {
      skipped.push({ project: row.project, reason: `dépôt tenu : ${held}` });
      continue;
    }
    try {
      if (row.error) throw new Error(row.error);
      open.push({ project: row.project, dir, plan: planLoader(gitRoot(dir) ?? dir)(), free: row.free ?? [], setting: drawSetting(dir) });
    } catch (err) {
      skipped.push({ project: row.project, reason: `plan illisible : ${(err as Error).message.split('\n')[0]}` });
    }
  }
  return { open, skipped };
}

/** La ligne du tour (L931) : « prochain dans l'ordre : projet:lot titre (en cours sans run ni commit : à reprendre) », ou « rien (raison) ». */
export function suivantLine(s: Suivant): string {
  if (!s.next) return `prochain dans l'ordre : rien (${s.reason})`;
  return `prochain dans l'ordre : ${s.next.project}:${s.next.lot} ${truncate(s.next.title, TITLE_MAX)}${s.next.kind === 'en cours' ? ' (en cours sans run ni commit : à reprendre)' : ''}`;
}

/** La sortie texte de `cadence suivant` : le lot ou « rien », puis une ligne par projet sauté et par lot en cours qui attend sa revue. */
export function suivantLines(s: Suivant): string[] {
  const head = s.next
    ? `${s.next.project}:${s.next.lot} · ${truncate(s.next.title, TITLE_MAX)} · ${s.next.kind === 'en cours' ? 'en cours sans run ni commit : à reprendre' : 'neuf'} · créneaux libres ${s.slots.free} sur ${s.slots.cap}`
    : `rien : ${s.reason} · créneaux libres ${s.slots.free} sur ${s.slots.cap}`;
  return [head, ...s.skipped.map((k) => `  sauté ${k.project} : ${k.reason}`), ...s.waiting.map((w) => `  pas à relancer ${w.project}:${w.reason}`)];
}
