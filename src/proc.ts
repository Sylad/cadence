import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Signaux qui terminent cadence pendant qu'une commande tourne : chaque commande en cours inscrit son
 * nettoyage, cadence l'exécute avant de sortir — tué par le même signal, comme sans nettoyage.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const cleanups = new Set<(sig: NodeJS.Signals) => void>();

function onSignal(sig: NodeJS.Signals): void {
  for (const f of cleanups) f(sig);
  cleanups.clear();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.kill(process.pid, sig);
}

/** Inscrit un nettoyage à faire si cadence reçoit Ctrl-C, SIGTERM ou le raccrochage ; rend son retrait. */
export function onTermination(cleanup: (sig: NodeJS.Signals) => void): () => void {
  if (cleanups.size === 0) for (const s of SIGNALS) process.on(s, onSignal);
  cleanups.add(cleanup);
  return () => {
    if (!cleanups.delete(cleanup)) return;
    if (cleanups.size === 0) for (const s of SIGNALS) process.removeListener(s, onSignal);
  };
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // déjà mort
  }
}

/** Enfants de chaque processus : /proc sous Linux, `ps` ailleurs. */
function childrenByParent(): Map<number, number[]> {
  const pairs: [number, number][] = [];
  let names: string[] | null = null;
  try {
    names = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    // pas de /proc (macOS) : ps
  }
  if (names) {
    for (const n of names) {
      try {
        const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
        // « pid (comm) état ppid … » — comm peut contenir espaces et parenthèses
        pairs.push([Number(n), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])]);
      } catch {
        // sorti entre-temps
      }
    }
  } else {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      pairs.push([pid!, ppid!]);
    }
  }
  const map = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) map.set(ppid, [...(map.get(ppid) ?? []), pid]);
  return map;
}

/**
 * Tue `root` et TOUS ses descendants, sans en laisser filer un : chacun est d'abord arrêté (SIGSTOP) —
 * plus aucun fork, et aucun enfant n'est rattaché à init par la mort de son parent —, l'arbre est relu
 * jusqu'à ce qu'il ne s'y ajoute plus rien, puis tout est tué (SIGKILL). Ce qui a quitté l'arbre AVANT
 * l'appel (setsid puis mort du parent, double fork d'un démon) n'en fait plus partie et lui échappe.
 */
export function killTree(root: number): void {
  const seen = new Set<number>([process.pid]);
  const stopped: number[] = [];
  for (let fresh = [root]; fresh.length > 0; ) {
    for (const pid of fresh) {
      seen.add(pid); // essayé une fois : mort entre-temps ou hors d'atteinte (sudo), il ne revient pas
      if (signal(pid, 'SIGSTOP')) stopped.push(pid);
    }
    const kids = childrenByParent();
    fresh = stopped.flatMap((pid) => kids.get(pid) ?? []).filter((pid) => !seen.has(pid));
  }
  for (const pid of stopped) signal(pid, 'SIGKILL');
}
