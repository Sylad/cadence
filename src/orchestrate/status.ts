import { basename, join } from 'node:path';
import { gitRoot } from '../git.js';
import { localOverdueLines } from '../local-task.js';
import { RafError } from '../plan.js';
import { findProjects, isProject as isLeadProject } from '../lead.js';
import { freeLine, readyFree } from '../ready-free.js';
import { cadenceHome, expiredHolds, freeSlots, liveHolds, liveSlots, liveWaves } from './registry.js';
import { longDuration } from './guard.js';
import { keptLines } from './worktree.js';
import { lotFinished, lotKey, RunStore, type LotState } from './state.js';
import { launchPrices, renderDetail, renderTable, resumeCommand } from './table.js';
import { waveReadsAnswerQueue, waveReadsControl } from './snapshot.js';
import { preflight } from './preflight.js';
import { dryRun } from './dry-run.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import { DEFAULT_MAX_SESSIONS, parseMaxSessions, type Args } from './command-args.js';

export function maxSessions(args: Args, io: OrchestrateIo): number {
  if (args.maxSessions !== undefined) return args.maxSessions;
  const env = io.env.CADENCE_MAX_SESSIONS;
  return env ? parseMaxSessions(env, 'CADENCE_MAX_SESSIONS') : DEFAULT_MAX_SESSIONS;
}

/** Plafond à AFFICHER (`--status`, `lead tour`) : le réglage de l'humain, jamais 2 en dur. Un réglage invalide ne casse pas l'affichage (le lancement, lui, le refuse) : retour au défaut. */
export function configuredCap(env: Record<string, string | undefined>, flag?: number): number {
  if (flag !== undefined) return flag;
  try {
    return env.CADENCE_MAX_SESSIONS ? parseMaxSessions(env.CADENCE_MAX_SESSIONS, 'CADENCE_MAX_SESSIONS') : DEFAULT_MAX_SESSIONS;
  } catch {
    return DEFAULT_MAX_SESSIONS;
  }
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** La ligne des créneaux (L141, L255) et leur nombre libre : toujours, même sans vague ni session du lead (L416 : « libres : 3 sur 3 » se lit, il ne se déduit pas d'une absence de ligne). */
export function slotsLine(cap = DEFAULT_MAX_SESSIONS, now = new Date()): { line: string; free: number } {
  const home = cadenceHome();
  const holds = liveHolds(home, now);
  const free = freeSlots(liveWaves(home), cap, holds.length);
  const lead = holds.length ? ` · sessions du lead : ${holds.length} (${holds.map((h) => h.label).join(', ')})` : '';
  return { line: `vagues en cours : ${liveWaves(home).length} · sessions en cours : ${liveSlots(home).length}${lead} · créneaux libres : ${free} sur ${cap}`, free };
}

/** Vagues vivantes (toutes, quel que soit leur dossier de départ), sessions du lead (L255), créneaux libres et dépôts qu'elles tiennent. Rien sans vague ni session du lead. */
export function liveLines(cap = DEFAULT_MAX_SESSIONS, now = new Date()): string[] {
  const home = cadenceHome();
  const waves = liveWaves(home);
  if (waves.length === 0 && liveHolds(home, now).length === 0) return [];
  const lines = [slotsLine(cap, now).line];
  for (const w of waves) lines.push(`  ${w.wave} (pid ${w.pid}, depuis ${w.started}) lancée depuis ${w.cwd} · plafond ${w.cap ?? '?'} · dépôts : ${w.repos.join(', ')}`);
  return lines;
}

/** Une ligne ⚠ par session du lead dont le TTL est échu et qui n'a pas été rendue (L278) : vide sans session échue. */
export function expiredHoldLines(now = new Date()): string[] {
  return expiredHolds(cadenceHome(), now).map((h) => {
    const since = Date.parse(h.since);
    const age = Number.isFinite(since) ? `inscrite depuis ${longDuration(now.getTime() - since)}, ` : '';
    return `⚠ session du lead échue : ${h.label} (${age}échue depuis ${longDuration(now.getTime() - Date.parse(h.expires))}) — la reprendre (cadence lead hold ${h.label} --ttl <minutes>) ou l'arrêter (cadence lead release ${h.label})`;
  });
}

/** `--continue` (L252) : la ligne des lots prêts dont aucune ressource n'est prise par un lot en cours ni par une vague, sans les lots du premier tirage `drawn` ni les ressources qu'ils tiennent. Vide si aucun. */
export function freeLines(launch: string, drawn: LotState[]): string[] {
  const dirs = isLeadProject(launch) ? [launch] : findProjects(launch);
  const free = readyFree(dirs, cadenceHome(), drawn);
  const line = freeLine(dirs.filter((d) => free.has(d)).map((d) => ({ project: basename(d), free: free.get(d)! })), 60);
  return line ? [line] : [];
}

/** Efface l'écran et replace le curseur en haut : l'entrée d'un rendu de `--status --watch`. */
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
const DEFAULT_WATCH_INTERVAL = 10;

/** Ce que `--status` montre à un instant : les vagues vivantes, puis le tableau (absent si seules les vagues vivantes comptent). */
function statusView(args: Args, launch: string, cap: number, now: Date): { live: string[]; table?: string[]; running: boolean } {
  const id = statusWave(args);
  const store = id !== undefined ? RunStore.find(launch, id) : RunStore.last(launch);
  const live = [...liveLines(cap, now), ...expiredHoldLines(now), ...localOverdueLines((isLeadProject(launch) ? [launch] : findProjects(launch)).map((d) => gitRoot(d) ?? d), now)];
  const waveLive = liveWaves(cadenceHome()).length > 0;
  if (!store && live.length && id === undefined) return { live, running: waveLive };
  if (!store) throw new RafError(id !== undefined ? `vague inconnue : ${id}` : 'aucune vague dans ce dossier');
  // `running` : la vague suivie tourne — pour un <id> explicite, elle seule compte, pas les autres vagues de la machine
  const running = id !== undefined ? liveWaves(cadenceHome()).some((w) => w.wave === store.readWave()!.id) : waveLive;
  const lots = store.lots();
  if (args.detail !== undefined) {
    try {
      return { live: [], table: renderDetail(lots, args.detail), running };
    } catch (e) {
      throw new RafError((e as Error).message);
    }
  }
  return { live, table: [...renderTable(store.readWave()!, lots, { compact: true, prices: launchPrices(launch, (w) => live.push(`⚠ ${w}`)) }), ...keptLines(lots.map((l) => l.repo), now.getTime())], running };
}

/** La vague que `--status` suit (L395) : `--status <id>` ou `--status --wave <id>` ; aucune : la dernière du dossier. Deux ids différents : refus. */
function statusWave(args: Args): string | undefined {
  if (typeof args.status === 'string' && args.wave !== undefined && args.status !== args.wave) throw new RafError(`--status ${args.status} et --wave ${args.wave} désignent deux vagues : une seule`);
  return typeof args.status === 'string' ? args.status : args.status === true ? args.wave : undefined;
}

/** Refus d'une `--wave` déjà existante, identique en simulation et au vrai lancement. */
export function waveExists(wave: string, io: OrchestrateIo): number {
  io.err(`orchestrate : --wave ${wave} : cette vague existe déjà`);
  return 2;
}

/** L382 : `claude auth status` peut durer jusqu'à 20 s ; en --continue, preflight() le relancerait pour chaque lot candidat de chaque tour. Une seule lecture par lancement (une vague). */
export function onceAuth(deps: OrchestrateDeps): OrchestrateDeps {
  const read = deps.claudeAuth;
  if (!read) return deps;
  let cached: { value: ReturnType<typeof read> } | undefined;
  return { ...deps, claudeAuth: () => (cached ??= { value: read() }).value };
}

/** `--status` (L395) : le tableau des vagues vivantes et de la vague suivie, une fois ou rafraîchi avec `--watch` jusqu'à ce que plus rien ne tourne. */
export async function statusCommand(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string): Promise<number> {
  maxSessions(args, io); // une valeur invalide est refusée ici aussi
  const view = () => statusView(args, launch, configuredCap(io.env, args.maxSessions), io.now());
  if (!args.watch) {
    const { live, table } = view();
    printStatus(io, live, table); // sans identifiant (pas de tableau) : les vagues vivantes suffisent
    return 0;
  }
  // --watch : le même tableau, rafraîchi ; il s'arrête seul quand plus aucune vague ne tourne (le dernier rendu reste affiché)
  const sleep = deps.watchSleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const seconds = args.interval ?? DEFAULT_WATCH_INTERVAL;
  for (;;) {
    const { live, table, running } = view();
    io.out(CLEAR_SCREEN);
    printStatus(io, live, table);
    if (!running) return 0;
    io.out('');
    io.out(`rafraîchi toutes les ${seconds} s — Ctrl-C pour quitter`);
    await sleep(seconds * 1000);
  }
}

/** Les vagues vivantes, puis (s'il y en a un) le tableau de la vague suivie, séparés d'une ligne vide. */
function printStatus(io: OrchestrateIo, live: string[], table: string[] | undefined): void {
  for (const line of live) io.out(line);
  if (!table) return;
  if (live.length) io.out('');
  for (const line of table) io.out(line);
}

/**
 * `--answer` sur une vague VIVANTE (L407) : la réponse est déposée dans la file de la vague (`answers.log`), qui la prend entre deux étapes et rejoue le lot dès qu'un créneau est libre.
 * Sans cela le lead attendait la fin de la vague (15 min d'un lot bloqué le 28-10). Les lots visés sont contrôlés comme à la reprise : connus, en question.
 */
export function answerLive(args: Args, io: OrchestrateIo, store: RunStore): number {
  const lots = store.lots();
  const refusals: string[] = [];
  const keys: { key: string; text: string }[] = [];
  for (const a of args.answers) {
    const matches = lots.filter((l) => l.lot === a.lot && (a.project ? l.project === a.project : true));
    const where = `${a.project ? `${a.project}:` : ''}${a.lot}`;
    if (matches.length !== 1) refusals.push(matches.length ? `--answer ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--answer ${where} : lot inconnu dans la vague ${store.id}`);
    else if (matches[0].status !== 'question') refusals.push(`--answer ${lotKey(matches[0].project, matches[0].lot)} : le lot n'attend pas de réponse (${matches[0].status})`);
    else keys.push({ key: lotKey(matches[0].project, matches[0].lot), text: a.text });
  }
  if (!waveReadsAnswerQueue(store.dir)) refusals.push(`la vague ${store.id} ne lit pas la file de réponses (lancée avec une version de cadence d'avant L407) : attendre sa fin, puis ${resumeCommand(store.id, '--answer', '<projet>:<lot>', '"…"')}`);
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  for (const { key, text } of keys) {
    const id = store.requestAnswer(key, text);
    // La vague a pu finir entre le contrôle et le dépôt : sa file ne sera plus lue, la réponse est retirée et le lead reprend à la main.
    if (!liveWaves(cadenceHome()).some((w) => w.wave === store.id)) {
      store.markAnswerTaken(id);
      io.err(`orchestrate : ${key} : la vague ${store.id} vient de finir, réponse non prise : ${resumeCommand(store.id, '--answer', key, '"…"')}`);
      return 2;
    }
    store.journal(`demande : réponse du lead pour ${key}`);
    io.out(`${key} : réponse déposée — la vague ${store.id} la prend entre deux étapes et rejoue le lot dès qu'un créneau est libre`);
  }
  return 0;
}

/** La vague vivante, pour `--answer` seul (sans --resume) : la même recherche que `--drop`. */
export function answerOnly(args: Args, io: OrchestrateIo): number {
  if (args.drop.length || args.stopAfterCurrent || args.budget !== undefined || args.dryRun || args.continue || args.lots.length) throw new RafError("--answer ne se combine pas avec --drop, --stop-after-current, --budget, --dry-run, --continue ni des lots à lancer (sur une vague arrêtée : --resume --answer)");
  const store = liveStore('--answer', args, io);
  if (typeof store === 'number') {
    io.err(`orchestrate : --answer : une vague arrêtée se reprend avec ${resumeCommand('<vague>', '--answer', '<projet>:<lot>', '"…"')}`);
    return store;
  }
  return answerLive(args, io, store);
}

/** La vague vivante lancée depuis ce dossier que vise `--wave` (ou la seule) ; sinon le refus (code 2) déjà écrit. */
export function liveStore(flags: string, args: Args, io: OrchestrateIo): RunStore | number {
  const live = liveWaves(cadenceHome()).filter((w) => w.cwd === io.cwd && (args.wave === undefined || w.wave === args.wave));
  if (live.length === 0) {
    io.err(`orchestrate : ${flags} : aucune vague en cours${args.wave ? ` (${args.wave})` : ''} lancée depuis ce dossier`);
    return 2;
  }
  if (live.length > 1) {
    io.err(`orchestrate : ${flags} : plusieurs vagues tournent depuis ce dossier (${live.map((w) => w.wave).join(', ')}) : précisez --wave`);
    return 2;
  }
  const store = RunStore.find(io.cwd, live[0].wave);
  if (!store) {
    io.err(`orchestrate : ${flags} : dossier d'état de la vague ${live[0].wave} introuvable`);
    return 2;
  }
  return store;
}

/** `--drop` / `--stop-after-current` (L79) : une demande écrite dans le dossier d'état de la vague vivante ; c'est elle qui la lit avant sa prochaine session. */
export function control(args: Args, io: OrchestrateIo): number {
  const flags = '--drop / --stop-after-current';
  if (args.lots.length || args.continue || args.dryRun || args.budget !== undefined || args.answers.length) throw new RafError(`${flags} ne se combinent pas avec des lots à lancer, --continue, --dry-run, --budget ou --answer`);
  const store = liveStore(flags, args, io);
  if (typeof store === 'number') return store;
  const lots = store.lots();
  const refusals: string[] = [];
  const keys: string[] = [];
  for (const d of args.drop) {
    const matches = lots.filter((l) => l.lot === d.lot && (d.project ? l.project === d.project : true));
    const where = `${d.project ? `${d.project}:` : ''}${d.lot}`;
    if (matches.length !== 1) refusals.push(matches.length ? `--drop ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--drop ${where} : lot inconnu dans la vague ${store.id}`);
    else if (lotFinished(matches[0])) refusals.push(`--drop ${lotKey(matches[0].project, matches[0].lot)} : le lot est déjà fini (${matches[0].status})`);
    else keys.push(lotKey(matches[0].project, matches[0].lot));
  }
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  // La demande est écrite quoi qu'il arrive (le fichier est inoffensif) ; mais une vague d'avant L79 ne le lira jamais : on le dit.
  if (!waveReadsControl(store.dir)) io.err(`orchestrate : ${flags} : la vague ${store.id} ne lit pas les demandes de contrôle (lancée avec une version de cadence d'avant L79) : la demande est écrite dans control.log mais cette vague ne la lira pas`);
  for (const k of keys) {
    store.requestDrop(k);
    store.journal(`demande : retirer ${k} de la vague`);
    io.out(`${k} : retrait demandé — la vague ${store.id} l'écarte avant sa prochaine session (la session en cours finit)`);
  }
  if (args.stopAfterCurrent) {
    store.requestStopAfterCurrent();
    store.journal('demande : arrêt après les sessions en cours');
    io.out(`vague ${store.id} : arrêt demandé — les sessions en cours finissent, aucune autre ne part ; reprise par « ${resumeCommand(store.id)} »`);
  }
  return 0;
}

/** La seule vague non terminée du dossier (L309) ; plusieurs : refus qui les liste, aucune : refus (jamais le choix silencieux de la plus récente). */
export function singleUnfinished(launch: string): RunStore {
  const open = RunStore.unfinished(launch);
  if (open.length === 0) throw new RafError('aucune vague à reprendre dans ce dossier');
  if (open.length > 1) throw new RafError(`plusieurs vagues non terminées dans ce dossier, laquelle reprendre ?\n${open.map((s) => `  ${s.id} (${s.readWave()?.status ?? 'illisible'}, lancée ${s.readWave()?.created ?? '?'})`).join('\n')}\nreprise : ${resumeCommand('<vague>')}`);
  return open[0];
}
