import { declaredFor, hasPaths, resourcesTouching, type Resources } from '../../resources.js';
import { INTEGRATE_POLL_MS } from '../integrate.js';
import { lotDiff, type LotDiff } from '../lot-diff.js';
import { lotKey, type LotState } from '../state.js';
import { lotBranch } from '../worktree.js';
import type { LotCtx } from './ctx.js';

/** Les status d'un lot qui travaille réellement (R10) : sa session écrit, corrige ou relit ; entre deux étapes il garde le status de sa dernière session. */
const WORKING: ReadonlySet<LotState['status']> = new Set(['implementing', 'fixing', 'reviewing']);

/**
 * Le lot travaille réellement (R10) : d'abord `next === 'integrate'` l'exclut (à l'intégration le lot garde le status `reviewing` de sa dernière session ;
 * l'attendre serait une attente circulaire, R9), puis le status : implementing, fixing ou reviewing. Queued (jamais démarré), question, suspended,
 * handed-back, failed et ready ne travaillent pas.
 */
export const works = (l: Pick<LotState, 'status' | 'next'>): boolean => l.next !== 'integrate' && WORKING.has(l.status);

/** Le lot plus ancien qui retient l'intégration (R8) : il touche par ses commits un chemin de `resource` que le diff du tardif touche aussi. */
export interface Blocking {
  lot: LotState;
  resource: string;
  path: string;
}

/** Reçoit un lot dont git n'a pas pu lire le diff et la cause (R12). */
export type Warn = (lot: LotState, cause: string) => void;

/**
 * Le premier lot plus ancien que le tardif `c` qui retient son intégration (R8), ou null. Les lots examinés (R10) : ceux de `c.wave.store.lots()`, relu à
 * chaque appel, placés AVANT le tardif dans cet ordre (l'ordre de lancement de la vague), du même dépôt, qui travaillent (`works`). Un ancien retient quand
 * son diff partiel « base..tête » (ses commits déjà faits, `diff`) touche un chemin d'une ressource que le diff complet du tardif touche. Sans ressource à
 * chemins ou sans worktree, rien n'est lu (R1). Un diff illisible (R12) est dit à `warn` : le tardif ne déduit rien, l'ancien ne retient pas.
 */
export function blockingOlder(c: LotCtx, declared: Resources, warn: Warn, diff: (repo: string, branch: string) => LotDiff = lotDiff): Blocking | null {
  if (!c.tree || !hasPaths(declared)) return null;
  const mine = diff(c.lot.repo, c.tree.branch);
  if (mine.failure !== null) warn(c.lot, mine.failure);
  const touched = resourcesTouching(declared, mine.files);
  if (touched.size === 0) return null;
  const all = c.wave.store.lots();
  const me = all.findIndex((l) => l.project === c.lot.project && l.lot === c.lot.lot);
  for (const o of all.slice(0, Math.max(me, 0)).filter((l) => l.repo === c.lot.repo && works(l))) {
    const d = diff(o.repo, lotBranch(c.wave.id, o.project, o.lot));
    if (d.failure !== null) {
      warn(o, d.failure);
      continue;
    }
    for (const [name, hit] of resourcesTouching(declared, d.files)) if (touched.has(name)) return { lot: o, resource: name, path: hit.path };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend, avant la prise du verrou d'intégration, la fin de tout lot plus ancien qui retient le tardif (R8, `blockingOlder`), en rejouant le contrôle toutes les
 * `integrate.pollMs` (R9) : sans borne de durée, tant que l'ancien travaille (INTEGRATE_WAIT_MS ne borne que le verrou fichier), et sans tenir le verrou du dépôt.
 * Journalise « <lot> intégration différée : <ancien> touche la ressource « <nom> » (<chemin>) » et les diffs illisibles (R12), chaque ligne une fois par appel.
 */
export async function awaitOlder(c: LotCtx): Promise<void> {
  const declared = declaredFor(c.lot.repo);
  if (!c.tree || !hasPaths(declared)) return;
  const said = new Set<string>();
  const say = (line: string): void => {
    if (said.has(line)) return;
    said.add(line);
    c.wave.log(line);
  };
  const warn: Warn = (l, cause) => say(`${lotKey(l.project, l.lot)} diff illisible (git : ${cause}) : aucune ressource déduite`);
  const pollMs = c.wave.integrate?.pollMs ?? INTEGRATE_POLL_MS;
  for (;;) {
    const b = blockingOlder(c, declared, warn);
    if (!b) return;
    say(`${lotKey(c.lot.project, c.lot.lot)} intégration différée : ${lotKey(b.lot.project, b.lot.lot)} touche la ressource « ${b.resource} » (${b.path})`);
    await sleep(pollMs);
  }
}
