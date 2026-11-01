import { join } from 'node:path';
import type { Day } from './dates.js';
import { REPO_LOCK, activeLock, releaseLock, takeLock } from './orchestrate/lock.js';
import { Plan, RafError } from './plan.js';
import { readStat } from './proc.js';
import { tryGit } from './git.js';
import { sharedStateDir } from './state.js';

/** Nom de « vague » sous lequel la tâche locale d'un lot tient le verrou du dépôt : les refus des vagues le citent tel quel. */
export const localWave = (lot: string): string => `local:${lot}`;

export interface LocalDeps {
  /** Le processus qui porte le verrou : tant qu'il vit, le dépôt est tenu (`ownerPid`). */
  pid: number;
  today: Day;
  now: () => Date;
  /** La porte du projet (`orchestrate.build` puis `orchestrate.test`) au HEAD : 0 vert, 1 rouge, 2 rien à rejouer. */
  gate: () => Promise<number>;
  out: (line: string) => void;
  err: (line: string) => void;
}

type Stat = (pid: number) => { name: string; ppid: number } | null;

/**
 * Le porteur du verrou d'une tâche locale. Le shell qui lance la commande ne dure qu'un appel (celui de l'outil Bash de Claude Code) : son parent direct ne porterait
 * le verrou que le temps de la commande. Le porteur est donc le premier ancêtre nommé `claude` (la session du lead) ; sans lui (terminal, autre système), le parent direct.
 */
export function ownerPid(from: number = process.ppid, stat: Stat = (pid) => readStat('/proc', pid)): number {
  let pid = from;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const st = stat(pid);
    if (!st) break;
    if (st.name === 'claude') return pid;
    pid = st.ppid;
  }
  return from;
}

const lockFile = (repo: string): string => join(sharedStateDir(repo), REPO_LOCK);

/**
 * `cadence local start <lot>` : le lead va modifier lui-même ce dépôt pour un lot marqué `local`. Le dépôt est verrouillé comme par une vague (aucune vague n'y démarre,
 * `--add` y est refusé par le même contrôle de dépôt) et le lot passe à `doing`. Refus (`RafError`, rien n'est verrouillé ni écrit ; si l'écriture du plan échoue, le verrou pris est relâché) : lot inconnu, non marqué local, déjà
 * fini, une orchestration ou une autre tâche locale qui tient le dépôt, un autre lot du dépôt en cours.
 */
export function startLocal(repo: string, plan: Plan, lotId: string, d: Pick<LocalDeps, 'pid' | 'today' | 'now'>): void {
  const lot = plan.lots().find((l) => l.id === lotId);
  if (!lot) throw new RafError(`lot inconnu : ${lotId}`);
  if (!lot.local) throw new RafError(`${lotId} n'est pas marqué local : le lead ne modifie pas lui-même le dépôt pour un lot de vague (raf add --local pour en créer un)`);
  if (lot.status === 'done' || lot.status === 'dropped') throw new RafError(`${lotId} est ${lot.status} : une tâche locale ne reprend pas un lot fini`);
  const held = activeLock(lockFile(repo));
  if (held) {
    throw new RafError(held.wave === localWave(lotId) ? `${lotId} : la tâche locale est déjà en cours (pid ${held.pid})` : `${repoName(repo)} : une orchestration y est déjà en cours (${held.wave}, pid ${held.pid}) — attendre sa fin`);
  }
  const others = plan.lots().filter((l) => l.status === 'doing' && l.id !== lotId);
  if (others.length) throw new RafError(`${repoName(repo)} : un lot du dépôt est en cours (${others.map((l) => l.id).join(', ')}) — le finir, ou raf todo, avant la tâche locale`);
  const taken = takeLock(lockFile(repo), { pid: d.pid, wave: localWave(lotId), started: d.now().toISOString() });
  if (!taken.ok) throw new RafError(`${repoName(repo)} : une orchestration y est déjà en cours (${taken.held.wave}, pid ${taken.held.pid}) — attendre sa fin`);
  if (lot.status === 'todo') {
    try {
      plan.setStatus(lotId, 'doing', d.today);
      plan.save();
    } catch (e) {
      releaseLock(lockFile(repo), d.pid);
      throw e;
    }
  }
}

/**
 * `cadence local done <lot>` : la tâche locale du lead est finie. La porte du projet est jouée UNE fois ; verte, le verrou tombe (la capture, la livraison et `raf done`
 * restent au lead, dans cet ordre) ; rouge ou sans verdict, le verrou reste : le lead corrige et rejoue. Refus (`RafError`) quand ce n'est pas la tâche locale de ce lot qui tient le dépôt.
 */
export async function finishLocal(repo: string, lotId: string, d: LocalDeps): Promise<number> {
  const held = activeLock(lockFile(repo));
  if (!held || held.wave !== localWave(lotId)) throw new RafError(`aucune tâche locale en cours pour ${lotId} (cadence local start ${lotId})`);
  const code = await d.gate();
  if (code === 1) {
    d.err(`${lotId} : porte rouge — le dépôt reste verrouillé ; corriger, puis cadence local done ${lotId}`);
    return 1;
  }
  if (code !== 0) {
    d.err(`${lotId} : la porte n'a rien rejoué (orchestrate.build / orchestrate.test absents ?) — le dépôt reste verrouillé`);
    return 2;
  }
  releaseLock(lockFile(repo), held.pid);
  d.out(`${lotId} : porte verte, dépôt libéré. Suite : la capture d'un lot visible, cadence deliver, puis raf done ${lotId}`);
  return 0;
}

const repoName = (repo: string): string => repo.split('/').filter(Boolean).pop() ?? repo;

/** `cadence local start|done <lot>` : l'analyse de la commande, puis `startLocal` ou `finishLocal` ; `gate(sha)` joue la porte du projet au sha. */
export async function localCommand(rest: string[], c: { repo: string; loadPlan: () => Plan; gate: (sha: string) => Promise<number> } & Omit<LocalDeps, 'pid' | 'gate'>): Promise<number> {
  if (rest.length !== 2 || (rest[0] !== 'start' && rest[0] !== 'done')) throw new RafError('usage : cadence local start <lot> | cadence local done <lot>');
  const [sub, lot] = rest as ['start' | 'done', string];
  const deps: LocalDeps = { ...c, pid: ownerPid(), gate: () => c.gate(tryGit(c.repo, ['rev-parse', 'HEAD']) ?? 'HEAD') };
  if (sub === 'done') return finishLocal(c.repo, lot, deps);
  startLocal(c.repo, c.loadPlan(), lot, deps);
  c.out(`${lot} : dépôt verrouillé (tâche locale, pid ${deps.pid}) — aucune vague n'y démarre ; à la fin : cadence local done ${lot}`);
  return 0;
}
