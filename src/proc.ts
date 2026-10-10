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

/** Heure de démarrage d'un processus (son identité : un pid se réutilise) ; null s'il est mort ou illisible. */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    // pas de /proc (macOS) ou processus sorti : ps
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
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
  /** Le dernier relevé a échoué (ps durablement en panne) : l'arbre n'est plus connu, même repli au kill. */
  private degraded = false;
  /** La commande racine est sortie : son pid peut être repris, il n'est plus ni adopté ni signalé. */
  private rootGone = false;

  private unavailableSaid = false;

  /**
   * `read` : le relevé des processus (injectable pour les tests) ; son échec laisse le dernier relevé en place.
   * `onUnavailable` : appelé une seule fois, au premier échec du relevé (le kill est alors dégradé).
   * `onBlindKill` : appelé au moment où kill() se rabat sur la racine faute de relevé (des descendants ont pu survivre).
   */
  constructor(
    private readonly root: number,
    private readonly read: () => Map<number, ProcInfo> | null = readProcs,
    private readonly onUnavailable: () => void = () => {},
    private readonly onBlindKill: () => void = () => {},
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
    this.degraded = !fresh;
    if (fresh) {
      this.last = fresh;
      this.lastAt = now;
      const root = fresh.get(this.root);
      if (this.rootUnknown && root) {
        this.known.set(this.root, root.start); // ps est revenu : la racine est enfin relevée
        this.rootUnknown = false;
      }
    } else if (now - this.lastAt > MAX_SNAPSHOT_AGE_MS) {
      this.last = new Map();
    }
    return this.last;
  }

  /** La commande racine est sortie (reste de l'arbre éventuellement vivant) : plus d'adoption tardive ni de repli sur son pid. */
  rootExited(): void {
    this.rootGone = true;
    this.rootUnknown = false; // plus de racine à adopter tardivement
  }

  /** Rien de fiable sur l'arbre : racine jamais relevée, ou relevé en échec en ce moment. */
  private get blind(): boolean {
    return this.rootUnknown || this.degraded;
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
    // Sans relevé (jamais, ou plus), les descendants sont inconnus : seule la commande racine est tuée. kill(-racine) vise
    // son groupe, mais sh n'en mène aucun (la commande reste dans le groupe de cadence, L19) : sans effet, les descendants survivent.
    if (this.blind && !this.rootGone) {
      try {
        this.onBlindKill();
      } catch {
        // un message raté ne doit rien casser
      }
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
    while (this.alive().length > 0 || (this.blind && !this.rootGone && signal(this.root, 0))) {
      if (Date.now() >= deadline) return this.kill();
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Variable d'environnement qui marque une session de l'orchestrateur : héritée par tous ses descendants, même orphelins. */
export const SESSION_MARK_VAR = 'CADENCE_SESSION';

/** Entrées de `findMarked` injectables, comme le `read` du TreeTracker : tests sans /proc, ou avec un faux `ps`. */
export interface FindMarkedIo {
  /** Dossier des processus (défaut `/proc`) : un dossier absent simule une machine sans /proc. */
  procRoot?: string;
  /** Exécuteur de `ps` (défaut `execFileSync`). */
  run?: typeof execFileSync;
  /** Plateforme dont `ps` est interrogé (défaut `process.platform`). */
  platform?: NodeJS.Platform;
  /** Appelé quand le relevé est impossible (ni /proc ni ps) : des orphelins marqués ont pu survivre. */
  onUnavailable?: () => void;
}

/**
 * Démons partagés : lancés à la demande par la première session qui en a besoin, ils portent sa marque et la passent à
 * tout client ou panneau venu d'ailleurs (serveur tmux, screen, gpg-agent, dirmngr). Ils servent d'autres que la session :
 * tuer le serveur tmux d'une session tue les panneaux que le lead ouvre ensuite. Épargnés, avec tout ce qui en descend.
 * Hors liste, faute de pouvoir les distinguer d'un client ordinaire par leur nom : le maître ssh (ControlPersist), le
 * démon Gradle (java), pm2 (node) — ils restent tués s'ils portent la marque.
 */
const SHARED_DAEMONS = new Set(['tmux', 'screen', 'gpg-agent', 'dirmngr']);

/** Nom d'un processus (comm ou premier mot de sa commande) : `tmux: server` → `tmux`, `/usr/bin/screen` → `screen`. */
function isSharedDaemon(name: string): boolean {
  const base = name.trim().split(/\s/)[0]!.replace(/:$/, '');
  return SHARED_DAEMONS.has((base.split('/').pop() ?? '').toLowerCase());
}

/**
 * Vrai si `pid` ou l'un de ses ancêtres est un démon partagé QUI PORTE LA MARQUE (`info` : nom et parent d'un pid, null
 * s'il est illisible ; `marked` : pids marqués). Un tmux sans la marque est celui du lead, où cadence tourne peut-être :
 * il n'épargne rien. La remontée s'arrête à cadence.
 */
function underSharedDaemon(
  pid: number,
  info: (pid: number) => { name: string; ppid: number } | null,
  marked: ReadonlySet<number>,
): boolean {
  for (let cur = pid, depth = 0; cur > 1 && cur !== process.pid && depth < 64; depth++) {
    const i = info(cur);
    if (!i) return false;
    if (marked.has(cur) && isSharedDaemon(i.name)) return true;
    cur = i.ppid;
  }
  return false;
}

/**
 * Arguments de `ps` qui listent pid, ppid et commande suivie de l'ENVIRONNEMENT, sans limite de largeur, selon la plateforme.
 * macOS (ps BSD), page de manuel officielle : « -E  Display the environment as well.  This does not reflect changes
 * in the environment after process launch. » — alors que « -e  Display information about other users' processes,
 * including those without controlling terminals. Identical to -A. » : sur macOS, `-e` n'affiche PAS l'environnement.
 * Linux (procps), man ps : « e  Show the environment after the command. » (lettre sans tiret, style BSD ; avec un
 * tiret, `-e` y signifie « tous les processus »).
 */
export function psEnvArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [platform === 'darwin' ? '-axEww' : 'axeww', '-o', 'pid=,ppid=,command='];
}

/** Nom (comm) et parent d'un processus lus dans `<procRoot>/<pid>/stat` ; null s'il est sorti ou illisible. */
function procInfo(procRoot: string, pid: number): { name: string; ppid: number } | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return { name: stat.slice(stat.indexOf('(') + 1, close), ppid: Number(stat.slice(close + 2).split(' ')[1]) };
  } catch {
    return null;
  }
}

/**
 * Pids des processus (hors cadence) dont l'environnement porte `<SESSION_MARK_VAR>=<mark>` : /proc, sinon `ps` (`-E` sur
 * macOS, `e` sur Linux). Les démons partagés (SHARED_DAEMONS) qui portent la marque, et leurs descendants, n'en font pas partie.
 */
export function findMarked(mark: string, io: FindMarkedIo = {}): number[] {
  const { procRoot = '/proc', run = execFileSync, platform = process.platform, onUnavailable } = io;
  const entry = `${SESSION_MARK_VAR}=${mark}`;
  const found: number[] = [];
  let names: string[] | null = null;
  try {
    names = readdirSync(procRoot);
  } catch {
    // pas de /proc (macOS) : ps
  }
  if (names) {
    for (const name of names) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        if (readFileSync(`${procRoot}/${pid}/environ`, 'utf8').split('\0').includes(entry)) found.push(pid);
      } catch {
        // sorti, zombie ou illisible (autre utilisateur)
      }
    }
    const markedSet = new Set(found);
    return found.filter((pid) => !underSharedDaemon(pid, (p) => procInfo(procRoot, p), markedSet));
  }
  try {
    const out = run('ps', psEnvArgs(platform), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const table = new Map<number, { name: string; ppid: number }>();
    const marked: number[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      table.set(pid, { name: m[3]!, ppid: Number(m[2]) });
      // la marque est un mot entier : `s1` ne reconnaît pas `s10` (comme la comparaison exacte des entrées de /proc)
      if (pid !== process.pid && ` ${m[3]} `.includes(` ${entry} `)) marked.push(pid);
    }
    const markedSet = new Set(marked);
    found.push(...marked.filter((pid) => !underSharedDaemon(pid, (p) => table.get(p) ?? null, markedSet)));
  } catch {
    // ps absent ou en échec : rien à tuer de plus, mais on le dit
    onUnavailable?.();
  }
  return found;
}

function defaultMarkedUnavailable(): void {
  process.stderr.write('cadence : processus de la session illisibles (ni /proc ni ps), des orphelins marqués ont pu survivre\n');
}

/** Tue (SIGKILL) tout processus marqué de la session, où qu'il soit rattaché ; repasse tant qu'un descendant en crée. */
export function killMarked(mark: string, io: FindMarkedIo = {}): void {
  let said = false;
  const onUnavailable = (): void => {
    if (said) return;
    said = true;
    (io.onUnavailable ?? defaultMarkedUnavailable)();
  };
  for (let pass = 0; pass < 5; pass++) {
    const pids = findMarked(mark, { ...io, onUnavailable });
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }
  }
}
