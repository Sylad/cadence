// Le plan en attente (L695, D-9) : `raf add|note|done|review|ux|demande` (L722) sur une branche tenue par un programme, puis `raf attente [appliquer]`.
import { isRegistryWrite } from './demande-commands.js';
import { applyPending, deferPlanWrite, holderHere, PENDING_PLAN, readPending } from '../repo-held.js';
import { RafError } from '../plan.js';
import type { EarlyCtx, Io } from './context.js';

type Run = (argv: string[], io: Io) => number | Promise<number>;

// L722 : review et ux écrivaient le plan de l'arbre principal pendant qu'un run le tenait ; demande écrit le registre, commité avec le code.
const DEFERRABLE = new Set(['add', 'note', 'done', 'review', 'ux', 'demande']);
let applying = false;

/** Joue les écritures en attente avec `run` (des commandes synchrones : add, note, done, review, ux, demande). */
function apply(root: string, io: Io, run: Run): number {
  applying = true;
  try {
    return applyPending(root, (argv) => {
      const code = run(argv, io);
      return typeof code === 'number' ? code : 1;
    }, io.out);
  } finally {
    applying = false;
  }
}

/**
 * Une écriture du plan sur une branche tenue va dans le plan en attente (rend 0) ; sur une branche libre, l'attente laissée par un programme
 * qui ne l'a pas appliquée (arrêté en route) passe d'abord, puis la commande suit (rend null).
 */
export function heldPlanWrite(command: string, argv: string[], c: EarlyCtx, run: Run): number | null {
  if (!DEFERRABLE.has(command) || applying || c.values.help || (command === 'demande' && !isRegistryWrite(c.rest))) return null;
  let holder;
  try {
    holder = holderHere(c.root);
  } catch {
    return null; // hors d'un dépôt git : rien ne peut le tenir
  }
  if (holder) {
    c.io.out(deferPlanWrite(c.root, holder, argv, c.io.now()));
    return 0;
  }
  if (readPending(c.root).length > 0) apply(c.root, c.io, run);
  return null;
}

/** raf attente : les écritures en attente ; raf attente appliquer : les joue (refusé tant que la branche est tenue). */
export function cmdAttente(c: EarlyCtx, run: Run): number {
  const { rest, root, io } = c;
  if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== 'appliquer')) throw new RafError('usage : raf attente [appliquer]');
  const all = readPending(root);
  if (rest[0] === undefined) {
    if (all.length === 0) io.out(`rien en attente (${PENDING_PLAN} absent)`);
    for (const w of all) io.out(`${w.date.slice(0, 16).replace('T', ' ')}  raf ${w.argv.join(' ')}  (tenu par ${w.tenu})`);
    return 0;
  }
  const holder = holderHere(root);
  if (holder) throw new RafError(`attente appliquer refusé : la branche ${holder.branch} est encore tenue par ${holder.label} (pid ${holder.pid}) — il l'appliquera en rendant le dépôt`);
  if (all.length === 0) {
    io.out('rien en attente');
    return 0;
  }
  return apply(root, io, run);
}
