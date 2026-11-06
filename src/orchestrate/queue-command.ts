import { LOT_LIKE } from './command-args.js';
import { QUEUE_KEY, queueVerdict, resolveQueueLot } from './continue.js';
import { cadenceHome } from './registry.js';
import { effectiveState, entriesOf, orphaned, QueueError, readQueue, updateQueue, type QueueEntry } from './queue.js';

/** Ce que la commande `orchestrate queue` a besoin du programme : sa sortie, son dossier de lancement, et le délai du verrou (réglable pour les tests). */
export interface QueueIo {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  lockMs?: number;
}

/** Erreur « log error » de la commande : son message va sur la sortie d'erreur, la commande termine avec le code 1 (A1, A3). */
class QueueRefusal extends Error {}

const SUBCOMMANDS = 'add, show ou drop';

/** Le titre d'un lot de la file, vide quand le lot n'est plus lisible. */
function titleOf(launch: string, key: string): string | undefined {
  const ref = resolveQueueLot(launch, key);
  return 'lot' in ref ? ref.lot.title : undefined;
}

const listing = (launch: string, entries: QueueEntry[]): string[] => entriesOf(entries, launch).map((e, i) => `${i + 1}. ${e.key} — ${titleOf(launch, e.key) ?? 'lot introuvable'}`);

function add(io: QueueIo, keys: string[], home: string): string[] {
  if (keys.length === 0) throw new QueueRefusal('queue add : aucun lot donné (attendu : <projet:lot>…)');
  // tout est vérifié avant d'écrire : un refus laisse la file telle quelle (R2)
  for (const key of keys) {
    if (!QUEUE_KEY.test(key)) throw new QueueRefusal(`queue add : ${key} : clé mal formée (attendu : <projet:lot>)`);
    const ref = resolveQueueLot(io.cwd, key);
    if ('cause' in ref) throw new QueueRefusal(`queue add : ${key} : lot ou projet inconnu`);
    if (ref.lot.status === 'done' || ref.lot.status === 'dropped') throw new QueueRefusal(`queue add : ${key} : lot déjà terminé`);
  }
  const warnings: string[] = [];
  const entries = updateQueue(
    home,
    (all) => {
      for (const key of keys) {
        const mine = entriesOf(all, io.cwd);
        const at = mine.findIndex((e) => e.key === key);
        if (at >= 0) warnings.push(`queue add : ${key} : déjà en file (position ${at + 1})`);
        else all.push({ key, dir: io.cwd, state: 'pending' });
      }
      return [...all];
    },
    io.lockMs,
  );
  for (const w of warnings) io.err(w);
  return listing(io.cwd, entries);
}

function show(io: QueueIo, home: string): string[] {
  const mine = entriesOf(readQueue(home), io.cwd);
  if (mine.length === 0) return ['file approuvée vide : approuver des lots avec orchestrate queue add <projet:lot>'];
  return mine.map((e, i) => {
    const title = titleOf(io.cwd, e.key) ?? 'lot introuvable';
    return `${i + 1}. ${e.key} — ${title} — ${stateText(io.cwd, e, home)}`;
  });
}

/** « en attente », « réservé par la vague <id> », « tiré par la vague <id> », ou « sauté : <cause> » quand un lot en attente n'est pas mûr à cet instant (R4, R14, R15). */
function stateText(launch: string, e: QueueEntry, home: string): string {
  if (e.state === 'drawn') return `tiré par la vague ${e.wave}`;
  if (effectiveState(e) === 'reserved') return `réservé par la vague ${e.wave}`;
  const v = queueVerdict(e.key, launch, { home, remaining: Infinity });
  const base = 'cause' in v ? `sauté : ${v.cause}` : 'en attente';
  return orphaned(e) ? `${base} (réservation orpheline de la vague ${e.wave}, reprise au prochain tirage)` : base;
}

function drop(io: QueueIo, keys: string[], home: string): string[] {
  const entries = updateQueue(
    home,
    (all) => {
      const mine = entriesOf(all, io.cwd);
      // refus en bloc : toutes les clés sont vérifiées avant de retirer la première
      for (const key of keys) {
        const e = mine.find((x) => x.key === key);
        if (!e) throw new QueueRefusal(`queue drop : ${key} : absent de la file`);
        if (effectiveState(e) !== 'pending') throw new QueueRefusal(`queue drop : ${key} : déjà tiré par la vague ${e.wave}`);
      }
      const gone = new Set(keys);
      const rest = all.filter((e) => !(e.dir === io.cwd && gone.has(e.key)));
      all.splice(0, all.length, ...rest);
      return [...all];
    },
    io.lockMs,
  );
  return listing(io.cwd, entries);
}

/** `orchestrate queue add|show|drop` : 0, ou 1 avec le message de l'erreur sur la sortie d'erreur. Sans commit ni écriture dans un plan. */
export function queueCommand(argv: string[], io: QueueIo): number {
  const [sub, ...rest] = argv;
  try {
    if (sub === undefined) throw new QueueRefusal(`queue : sous-commande attendue (${SUBCOMMANDS}) ; le lot d'un projet nommé queue se donne sous la forme queue:<lot>`);
    if (sub !== 'add' && sub !== 'show' && sub !== 'drop') throw new QueueRefusal(`queue : sous-commande inconnue : ${sub} (${SUBCOMMANDS})`);
    const home = cadenceHome();
    const lines = sub === 'add' ? add(io, rest, home) : sub === 'drop' ? drop(io, rest, home) : show(io, home);
    for (const l of lines) io.out(l);
    return 0;
  } catch (e) {
    if (e instanceof QueueRefusal || e instanceof QueueError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}

/** Les options qui consomment la valeur suivante, comme `parseOrchestrateArgs` les lit (`--answer` en consomme deux). */
const VALUE_FLAGS = new Set(['--since', '--detail', '--interval', '--budget', '--max-sessions', '--goal', '--wave', '--drop', '--add', '--integrate', '--replay', '--remove-worktree', '--until', '--priority']);

/** L'indice du premier jeton positionnel de `argv` : les options et leurs valeurs (comme `parseOrchestrateArgs` les consomme) ne comptent pas ; -1 s'il n'y en a pas. */
function firstPositional(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (VALUE_FLAGS.has(t)) i++;
    else if (t === '--answer') i += 2;
    else if (t === '--status' || t === '--resume') {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') && !LOT_LIKE.test(argv[i + 1]) && argv[i + 1] !== 'queue') i++;
    } else if (!t.startsWith('-')) return i;
  }
  return -1;
}

/** Les arguments qui suivent le mot `queue` quand il est le premier jeton positionnel de `argv` (R17), sinon undefined : la file est aiguillée avant que l'analyse des lots lise `queue` comme un lot ; un lot d'un projet nommé queue se donne `queue:<lot>`. */
export function queueArgv(argv: string[]): string[] | undefined {
  const first = firstPositional(argv);
  return first >= 0 && argv[first] === 'queue' ? argv.slice(first + 1) : undefined;
}
