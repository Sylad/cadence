import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Signaux qui terminent cadence pendant qu'une commande tourne : chaque commande en cours inscrit son
 * nettoyage, cadence l'exécute avant de sortir — tué par le même signal, comme sans nettoyage.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const cleanups = new Set<(sig: NodeJS.Signals) => void | Promise<void>>();
let dying = false;

/**
 * Délai de grâce après Ctrl-C ou raccrochage : l'arbre de la commande a déjà reçu le signal du terminal,
 * ses `trap` et le nettoyage de git (index.lock) ont ce temps pour finir avant le kill.
 */
export const SIGNAL_GRACE_MS = 2_000;

async function onSignal(sig: NodeJS.Signals): Promise<void> {
  if (dying) return; // un second signal pendant le nettoyage n'interrompt rien
  dying = true;
  await Promise.all([...cleanups].map((f) => f(sig)));
  cleanups.clear();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.kill(process.pid, sig);
}

/**
 * Inscrit un nettoyage à faire si cadence reçoit Ctrl-C, SIGTERM ou le raccrochage ; rend son retrait.
 * Le nettoyage peut être asynchrone : cadence l'attend avant de mourir du signal.
 */
export function onTermination(cleanup: (sig: NodeJS.Signals) => void | Promise<void>): () => void {
  if (cleanups.size === 0) for (const s of SIGNALS) process.on(s, onSignal);
  cleanups.add(cleanup);
  return () => {
    if (dying || !cleanups.delete(cleanup)) return;
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

/** Ce qu'on sait d'un processus : son parent, son heure de démarrage (son identité, un pid se réutilise), zombie ou non. */
interface ProcInfo {
  ppid: number;
  start: string;
  zombie: boolean;
}

/** Tous les processus visibles : /proc sous Linux (starttime, champ 22 de stat), `ps` ailleurs (lstart). */
function readProcs(): Map<number, ProcInfo> {
  const procs = new Map<number, ProcInfo>();
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
        // « pid (comm) état ppid … starttime … » — comm peut contenir espaces et parenthèses
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        procs.set(Number(n), { ppid: Number(f[1]), start: f[19]!, zombie: f[0] === 'Z' });
      } catch {
        // sorti entre-temps
      }
    }
  } else {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8' }).trim().split('\n')) {
      const [pid, ppid, stat, ...lstart] = line.trim().split(/\s+/);
      procs.set(Number(pid), { ppid: Number(ppid), start: lstart.join(' '), zombie: stat!.startsWith('Z') });
    }
  }
  return procs;
}

/** Intervalle du relevé des descendants d'une commande de deliver pendant qu'elle tourne. */
export const TRACK_INTERVAL_MS = 200;

/**
 * Suivi continu de l'arbre d'une commande : toutes les TRACK_INTERVAL_MS, ses descendants sont relevés et
 * chacun est retenu avec son heure de démarrage. Un processus vu une fois reste suivi même si son parent
 * meurt (rattaché à init, il n'est plus sous la racine) — ses propres enfants aussi. Un pid suivi n'est
 * signalé que si son heure de démarrage est toujours la même : jamais un pid réutilisé par un autre.
 * Échappe seulement ce qui quitte l'arbre entre deux relevés (fork puis mort du parent en moins d'un
 * intervalle) et ce que cadence n'a pas le droit de tuer (sudo).
 */
export class TreeTracker {
  private readonly known = new Map<number, string>();
  private readonly timer: NodeJS.Timeout;

  constructor(root: number) {
    const info = readProcs().get(root);
    if (info) this.known.set(root, info.start);
    this.timer = setInterval(() => this.scan(), TRACK_INTERVAL_MS);
    this.timer.unref();
  }

  /** Arrête le relevé périodique (la commande est finie, ou son arbre est tué). */
  stop(): void {
    clearInterval(this.timer);
  }

  /** Relève les nouveaux descendants des processus suivis encore vivants ; rend le relevé. */
  scan(procs = readProcs()): Map<number, ProcInfo> {
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, info] of procs) {
        if (this.known.has(pid) || !this.isTracked(info.ppid, procs)) continue;
        this.known.set(pid, info.start);
        grew = true;
      }
    }
    return procs;
  }

  /** Processus suivis encore vivants (même heure de démarrage, pas zombies). */
  alive(procs = this.scan()): number[] {
    return [...this.known.keys()].filter((pid) => this.isTracked(pid, procs) && !procs.get(pid)!.zombie);
  }

  private isTracked(pid: number, procs: Map<number, ProcInfo>): boolean {
    const start = this.known.get(pid);
    return start !== undefined && procs.get(pid)?.start === start;
  }

  /**
   * Tue tous les processus suivis encore vivants et TOUS leurs descendants actuels, sans en laisser filer un :
   * chacun est d'abord arrêté (SIGSTOP) — plus aucun fork, et plus aucun enfant rattaché à init par la mort
   * de son parent —, l'arbre est relu jusqu'à ce qu'il ne s'y ajoute plus rien, puis tout est tué (SIGKILL).
   */
  kill(): void {
    this.stop();
    const seen = new Set<number>([process.pid]);
    const stopped: number[] = [];
    for (let fresh = this.alive(); fresh.length > 0; ) {
      for (const pid of fresh) {
        seen.add(pid); // essayé une fois : mort entre-temps ou hors d'atteinte (sudo), il ne revient pas
        if (signal(pid, 'SIGSTOP')) stopped.push(pid);
      }
      const procs = this.scan();
      fresh = this.alive(procs).filter((pid) => !seen.has(pid));
    }
    for (const pid of stopped) signal(pid, 'SIGKILL');
  }

  /**
   * Laisse à l'ensemble suivi jusqu'à `graceMs` pour finir de lui-même (il a déjà reçu le signal du terminal),
   * puis tue ce qui reste. Rend la main dès que plus aucun processus suivi n'est vivant.
   */
  async end(graceMs: number): Promise<void> {
    this.stop();
    const deadline = Date.now() + graceMs;
    while (this.alive().length > 0) {
      if (Date.now() >= deadline) return this.kill();
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
