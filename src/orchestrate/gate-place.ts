// Où une commande de la porte d'un lot tourne (L403) : sur l'hôte `orchestrate.gate.host` quand il répond et que l'hôte verrait ce qui est testé, sinon en local.
// Les décisions de verdict (rouge, ligne de base, rejeu seul) restent celles du cycle : ce module ne change que le lieu et ne rend jamais un 255 comme un résultat.

import type { OrchestrateConfig } from '../config.js';
import { GATE_TIMEOUT_MS, isSha, openRemoteGate, type Ran, type RemoteGate } from '../remote-gate.js';
import { configuredCap } from './command.js';
import { testWorkersFrom } from './workers.js';
import { trackedDirty, untrackedFiles } from './worktree.js';

/** Un lieu d'exécution : `run` joue une commande (la même signature que la commande locale du cycle), `close` retire le worktree de l'hôte. */
export interface Place {
  run(command: string): Promise<Ran>;
  /** Le lieu à inscrire avec le résultat d'un contrôle (hôte, sha court, cache) ; vide pour une porte locale, donc rien de plus dans l'état qu'avant. */
  stamp(): { lieu?: string };
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
}

const localPlace = (local: PlaceOpts['local']): Place => ({ run: local, stamp: () => ({}), close: () => {} });


/**
 * Ouvre le lieu de la porte. Sans `gate.host`, ou quand l'hôte ne peut pas porter la porte (arbre non validé R7, hôte injoignable, push ou cache impossible R4/R5), la porte est locale et la ligne dit pourquoi.
 * Sur l'hôte, un code 255 de ssh (connexion perdue) n'est jamais un résultat : la commande est rejouée en local, la ligne le dit, et le lieu reste local pour les commandes suivantes (R6).
 */
async function openPlace(o: PlaceOpts): Promise<Place> {
  const host = o.config.gate?.host;
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
  const env = o.env ?? process.env;
  const opened = await openRemoteGate({ host, install: o.config.gate?.install, refs: o.config.gate?.refs, repo: o.repo, sha: o.sha, depsFrom: o.repo, worktreeDeps: o.config.worktreeDeps, env, timeoutMs: GATE_TIMEOUT_MS, workers: (cores) => testWorkersFrom(env, cores, configuredCap(env)) });
  if (!opened.ok) {
    o.say(opened.stage === 'host' ? `${o.label} : porte déportée indisponible sur ${host} (${opened.cause}) — jouée en local` : `${o.label} : cache de dépendances impossible sur ${host} (${opened.cause}) — jouée en local`);
    return localPlace(o.local);
  }
  const gate: RemoteGate = opened.gate;
  let lost = false;
  const where = `hôte ${host}, sha ${o.sha.slice(0, 7)}, ${gate.cache}`;
  o.say(`${o.label} : porte jouée sur l'hôte ${host} (sha ${o.sha.slice(0, 7)}, ${gate.cache})`);
  return {
    run: async (command) => {
      if (lost) return o.local(command);
      const r = await gate.run(command, GATE_TIMEOUT_MS);
      if (!r.lost) return r;
      lost = true;
      o.say(`${o.label} : connexion perdue avec ${host} pendant la porte — rejouée en local${o.detail ? ` ${o.detail}` : ''}`);
      return o.local(command);
    },
    stamp: () => ({ lieu: lost ? `local (connexion perdue avec ${host})` : where }),
    close: () => {
      const orphan = gate.close();
      if (orphan) o.say(`${o.label} : nettoyage de l'hôte ${host} en échec (${orphan}) — le worktree orphelin y sera retiré au prochain appel`);
    },
  };
}

/** Joue `fn` dans le lieu de la porte et retire le worktree de l'hôte quoi qu'il arrive (R10). */
export async function withPlace<T>(o: PlaceOpts, fn: (place: Place) => Promise<T>): Promise<T> {
  const place = await openPlace(o);
  try {
    return await fn(place);
  } finally {
    place.close();
  }
}
