import { basename, join } from 'node:path';
import { sharedStateDir } from '../../state.js';
import { installPrePush, keepGateGuard, removePrePush, type Snapshot } from '../guard.js';
import { REPO_LOCK, releaseLock, takeLock } from '../lock.js';
import { updateWaveRepos, unregisterWave } from '../registry.js';
import { leadMoved } from './plan-writes.js';
import type { RepoClaim, WaveCtx } from './ctx.js';

/** La vague qui tient un dépôt (verrou d'orchestration). */
interface Holder {
  wave: string;
  pid: number;
}

interface RepoHoldsCtx {
  waveId: string;
  /** `~/.cadence` : le registre des vagues vivantes. */
  home: string;
  /** Fichiers de verrou que la vague tient. */
  held: string[];
  /** Dépôts que la vague a libérés (L132). */
  freed: Set<string>;
  /** Dépôts de la vague (verrou, garde de push, inscription) ; un dépôt partagé pris à la libération de sa porteuse s'y ajoute. */
  repos: string[];
  /** L553 : dépôts qu'une autre vague vivante tient encore, où la reprise n'intègre que, par porteuse. */
  shared: Map<string, Holder>;
  lanes: () => number | undefined;
  log: (line: string) => void;
}

/** Le registre des vagues vivantes : dépôts tenus et créneaux occupés ; illisible, le décompte reste celui du dernier écrit. */
export function updateWaveReposSafe(home: string, repos: string[], lanes: number | undefined): void {
  try {
    updateWaveRepos(home, process.pid, repos, lanes);
  } catch {
    // registre illisible : le décompte reste celui du dernier écrit
  }
}

/**
 * Ce que la vague tient sur ses dépôts : `freeRepo` libère un dépôt (verrou et garde de push, L132 : dès que ses lots sont finis, pas à la fin de la vague), `release` tout rend à la fin,
 * `claimRepo` (L553) dit où en est un dépôt partagé avec une autre vague vivante et le prend (verrou, garde de push, inscription au registre) dès que cette vague l'a libéré :
 * sinon `deliver`, une nouvelle vague ou une tâche locale pourrait l'écrire sous l'intégration de la reprise, qui n'y est pas inscrite. Pris par un tiers entre-temps : `taken`, rien n'y est écrit.
 */
export function repoHolds(o: RepoHoldsCtx): { freeRepo: (r: string) => void; release: () => void; claimRepo: (r: string) => RepoClaim } {
  const lock = (r: string) => join(sharedStateDir(r), REPO_LOCK);
  const freeRepo = (r: string) => {
    o.freed.add(r);
    const file = lock(r);
    releaseLock(file, process.pid);
    o.held.splice(0, o.held.length, ...o.held.filter((f) => f !== file));
    removePrePush(r, o.waveId);
    keepGateGuard(r);
    try {
      updateWaveRepos(o.home, process.pid, o.repos.filter((x) => !o.freed.has(x)), o.lanes());
    } catch {
      // registre illisible : `--status` garde la liste de départ, le verrou est bien tombé
    }
  };
  const release = () => {
    for (const f of o.held) releaseLock(f, process.pid);
    o.held.length = 0;
    for (const r of o.repos) {
      if (o.freed.has(r)) continue;
      removePrePush(r, o.waveId);
      keepGateGuard(r);
    }
    try {
      unregisterWave(o.home, process.pid);
    } catch {
      // registre illisible : l'entrée d'un processus mort est écartée à la prochaine inscription
    }
  };
  const claimRepo = (r: string): RepoClaim => {
    const freed = o.shared.get(r);
    if (!freed) return { kind: 'kept' };
    const l = takeLock(lock(r), { pid: process.pid, wave: o.waveId, started: new Date().toISOString() });
    if (!l.ok) return l.held.wave === freed.wave && l.held.pid === freed.pid ? { kind: 'passing', holder: freed } : { kind: 'taken', freed, holder: { wave: l.held.wave, pid: l.held.pid } };
    o.held.push(lock(r));
    o.shared.delete(r);
    o.repos.push(r);
    const hook = installPrePush(r, o.waveId);
    if (!hook.ok) o.log(`orchestrate : ${basename(r)} : ${hook.reason}`);
    updateWaveReposSafe(o.home, o.repos.filter((x) => !o.freed.has(x)), o.lanes());
    o.log(`orchestrate : ${basename(r)} : libéré par la vague ${freed.wave} pendant l'intégration : la reprise le prend (verrou et garde de push)`);
    return { kind: 'claimed', freed };
  };
  return { freeRepo, release, claimRepo };
}

/**
 * La garde de push a-t-elle disparu pendant une session, et est-ce un incident ? Oui quand elle était celle de la vague. Sur un dépôt partagé (L553) c'est la vague porteuse qui a libéré le dépôt :
 * la vague le prend (`claimRepo`), ou note qu'un tiers l'a pris (`note`, l'intégration refusera l'avance), et rien n'est un incident.
 */
export function guardLost(w: WaveCtx, repo: string, before: Snapshot, after: Snapshot, note: (text: string) => void): boolean {
  if (!before.guard || after.guard) return false;
  const claim = w.claimRepo?.(repo) ?? { kind: 'kept' };
  if (claim.kind === 'taken') note(`${basename(repo)} libéré par la vague ${claim.freed.wave} puis pris par ${claim.holder.wave} (pid ${claim.holder.pid})`);
  return claim.kind === 'kept';
}

/**
 * Refus juste avant l'avance de la branche du dépôt : le lead a changé de branche ou sali son arbre (R24, R8), ou (L553) un tiers a pris le dépôt que la vague porteuse a libéré pendant
 * l'intégration — une reprise qui intègre entre les étapes d'une autre vague n'avance la branche que si cette vague tient encore le dépôt, ou si la reprise l'a pris à sa libération. null : rien ne s'oppose à l'avance.
 */
export function lateRefusal(w: WaveCtx, repo: string, base: string): string | null {
  const moved = leadMoved(repo, base);
  if (moved) return moved;
  const claim = w.claimRepo?.(repo);
  return claim?.kind === 'taken' ? `le dépôt, libéré par la vague ${claim.freed.wave}, est tenu par ${claim.holder.wave} (pid ${claim.holder.pid})` : null;
}
