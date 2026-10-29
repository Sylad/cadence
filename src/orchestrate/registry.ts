import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tokens } from './result.js';
import { processStart } from '../proc.js';
import { gitCommonDir } from '../git.js';
import { lotFinished, lotKey, lotRepoPaths, RunStore, type LotState } from './state.js';
import { activeLock, holderAlive, releaseLock, takeLock, type OLock } from './lock.js';

/**
 * État commun à toutes les vagues de l'utilisateur, quel que soit le dossier d'où elles partent : le registre
 * des vagues vivantes (`waves/<pid>.json`), les créneaux de sessions simultanées (`slots/slot-<n>.lock`) et les
 * sessions lancées à la main par le lead (`holds/<étiquette>.json`, L255).
 * Les verrous de DÉPÔT restent dans le dépôt (`.git/cadence/orchestrate.lock`).
 */
export function cadenceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CADENCE_HOME || join(env.HOME || homedir(), '.cadence', 'orchestrate');
}

export interface LiveWave {
  pid: number;
  wave: string;
  started: string;
  cwd: string;
  repos: string[];
  /** Plafond de sessions simultanées que cette vague s'applique (`--max-sessions`). */
  cap?: number;
  /** Lots que la vague peut jouer à la fois (L279) : un par dépôt, ou un par lot quand les lots d'un dépôt jouent chacun dans leur worktree. Absent : le nombre de dépôts. */
  lanes?: number;
  /** Heure de démarrage du processus : avec le pid, l'identité de la vague (un pid se réutilise). */
  start?: string;
}

const wavesDir = (home: string) => join(home, 'waves');
const slotsDir = (home: string) => join(home, 'slots');

function readWave(file: string): LiveWave | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const w: LiveWave = { pid: Number(raw.pid), wave: String(raw.wave), started: String(raw.started), cwd: String(raw.cwd), repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [] };
    if (raw.cap !== undefined) w.cap = Number(raw.cap);
    if (raw.lanes !== undefined) w.lanes = Number(raw.lanes);
    if (raw.start !== undefined) w.start = String(raw.start);
    return w;
  } catch {
    return null;
  }
}

/** Les vagues dont le processus vit encore. */
export function liveWaves(home: string): LiveWave[] {
  let names: string[];
  try {
    names = readdirSync(wavesDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LiveWave[] = [];
  for (const n of names) {
    const w = readWave(join(wavesDir(home), n));
    if (w && holderAlive(w.pid, w.start)) out.push(w);
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/**
 * Le plafond que TOUTES les vagues vivantes appliquent (L395) : le plus bas des plafonds connus, `fallback` si aucune n'en déclare.
 * Les créneaux sont communs : deux plafonds différents ne peuvent pas être respectés tous les deux (une vague à 4 à côté d'une
 * vague à 3 portait le total à « 4/3 » et la vague à 3 attendait), le plus bas fait loi pour toutes.
 */
export function commonCap(waves: LiveWave[], fallback: number): number {
  const caps = waves.map((w) => w.cap).filter((c): c is number => c !== undefined && Number.isFinite(c) && c >= 1);
  return caps.length ? Math.min(fallback, ...caps) : fallback;
}

/**
 * Les créneaux que le lead peut encore donner à des sous-agents : `total` moins, pour chaque vague vivante, le
 * plus petit du plafond commun (`commonCap`) et du nombre de lots qu'elle joue à la fois — un par dépôt qu'elle tient encore, un par lot pour des lots en worktrees (ses pas prennent un créneau et le
 * rendent entre deux étapes : les sessions vivantes à l'instant ne disent pas ce que la vague va reprendre).
 * Une vague sans plafond connu compte pour `total`.
 */
export function freeSlots(waves: LiveWave[], total: number, leadSessions = 0): number {
  const common = commonCap(waves, total);
  const held = waves.reduce((n, w) => n + Math.min(w.cap !== undefined ? common : total, w.lanes ?? w.repos.length), 0);
  return Math.max(0, total - held - leadSessions);
}

/**
 * Une session lancée à la main par le lead (sous-agent de correctif, de revue, de QA) : aucune vague ne la porte, le
 * registre ne la voit pas. Le lead l'inscrit (`cadence lead hold`), elle compte dans les créneaux pris jusqu'à son
 * `release` ou, si le lead l'oublie, jusqu'à son échéance, qui la signale ensuite en ⚠ (`expiredHolds`).
 */
export interface LeadHold {
  label: string;
  since: string;
  expires: string;
}

const holdsDir = (home: string) => join(home, 'holds');
/** Le libellé est libre (espaces, « / »), le nom de fichier l'encode. */
const holdFile = (home: string, label: string) => join(holdsDir(home), `${encodeURIComponent(label)}.json`);

/** Inscrit la session `label` pour `ttlMinutes` minutes à partir de `now` ; la poser de nouveau la renouvelle. */
export function addHold(home: string, label: string, ttlMinutes: number, now: Date): void {
  mkdirSync(holdsDir(home), { recursive: true });
  const file = holdFile(home, label);
  const hold: LeadHold = { label, since: now.toISOString(), expires: new Date(now.getTime() + ttlMinutes * 60_000).toISOString() };
  writeFileSync(`${file}.tmp`, JSON.stringify(hold));
  renameSync(`${file}.tmp`, file);
}

/** Retire la session `label` ; faux quand elle n'était pas inscrite. */
export function releaseHold(home: string, label: string): boolean {
  const file = holdFile(home, label);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Une session échue reste lisible (et signalée en ⚠) jusqu'à son `release` ou, oubliée, ce délai après son échéance. */
const EXPIRED_HOLD_KEEP_MS = 24 * 3600_000;

/** Lit les sessions du lead : celles dont l'échéance n'est pas passée à `now`, et celles échues depuis moins de 24 h ; le reste, et les fichiers illisibles, sont écartés au passage. */
function scanHolds(home: string, now: Date): { live: LeadHold[]; expired: LeadHold[] } {
  let names: string[];
  try {
    names = readdirSync(holdsDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return { live: [], expired: [] };
  }
  const live: LeadHold[] = [];
  const expired: LeadHold[] = [];
  for (const n of names) {
    const file = join(holdsDir(home), n);
    let hold: LeadHold | null = null;
    let overdue = false;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const end = Date.parse(raw.expires);
      if (typeof raw.label === 'string' && Number.isFinite(end)) {
        hold = { label: raw.label, since: String(raw.since), expires: String(raw.expires) };
        overdue = end <= now.getTime();
        if (now.getTime() - end >= EXPIRED_HOLD_KEEP_MS) hold = null;
      }
    } catch {
      // illisible : écarté
    }
    if (!hold) rmSync(file, { force: true });
    else (overdue ? expired : live).push(hold);
  }
  const byAge = (a: LeadHold, b: LeadHold) => a.since.localeCompare(b.since) || a.label.localeCompare(b.label);
  return { live: live.sort(byAge), expired: expired.sort(byAge) };
}

/** Les sessions du lead dont l'échéance n'est pas passée à `now` : seules elles comptent dans les créneaux. */
export function liveHolds(home: string, now: Date): LeadHold[] {
  return scanHolds(home, now).live;
}

/**
 * Les sessions du lead dont le TTL est échu à `now` (L278) et que personne n'a rendues : plus de créneau pris, mais la
 * session tourne peut-être encore. `lead tour`, `orchestrate --status` et la bande les signalent en ⚠ : le lead la
 * reprend (`lead hold`) ou l'arrête (`lead release`). Rien ne l'arrête ici.
 */
export function expiredHolds(home: string, now: Date): LeadHold[] {
  return scanHolds(home, now).expired;
}

/** Inscrit la vague ; écarte au passage les entrées de processus morts (les `.tmp` d'une inscription en cours ne sont pas touchés). */
export function registerWave(home: string, given: LiveWave): void {
  const w: LiveWave = { ...given, start: given.start ?? processStart(given.pid) ?? undefined };
  mkdirSync(wavesDir(home), { recursive: true });
  for (const n of readdirSync(wavesDir(home))) {
    if (!n.endsWith('.json')) continue;
    const old = readWave(join(wavesDir(home), n));
    if (!old || !holderAlive(old.pid, old.start)) rmSync(join(wavesDir(home), n), { force: true });
  }
  const file = join(wavesDir(home), `${w.pid}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(w));
  renameSync(`${file}.tmp`, file);
}

/** Met à jour la liste des dépôts tenus par la vague (un dépôt libéré en cours de vague n'y figure plus) et, quand elle la donne, le nombre de lots qu'elle joue à la fois. */
export function updateWaveRepos(home: string, pid: number, repos: string[], lanes?: number): void {
  const file = join(wavesDir(home), `${pid}.json`);
  const w = readWave(file);
  if (!w) return;
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...w, repos, ...(lanes === undefined ? {} : { lanes }) }));
  renameSync(`${file}.tmp`, file);
}

export function unregisterWave(home: string, pid: number): void {
  rmSync(join(wavesDir(home), `${pid}.json`), { force: true });
}

/** Les sessions en cours en ce moment, toutes vagues confondues. */
export function liveSlots(home: string): OLock[] {
  let names: string[];
  try {
    names = readdirSync(slotsDir(home)).filter((n) => /^slot-\d+\.lock$/.test(n));
  } catch {
    return [];
  }
  return names.map((n) => activeLock(join(slotsDir(home), n))).filter((l): l is OLock => l !== null);
}

/** Index de créneau le plus haut essayé : le plafond de chaque vague est le sien, les fichiers sont communs. */
const MAX_SLOT_INDEX = 64;

/** Intervalle des rappels d'attente dans le journal. */
const WAIT_REPORT_MS = 60_000;

/**
 * Ce qu'une session déjà vécue laisse derrière elle quand son lancement suivant (relance de mise en forme, relance après coupure)
 * est abandonné à l'attente d'un créneau : la sortie de cette session, ses jetons, son identifiant (L332).
 */
export interface SlotAbandonedAfter {
  /** Session coupée (code 143, sortie vide) dont la relance en session neuve n'a pas eu lieu. */
  relaunched?: { sessionId: string; cause: string; stderr: string };
  /** Session sans `structured_output` dont la relance de mise en forme (`--resume`) n'a pas eu lieu. */
  formatting?: { stdout: string; stderr: string; tokens?: Tokens; sessionId?: string };
}

/** L'attente d'un créneau a été interrompue par `abandon` (L332) : aucun créneau n'a été pris, la session ne part pas. */
export class SlotAbandoned extends Error {
  /** Renseigné par `runSession` quand une session précédente de l'étape a déjà tourné : sa sortie et ses jetons ne se perdent pas. */
  after?: SlotAbandonedAfter;
  constructor(readonly reason: string) {
    super(`attente de créneau abandonnée : ${reason}`);
  }
}

/**
 * Attend que le nombre de sessions vivantes, TOUTES vagues confondues et quel que soit l'index de leur créneau,
 * — plus les sessions du lead inscrites par `lead hold` (L424), qu'aucune vague ne porte — soit sous le plafond commun — `cap` (le plafond de cette vague) ou, s'il est plus bas, celui d'une autre vague vivante
 * (`commonCap`, relu à chaque tour, L395) —, puis prend le premier créneau libre (un pid mort est repris) et
 * rend sa libération. Toutes les vagues appliquent le même plafond : jamais « 4/3 en cours ».
 * Deux vagues qui prennent en même temps se départagent au recomptage : si le total dépasse `cap` une fois
 * le créneau pris, il est rendu et l'attente reprend.
 *
 * `onWait(holders, waitedMs)` : appelé quand on commence à attendre (0 ms), puis toutes les minutes.
 * `onGot(waitedMs)` : appelé à l'obtention, seulement si on a attendu.
 * `abandon()` : relu seulement pendant une VRAIE attente, c'est-à-dire une fois qu'une première tentative n'a pas trouvé de créneau libre,
 * puis à chaque tour ; une raison en retour interrompt l'attente par `SlotAbandoned`, sans prendre de créneau (L332 : `--drop` et
 * `--stop-after-current` ne laissent pas un lot en attente). Un créneau libre est toujours pris, même si une demande est déjà posée :
 * la relance d'une session coupée n'est pas une attente, la demande d'arrêt s'applique ensuite.
 */
export async function acquireSlot(
  home: string,
  cap: number,
  opts: { wave: string; slots?: (home: string) => OLock[]; pollMs?: number; reportMs?: number; onWait?: (holders: OLock[], waitedMs: number, limit: number, leadHolds: LeadHold[]) => void; onGot?: (waitedMs: number) => void; abandon?: () => string | null; now?: () => number },
): Promise<() => void> {
  mkdirSync(slotsDir(home), { recursive: true });
  const now = opts.now ?? Date.now; // injectable : les tests pilotent l'horloge
  const t0 = now();
  let reportedAt: number | null = null;
  const pollMs = opts.pollMs ?? 2000;
  const live = opts.slots ?? liveSlots; // injectable : les tests simulent une vague qui prend un créneau entre les deux comptées
  const checkAbandon = () => {
    const why = opts.abandon?.();
    if (why) throw new SlotAbandoned(why);
  };
  for (;;) {
    const limit = commonCap(liveWaves(home), cap); // relu à chaque tour : une vague au plafond bas qui s'arrête le relève
    if (reportedAt !== null) checkAbandon(); // pas à la première tentative : un créneau libre est pris même si une demande est posée
    // Les sessions du lead (`lead hold`) tournent hors de toute vague mais prennent un créneau : relues à chaque comptage (L424).
    const taken = () => live(home).length + liveHolds(home, new Date()).length;
    if (taken() < limit) {
      for (let k = 0; k < MAX_SLOT_INDEX; k++) {
        const file = join(slotsDir(home), `slot-${k}.lock`);
        const got = takeLock(file, { pid: process.pid, wave: opts.wave, started: new Date().toISOString() });
        if (!got.ok) continue;
        if (taken() <= limit) {
          if (reportedAt !== null) opts.onGot?.(now() - t0);
          return () => releaseLock(file, process.pid);
        }
        releaseLock(file, process.pid); // pris à plusieurs en même temps : on rend, on retente
        break;
      }
    }
    if (reportedAt === null) checkAbandon(); // la première tentative a échoué : l'attente commence, la demande déjà posée l'interrompt sans attendre un tour
    if (reportedAt === null || now() - reportedAt >= (opts.reportMs ?? WAIT_REPORT_MS)) {
      reportedAt = now();
      opts.onWait?.(live(home), reportedAt - t0, limit, liveHolds(home, new Date()));
    }
    await new Promise((r) => setTimeout(r, pollMs + Math.random() * pollMs * 0.25));
  }
}

/** .git commun du dépôt `dir` (partagé par ses worktrees), chemin réel (un lien symbolique vers le dépôt désigne le même) ; null si `dir` n'est pas un dépôt. */
const commonDir = (dir: string): string | null => {
  try {
    return realpathSync(gitCommonDir(dir));
  } catch {
    return null;
  }
};

/** Lots de la vague `pid` qui travaillent dans `repo` (ou l'un de ses worktrees), finis ou non ; null si l'état de la vague est illisible. */
export function waveLotsIn(home: string, pid: number, repo: string): LotState[] | null {
  try {
    const w = liveWaves(home).find((x) => x.pid === pid);
    const store = w && RunStore.find(w.cwd, w.wave);
    if (!store) return null;
    const mine = commonDir(repo);
    return store.lots().filter((l) => lotRepoPaths(l).some((r) => r === repo || (mine !== null && commonDir(r) === mine)));
  } catch {
    return null;
  }
}

/** Lots de la vague `pid` qui travaillent encore dans `repo` (en cours, en file ou suspendus) ; null si l'état de la vague est illisible. */
export function openLotsIn(home: string, pid: number, repo: string): string[] | null {
  return waveLotsIn(home, pid, repo)?.filter((l) => !lotFinished(l)).map((l) => lotKey(l.project, l.lot)) ?? null;
}

/** Une vague non terminée qui garde ouvert un lot encore en cours au plan du dépôt (L238). */
export interface OpenWave {
  wave: string;
  /** Dossier d'où la vague a été lancée : celui où `--resume` la retrouve. */
  launchDir: string;
  /** Le processus de la vague tourne encore (elle n'est pas suspendue : on attend sa fin). */
  live: boolean;
  /** Pid du processus de la vague, quand elle est vivante. */
  pid?: number;
  lots: { key: string; status: string }[];
  /** Les autres lots du dépôt que la vague garde ouverts sans être en cours au plan (en file, todo...) : le `--resume` les relancerait, ils reprendraient le verrou — la commande les retire aussi. */
  others: { key: string; status: string }[];
}

/**
 * Vagues non terminées (`done` exclu : interrompues, suspendues, ou vivantes) lancées depuis `launchDir` qui gardent ouvert (état non terminal : question, suspendu, en file, en cours...)
 * au moins un lot DU MÊME DÉPÔT que `repo` pour lequel `doing(lot)` est vrai (L238, `doing` : le lot est encore en cours au plan de ce dépôt). Un `--resume` rejouera ces lots sur ce dépôt :
 * un rescellé commité entre-temps leur serait rendu comme « premier commit fautif ». Un lot livré au plan (vieille vague abandonnée) ou absent du plan ne compte jamais.
 * Le dépôt d'un lot est celui de son projet (`lot.repo`), pas ses dépôts voisins : l'id d'un lot est propre au plan de son projet.
 */
export function openWavesIn(launchDir: string, repo: string, doing: (lot: LotState) => boolean, live: LiveWave[] = []): OpenWave[] {
  const base = RunStore.runsDir(launchDir);
  if (!existsSync(base)) return [];
  const mine = commonDir(repo);
  const out: OpenWave[] = [];
  for (const id of readdirSync(base).sort()) {
    try {
      const store = RunStore.find(launchDir, id);
      if (!store || store.readWave()?.status === 'done') continue;
      const open = store
        .lots()
        .filter((l) => !lotFinished(l) && (l.repo === repo || (mine !== null && commonDir(l.repo) === mine)))
        .map((l) => ({ in: doing(l), key: lotKey(l.project, l.lot), status: l.status }));
      const lots = open.filter((l) => l.in).map(({ key, status }) => ({ key, status }));
      const others = open.filter((l) => !l.in).map(({ key, status }) => ({ key, status }));
      const alive = live.find((w) => w.wave === id && w.cwd === launchDir);
      if (lots.length) out.push({ wave: id, launchDir, live: !!alive, ...(alive ? { pid: alive.pid } : {}), lots, others });
    } catch {
      // état illisible : une vague qu'on ne sait pas lire ne bloque pas un rescellé du lead
    }
  }
  return out;
}
