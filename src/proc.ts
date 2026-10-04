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

function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // déjà mort
  }
}

/** Ce qu'on sait d'un processus : son parent, son heure de démarrage (son identité, un pid se réutilise), zombie ou non. */
export interface ProcInfo {
  ppid: number;
  start: string;
  zombie: boolean;
}

/** Processus vus par `ps` (macOS, sans /proc) ; null si `ps` échoue — l'appelant garde alors son dernier relevé. */
export function readPsProcs(run: typeof execFileSync = execFileSync): Map<number, ProcInfo> | null {
  const procs = new Map<number, ProcInfo>();
  try {
    for (const line of run('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8' }).trim().split('\n')) {
      const [pid, ppid, stat, ...lstart] = line.trim().split(/\s+/);
      procs.set(Number(pid), { ppid: Number(ppid), start: lstart.join(' '), zombie: stat!.startsWith('Z') });
    }
  } catch {
    return null;
  }
  return procs;
}

/** Tous les processus visibles : /proc sous Linux (starttime, champ 22 de stat), `ps` ailleurs (lstart) ; null si illisibles. */
export function readProcs(): Map<number, ProcInfo> | null {
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
    return readPsProcs();
  }
  return procs;
}

/** Âge au-delà duquel un relevé de secours (le relevé suivant a échoué) n'est plus cru : un pid y a pu être repris. */
export const MAX_SNAPSHOT_AGE_MS = 1_000;

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
  private last = new Map<number, ProcInfo>();
  private lastAt = 0;
  /** Racine jamais relevée (ps en échec dès la construction) : kill() se rabat sur son groupe et sur elle. */
  private rootUnknown = false;

  private unavailableSaid = false;

  /**
   * `read` : le relevé des processus (injectable pour les tests) ; son échec laisse le dernier relevé en place.
   * `onUnavailable` : appelé une seule fois, au premier échec du relevé (le kill est alors dégradé).
   */
  constructor(
    private readonly root: number,
    private readonly read: () => Map<number, ProcInfo> | null = readProcs,
    private readonly onUnavailable: () => void = () => {},
  ) {
    const info = this.snapshot().get(root);
    if (info) this.known.set(root, info.start);
    else this.rootUnknown = true;
    this.timer = setInterval(() => this.scan(), TRACK_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Dernier relevé réussi : un échec de lecture (ps absent ou en erreur) ne plante pas cadence depuis le timer
   * et ne fait pas croire que tout est mort. Mais au-delà de MAX_SNAPSHOT_AGE_MS le relevé est périmé : un pid
   * suivi a pu être repris par un autre processus, qu'on ne signalerait pas à tort — mieux vaut ne rien signaler.
   */
  private snapshot(): Map<number, ProcInfo> {
    let fresh: Map<number, ProcInfo> | null = null;
    try {
      fresh = this.read();
    } catch {
      // relevé en échec
    }
    if (!fresh && !this.unavailableSaid) {
      this.unavailableSaid = true;
      try {
        this.onUnavailable();
      } catch {
        // un message raté ne doit rien casser
      }
    }
    const now = Date.now();
    if (fresh) {
      this.last = fresh;
      this.lastAt = now;
    } else if (now - this.lastAt > MAX_SNAPSHOT_AGE_MS) {
      this.last = new Map();
    }
    return this.last;
  }

  /** Arrête le relevé périodique (la commande est finie, ou son arbre est tué). */
  stop(): void {
    clearInterval(this.timer);
  }

  /** Relève les nouveaux descendants des processus suivis encore vivants ; rend le relevé. */
  scan(procs = this.snapshot()): Map<number, ProcInfo> {
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
    // Sans relevé, les descendants sont inconnus : au mieux le groupe de la commande (si elle en mène un ; jamais
    // celui de cadence, dont le pid est autre) et la commande elle-même.
    if (this.rootUnknown) {
      signal(-this.root, 'SIGKILL');
      signal(this.root, 'SIGKILL');
    }
  }

  /**
   * Laisse à l'ensemble suivi jusqu'à `graceMs` pour finir de lui-même (il a déjà reçu le signal du terminal),
   * puis tue ce qui reste. Rend la main dès que plus aucun processus suivi n'est vivant.
   */
  async end(graceMs: number): Promise<void> {
    this.stop();
    const deadline = Date.now() + graceMs;
    // Racine jamais relevée : on ne voit rien de l'arbre, seule la racine (notre enfant, son pid ne se réutilise
    // pas tant qu'elle n'est pas réaperçue) dit si quelque chose tourne encore — et le kill à l'échéance se
    // replie sur elle et son groupe.
    while (this.alive().length > 0 || (this.rootUnknown && signal(this.root, 0))) {
      if (Date.now() >= deadline) return this.kill();
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
