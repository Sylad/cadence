// Le plan en attente (L695, D-9) : `raf add|note|done|review|ux|demande` (L722) sur une branche tenue par un programme, puis `raf attente [appliquer]`.
import { checkRegistryWrite, isRegistryWrite } from './demande-commands.js';
import { checkGateUsage, reviewedAt, seenArgs } from './gates.js';
import { applyPending, deferPlanWrite, holderHere, PENDING_PLAN, readPending } from '../repo-held.js';
import { RafError } from '../plan.js';
import { buildCtx, type EarlyCtx, type Io } from './context.js';

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
 * Avant la mise en attente (revue L722 r1) : une écriture invalide est refusée tout de suite, elle ne bloquerait plus à l'application les écritures
 * qui la suivent ; une revue fige ce qu'elle a relu (le dernier commit du lot et des dépôts voisins), rend les options qui le disent.
 */
function checked(command: string, c: EarlyCtx): string[] {
  if (command === 'demande') {
    checkRegistryWrite(c);
    return [];
  }
  if (command !== 'review' && command !== 'ux') return [];
  checkGateUsage(command, c.rest);
  if (c.rest[0] === 'enable') return [];
  const plan = buildCtx({ ...c, command }).loadPlan();
  const verdict = c.rest.slice(1).join(' ');
  // Le plan refuse en mémoire, rien n'est sauvé : sous-tâche, verdict vide, lot inconnu, plan en lecture seule.
  if (command === 'ux') {
    plan.recordUx(c.rest[0]!, verdict, c.today);
    return [];
  }
  const at = reviewedAt(plan, c.root, c.rest[0]!);
  plan.recordReview(c.rest[0]!, verdict, c.today, at.commit, at.repos);
  return seenArgs(at);
}

/**
 * Une écriture du plan sur une branche tenue va dans le plan en attente (rend 0) ; sur une branche libre, l'attente laissée par un programme
 * qui ne l'a pas appliquée (arrêté en route) passe d'abord, puis la commande suit (rend null).
 */
export function heldPlanWrite(command: string, argv: string[], c: EarlyCtx, run: Run): number | null {
  if ((c.values.vu !== undefined || c.values['vu-depot']) && !applying) throw new RafError('--vu et --vu-depot sont réservés au plan en attente : la mise en attente d\'une revue les écrit, raf attente appliquer les lit');
  if (!DEFERRABLE.has(command) || applying || c.values.help || (command === 'demande' && !isRegistryWrite(c.rest))) return null;
  let holder;
  try {
    holder = holderHere(c.root);
  } catch {
    return null; // hors d'un dépôt git : rien ne peut le tenir
  }
  if (holder) {
    c.io.out(deferPlanWrite(c.root, holder, [...argv, ...checked(command, c)], c.io.now()));
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
