// L931 (D-44) : `cadence suivant`, l'orchestrateur minimal. Sans modèle et sans rien lancer, il dit depuis un dossier parent le prochain
// `projet:lot` à lancer, ou « rien » avec la raison. Il ne recalcule ni l'ordre ni les lots tirables : il lit le tour (`leadTourEntries`,
// la ligne « tirables, ressources libres ») et y ajoute ce que le tour ne tranche pas — créneaux, dépôts tenus, lots en cours sans run.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planLoader, readOrchestrateConfig } from './config.js';
import { gitRoot } from './git.js';
import type { Day } from './dates.js';
import { leadTourEntries, TITLE_MAX, truncate, type TourEntry } from './lead.js';
import type { FreeLot } from './ready-free.js';
import type { Lot } from './plan.js';
import { isRecurring } from './recurring.js';
import { decisionPending, drawFilter } from './orchestrate/continue.js';
import { cadenceHome, freeSlots, liveRuns, liveWaves, outsideSessions } from './orchestrate/registry.js';
import { repoHolders } from './repo-held.js';
import { waveHolding } from './repo-busy.js';
import { startedElsewhere } from './started-elsewhere.js';

/** Le lot rendu : `en cours` (doing au plan, sans run vivant ni vague : à reprendre) passe avant `neuf` (tirable, ressources libres). */
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
}

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Le banc de cadence en cours sur ce dépôt : seul un dépôt qui porte un v2 construit est benché (comme `tourBancLines`), et le passage tient
 * `<BENCH_ROOT ou ~/bench-cadence>/passage.lock` (« pid date boot », docs/v2/banc.md) ; un pid mort ou d'un autre démarrage ne tient rien.
 */
function benchHolding(root: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(join(root, 'v2', 'bin', 'cadence2.js'))) return false;
  const lock = join(env.BENCH_ROOT ?? join(env.HOME ?? '', 'bench-cadence'), 'passage.lock');
  let content: string;
  try {
    content = readFileSync(lock, 'utf8');
  } catch {
    return false;
  }
  const [pid, , boot] = content.trim().split(' ');
  let here = '';
  try {
    here = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch { /* hors Linux : pas d'identifiant de démarrage */ }
  if (boot && here && boot !== here) return false;
  return pidAlive(Number(pid));
}

/** Pourquoi le dépôt de `dir` est tenu, ou null : un run par dépôt (cadence run vivant), une vague qui y joue, une porte (publication, verify --gate), un banc. */
function repoHeldReason(dir: string, env: NodeJS.ProcessEnv, home = cadenceHome()): string | null {
  const root = gitRoot(dir) ?? resolve(dir);
  const run = liveRuns(home).find((r) => resolve(r.repo) === resolve(root));
  if (run) return `cadence run ${run.id}${run.lot ? ` (${run.lot})` : ''} vivant`;
  try {
    const wave = waveHolding(root);
    if (wave) return `vague ${wave.wave} en cours`;
  } catch { /* verrou illisible : la vague se dit dans son tour */ }
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

/** Les lots `doing` du plan qu'aucun run vivant ni `raf start` en attente ne sert : commencés, laissés sans session, à reprendre avant un neuf. */
function orphanDoing(dir: string, lots: Lot[], home: string): Lot[] {
  const root = gitRoot(dir) ?? resolve(dir);
  const started = startedElsewhere(root, home);
  return lots.filter((l) => l.status === 'doing' && !isRecurring(l) && !started.has(l.id));
}

/**
 * Le prochain `projet:lot` à lancer depuis `parent`, sans rien lancer ni écrire au plan. Ordre : celui du tour (`priority:` du cadence.yaml du dossier,
 * puis alphabétique). Créneaux libres du registre à 0 : rien. Un dépôt tenu est sauté. Un lot en cours sans run vivant, dans l'ordre des projets,
 * passe avant tout lot neuf ; sinon le premier lot de la ligne « tirables, ressources libres » que le réglage de tirage du projet n'écarte pas.
 * `entries` : le tour déjà calculé (lead tour l'a), sinon il est lu ici.
 */
export function suivant(parent: string, today: Day, o: { cap: number; env: NodeJS.ProcessEnv; now: Date; depth?: number; entries?: TourEntry[] }): Suivant {
  const home = cadenceHome();
  const free = freeSlots(liveWaves(home), o.cap, outsideSessions(home, o.now));
  const slots = { free, cap: o.cap };
  const entries = o.entries ?? leadTourEntries(parent, today, undefined, o.depth);
  if (!entries.some((e) => e.dir)) return { next: null, reason: `aucun projet sous ${parent}`, slots, skipped: [] };
  if (free <= 0) return { next: null, reason: `créneaux pleins, ${free} libre sur ${o.cap}`, slots, skipped: [] };
  const { open, skipped } = openRepos(entries, o.env, home);
  const pick = (x: OpenRepo, l: Pick<Lot, 'id' | 'title'>, kind: NextLot['kind']): Suivant => ({ next: { project: x.project, lot: l.id, title: l.title, kind, dir: x.dir }, slots, skipped });
  for (const x of open) {
    const doing = orphanDoing(x.dir, x.lots, home).find((l) => !excluded(l, x.setting));
    if (doing) return pick(x, doing, 'en cours');
  }
  for (const x of open) {
    const byId = new Map(x.lots.map((l) => [l.id, l]));
    const ready = x.free.find((f) => {
      const lot = byId.get(f.id);
      return lot && !excluded(lot, x.setting);
    });
    if (ready) return pick(x, ready, 'neuf');
  }
  return { next: null, reason: skipped.length ? 'aucun lot tirable aux ressources libres dans un dépôt libre' : 'aucun lot tirable aux ressources libres', slots, skipped };
}

/** Un projet du tour dont le dépôt est libre, avec son plan lu et son réglage de tirage. */
interface OpenRepo {
  project: string;
  dir: string;
  lots: Lot[];
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
      open.push({ project: row.project, dir, lots: planLoader(gitRoot(dir) ?? dir)().lots(), free: row.free ?? [], setting: drawSetting(dir) });
    } catch (err) {
      skipped.push({ project: row.project, reason: `plan illisible : ${(err as Error).message.split('\n')[0]}` });
    }
  }
  return { open, skipped };
}

/** La ligne du tour (L931) : « prochain dans l'ordre : projet:lot titre (en cours sans run vivant : à reprendre) », ou « rien (raison) ». */
export function suivantLine(s: Suivant): string {
  if (!s.next) return `prochain dans l'ordre : rien (${s.reason})`;
  return `prochain dans l'ordre : ${s.next.project}:${s.next.lot} ${truncate(s.next.title, TITLE_MAX)}${s.next.kind === 'en cours' ? ' (en cours sans run vivant : à reprendre)' : ''}`;
}

/** La sortie texte de `cadence suivant` : le lot ou « rien », puis une ligne par projet sauté. */
export function suivantLines(s: Suivant): string[] {
  const head = s.next
    ? `${s.next.project}:${s.next.lot} · ${truncate(s.next.title, TITLE_MAX)} · ${s.next.kind === 'en cours' ? 'en cours sans run vivant : à reprendre' : 'neuf'} · créneaux libres ${s.slots.free} sur ${s.slots.cap}`
    : `rien : ${s.reason} · créneaux libres ${s.slots.free} sur ${s.slots.cap}`;
  return [head, ...s.skipped.map((k) => `  sauté ${k.project} : ${k.reason}`)];
}
