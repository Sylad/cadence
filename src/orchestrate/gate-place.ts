// Où une commande de la porte d'un lot tourne (L403) : sur l'hôte `orchestrate.gate.host` quand il répond et que l'hôte verrait ce qui est testé, sinon en local.
// Avec `gate.overflow` (L639), la machine libre : le local d'abord (une porte à la fois), l'hôte en débordement, son état décidé une fois par lot.
// Les décisions de verdict (rouge, ligne de base, rejeu seul) restent celles du cycle : ce module ne change que le lieu et ne rend jamais un 255 comme un résultat.

import type { OrchestrateConfig } from '../config.js';
import { GATE_TIMEOUT_MS, isSha, openRemoteGate, preflightHost, type HostProbe, type Ran, type RemoteGate } from '../remote-gate.js';
import { configuredCap } from './command.js';
import { GATE_HOST_DEFAULT, GATE_LOCAL_LIMIT, hostGates, localGates, type Turn } from './gate-host-slots.js';
import { testWorkersFrom } from './workers.js';
import { trackedDirty, untrackedFiles } from './worktree.js';

/** Un lieu d'exécution : `run` joue une commande (la même signature que la commande locale du cycle), `close` retire le worktree de l'hôte. */
export interface Place {
  run(command: string): Promise<Ran>;
  /** Le lieu à inscrire avec le résultat d'un contrôle (hôte, sha court, cache) ; vide pour une porte locale, donc rien de plus dans l'état qu'avant. */
  stamp(): { lieu?: string };
  /** Vrai tant que les commandes tournent sur l'hôte (L624) : faux pour une porte locale et, une fois la connexion perdue, pour la commande rejouée ici. */
  remote(): boolean;
  close(): void;
}

export interface PlaceOpts {
  config: OrchestrateConfig;
  /** Dépôt du projet : porte le sha, et les dépendances non suivies à copier. */
  repo: string;
  /** Le sha à jouer sur l'hôte ; null (HEAD illisible) : la porte est locale. */
  sha: string | null;
  /** Dossier local de ce sha. Avec `needClean`, il doit être propre : l'hôte ne verrait pas ses modifications non validées (R7). */
  dir: string;
  needClean: boolean;
  /** Début des lignes dites : « porte du lot L1 ». */
  label: string;
  /** Ce qui précise la ligne de repli (ex. « (ligne de base ab12cd3) ») ; vide pour la porte du lot. */
  detail?: string;
  /** La commande locale, utilisée sans hôte et pour le rejeu après une connexion perdue. */
  local: (command: string) => Promise<Ran>;
  /** Dit une ligne dans la sortie et le journal de la vague. */
  say: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** Le lot dont c'est la porte (L624) : un lieu ouvert pour un lot dont une porte tient déjà un tour de l'hôte (ligne de base jouée pendant la porte) ne reprend pas de tour, il attendrait la porte qui l'attend. Absent : tour propre. */
  owner?: object;
  /** Dit au lot que la porte attend un créneau de porte sur l'hôte (L624, `gate.maxParallel`) : il n'occupe alors ni session ni processeur local, et le note dans son état. Appelé une fois, seulement quand il faut attendre. */
  onWait?: () => void;
  /** Dit au lot que les commandes de ce lieu tournent ici et non sur l'hôte alors qu'il pouvait l'en croire (L624) : repli à l'ouverture (hôte injoignable, cache impossible) ou connexion perdue, avant le rejeu local. Pas appelé pour une porte locale d'emblée (sans hôte, arbre non validé). */
  onLocal?: () => void;
  /** Journal du temps de porte (L627) : « porte : début » et « porte : fin », à part de `say` (une porte locale n'y dit rien d'autre). Absent : rien n'est écrit. */
  trace?: (line: string) => void;
}

const localPlace = (local: PlaceOpts['local']): Place => ({ run: local, stamp: () => ({}), remote: () => false, close: () => {} });


/** Le tour que la porte d'un lot tient : leurs lieux ouverts pendant ce temps (ligne de base) ne reprennent pas de tour. */
type Held = 'local' | 'host';
const holding = new WeakMap<object, Held>();

/** Inscrit le tour tenu par le lot (`owner`) ; rend sa libération, sans effet la seconde fois. */
function hold(o: PlaceOpts, kind: Held, free: () => void): () => void {
  const owner = o.owner;
  if (owner) holding.set(owner, kind);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (owner && holding.get(owner) === kind) holding.delete(owner);
    free();
  };
}

const waitingLine = (o: PlaceOpts, host: string, limit: number) => `${o.label} : en attente d'un créneau de porte sur ${host} (${limit} porte(s) simultanée(s) au plus)`;

/** L624 : l'hôte a sa borne de portes simultanées ; la porte qui attend son tour le dit (journal et `onWait`). Rend la libération du tour, que la porte d'un lot tient pour ses lieux imbriqués (`owner`). */
async function takeHostTurn(o: PlaceOpts, host: string): Promise<() => void> {
  if (o.owner && holding.has(o.owner)) return () => {};
  const limit = o.config.gate?.maxParallel ?? GATE_HOST_DEFAULT;
  const turn = hostGates(host).request(limit);
  if (!turn.started()) (o.say(waitingLine(o, host, limit)), o.onWait?.());
  return hold(o, 'host', await turn.promise);
}

/** L'état de l'hôte de débordement pour un lot (L639, R5) : joignable (sa sonde) ou indisponible (étape et cause) ; `said` : la ligne de repli est déjà dite. */
interface HostDecision {
  up: boolean;
  probe?: HostProbe;
  stage?: 'host' | 'cache';
  cause?: string;
  said: boolean;
}

/** Une décision par lot (clé : `owner`) ; sans `owner`, rien n'est gardé (R5). Une seule promesse, donc une seule sonde, même pour des demandes simultanées. */
const decisions = new WeakMap<object, Promise<HostDecision>>();

function decide(o: PlaceOpts, host: string): Promise<HostDecision> {
  const known = o.owner && decisions.get(o.owner);
  if (known) return known;
  const decided = preflightHost(host, o.env ?? process.env).then((r): HostDecision => (typeof r === 'string' ? { up: false, stage: 'host', cause: r, said: false } : { up: true, probe: r, said: false }));
  if (o.owner) decisions.set(o.owner, decided);
  return decided;
}

/** Hôte devenu inutilisable pour le lot (push, cache ou connexion) : les lieux suivants ne le retentent pas. */
function markDown(d: HostDecision, stage: 'host' | 'cache', cause: string): void {
  d.up = false;
  d.stage = stage;
  d.cause = cause;
}

/** La ligne de repli (R7), une fois par lot ; le lieu rejoue ensuite en local. */
function sayDown(o: PlaceOpts, host: string, d: HostDecision): void {
  o.onLocal?.(); // la ligne de base d'une porte sur l'hôte tourne alors ici : le lot reprend sa file du pool le temps qu'elle dure
  if (d.said) return;
  d.said = true;
  o.say(d.stage === 'cache' ? `${o.label} : cache de dépendances impossible sur ${host} (${d.cause}) — jouée en local` : `${o.label} : porte déportée indisponible sur ${host} (${d.cause}) — jouée en local`);
}

const localTurnPlace = (o: PlaceOpts, free: () => void): Place => ({ ...localPlace(o.local), close: hold(o, 'local', free) });

/** Le tour local, attendu s'il est tenu (hôte indisponible : la porte attend la machine locale). */
async function waitLocal(o: PlaceOpts, turn: Turn): Promise<Place> {
  if (!turn.started()) o.onWait?.();
  return localTurnPlace(o, await turn.promise);
}

/** Ouvre le worktree de l'hôte et rend le lieu, ou null (décision passée à indisponible, tour de l'hôte rendu) ; `release` libère le tour de l'hôte. */
async function openHost(o: PlaceOpts, host: string, d: HostDecision | null, release: () => void): Promise<Place | null> {
  const env = o.env ?? process.env;
  const opened = await openRemoteGate({ host, install: o.config.gate?.install, refs: o.config.gate?.refs, repo: o.repo, sha: o.sha!, depsFrom: o.repo, worktreeDeps: o.config.worktreeDeps, env, timeoutMs: GATE_TIMEOUT_MS, workers: (cores) => testWorkersFrom(env, cores, configuredCap(env)), ...(d?.probe ? { probed: d.probe } : {}) });
  if (!opened.ok) {
    release();
    const down = d ?? { up: false, said: false };
    // R7 : avec overflow, un échec de push garde la ligne du cache ; gate.host garde sa ligne « porte déportée indisponible ».
    markDown(down, opened.stage === 'push' ? (d ? 'cache' : 'host') : opened.stage, opened.cause);
    sayDown(o, host, down);
    return null;
  }
  const gate: RemoteGate = opened.gate;
  let lost = false;
  const where = `hôte ${host}, sha ${o.sha!.slice(0, 7)}, ${gate.cache}`;
  o.say(`${o.label} : porte jouée sur l'hôte ${host} (sha ${o.sha!.slice(0, 7)}, ${gate.cache})`);
  return {
    run: async (command) => {
      if (!lost && d && !d.up) {
        // R8 : une ligne de base imbriquée a perdu la connexion (elle a dit la ligne) : la porte du lot ne retente pas l'hôte.
        lost = true;
        release();
        o.onLocal?.();
      }
      if (lost) return o.local(command);
      const r = await gate.run(command, GATE_TIMEOUT_MS);
      if (!r.lost) return r;
      lost = true;
      release(); // la commande rejouée ici ne pèse plus sur l'hôte
      if (d) {
        markDown(d, 'host', `connexion perdue avec ${host}`);
        d.said = true; // la ligne « connexion perdue » ci-dessous tient lieu de ligne de repli
      }
      o.onLocal?.(); // ni « sur l'hôte » pour le pool : elle pèse sur la machine
      o.say(`${o.label} : connexion perdue avec ${host} pendant la porte — rejouée en local${o.detail ? ` ${o.detail}` : ''}`);
      return o.local(command);
    },
    stamp: () => ({ lieu: lost ? `local (connexion perdue avec ${host})` : where }),
    remote: () => !lost,
    close: () => {
      release();
      const orphan = gate.close();
      if (orphan) o.say(`${o.label} : nettoyage de l'hôte ${host} en échec (${orphan}) — le worktree orphelin y sera retiré au prochain appel`);
    },
  };
}

/**
 * La porte avec `gate.overflow` (L639) : la machine locale d'abord (une porte à la fois), l'hôte en débordement, l'état de l'hôte décidé une fois par lot.
 * Un lot qui tient déjà un tour garde sa machine pour ses lieux imbriqués (ligne de base) : le tour local sans nouveau tour, l'hôte sans nouveau tour ni nouvelle sonde.
 */
async function openOverflow(o: PlaceOpts, host: string): Promise<Place> {
  const held = o.owner ? holding.get(o.owner) : undefined;
  if (held) return nestedOverflow(o, host, held);
  const local = localGates().request(GATE_LOCAL_LIMIT);
  if (local.started()) return playLocal(o, await local.promise);
  const d = await decide(o, host);
  if (!d.up) {
    sayDown(o, host, d);
    return waitLocal(o, local);
  }
  const limit = o.config.gate?.maxParallel ?? GATE_HOST_DEFAULT;
  const remote = hostGates(host).request(limit);
  if (!local.started() && !remote.started()) (o.say(waitingLine(o, host, limit)), o.onWait?.());
  const won = await Promise.race([local.promise.then((free) => ({ local: true, free })), remote.promise.then((free) => ({ local: false, free }))]);
  (won.local ? remote : local).cancel();
  if (won.local) return playLocal(o, won.free);
  const placed = await openHost(o, host, d, hold(o, 'host', won.free));
  return placed ?? waitLocal(o, localGates().request(GATE_LOCAL_LIMIT));
}

/** Le tour local obtenu : la porte joue ici, et le dit. */
function playLocal(o: PlaceOpts, free: () => void): Place {
  o.say(`${o.label} : jouée en local, machine locale libre`);
  return localTurnPlace(o, free);
}

/** Un lieu ouvert pour un lot qui tient déjà un tour : le tour local sans nouveau tour, l'hôte sans nouveau tour ni nouvelle sonde tant que la décision du lot le dit joignable. */
async function nestedOverflow(o: PlaceOpts, host: string, held: Held): Promise<Place> {
  if (held === 'local') return localPlace(o.local);
  const d = await decisions.get(o.owner!);
  return (d?.up ? await openHost(o, host, d, () => {}) : null) ?? localPlace(o.local);
}

/**
 * Ouvre le lieu de la porte. Sans `gate.host` ni `gate.overflow`, ou quand l'hôte ne peut pas porter la porte (arbre non validé R7, hôte injoignable, push ou cache impossible R4/R5), la porte est locale et la ligne dit pourquoi.
 * Sur l'hôte, un code 255 de ssh (connexion perdue) n'est jamais un résultat : la commande est rejouée en local, la ligne le dit, et le lieu reste local pour les commandes suivantes (R6).
 */
async function openPlace(o: PlaceOpts): Promise<Place> {
  const host = o.config.gate?.host ?? o.config.gate?.overflow;
  // Aucune commande de porte déclarée : rien à jouer, ni sonde ni worktree sur l'hôte.
  if (!host || !o.sha || !(o.config.build || o.config.test)) return localPlace(o.local);
  if (o.needClean) {
    const dirty = [...trackedDirty(o.dir), ...untrackedFiles(o.dir)];
    if (dirty.length) {
      o.say(`${o.label} : worktree non validé, jouée en local (l'hôte ne verrait pas les modifications)`);
      return localPlace(o.local);
    }
  }
  if (!isSha(o.sha)) {
    o.say(`${o.label} : sha invalide pour la porte déportée (hexadécimal attendu), jouée en local`);
    return localPlace(o.local);
  }
  if (o.config.gate?.overflow) return openOverflow(o, host);
  const release = await takeHostTurn(o, host);
  return (await openHost(o, host, null, release)) ?? localPlace(o.local);
}

/** Joue `fn` dans le lieu de la porte et retire le worktree de l'hôte quoi qu'il arrive (R10). */
export async function withPlace<T>(o: PlaceOpts, fn: (place: Place) => Promise<T>): Promise<T> {
  const place = await openPlace(o); // attend le tour de l'hôte : la file n'est pas du temps de porte
  // L627 : le début (une fois le tour obtenu) et la fin de chaque porte au journal, pour que `cadence inspect` isole le temps de porte de celui des sessions et de la file.
  o.trace?.(`porte : début${o.detail ? ` ${o.detail}` : ''}`);
  try {
    return await fn(place);
  } finally {
    place.close();
    o.trace?.(`porte : fin${o.detail ? ` ${o.detail}` : ''}`);
  }
}
