// L837 : un run ne laisse aucun processus vivant après sa fin (vécu le 24-11 : `astro preview --port 4391` d'un run, encore là 26 min après la fin).
// Le groupe de processus du run est l'ensemble des processus qui portent sa marque, la variable MARQUE=<id du run>, posée dans l'environnement du run pendant
// qu'il joue : la session, la porte, et tout ce qu'elles lancent en héritent. Un groupe POSIX (pgid) ne suffit pas : l'enveloppe de la session la met déjà dans
// son propre groupe (setsid, ./bench/bras.ts) et tue ce groupe au retour, et un serveur lancé en arrière-plan par la session (outil Bash d'arrière-plan,
// setsid, nohup) en sort ; l'environnement, lui, suit setsid et le double fork. Le run lui-même et ses ancêtres (le veilleur d'un run --fond, le lanceur) ne
// sont jamais visés, ni un processus d'un autre run (une autre marque), ni un démon partagé que le run a démarré (DEMONS_PARTAGES), ni ce qui en descend.
// L'environnement se lit dans /proc ; sans /proc (macOS, le compte pro), par `ps` (revue L837, M1), comme findMarked de src/proc.ts.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/** La variable qui marque les processus d'un run ; sa valeur est l'id du run. */
export const MARQUE = 'CADENCE_RUN_PROCESSUS';
/** Ce qu'un processus du run a, après SIGTERM, pour s'arrêter seul avant SIGKILL. */
export const GRACE_PROCESSUS_MS = 3000;
const PAS_MS = 100, PASSES = 3;

export interface Processus { pid: number; commande: string }
export interface Arret { arretes: Processus[]; restants: Processus[] }
/** Ce que l'état d'un run garde de son groupe arrêté : les pids arrêtés et ceux qui vivaient encore après SIGKILL ; `controle: false` : ni /proc ni ps lisibles. */
export interface GroupeArrete { arretes: number[]; restants: number[]; controle?: false }
/** Ce que l'état d'un run porte de son groupe (Etat de run/run.ts l'étend) : son id, qui est la marque, et le groupe arrêté à sa dernière fin. */
export interface AvecGroupe { id: string; processus?: GroupeArrete }
/** Où lire les processus : `proc` (défaut /proc ; un dossier absent simule un système sans /proc) et `ps` (défaut : la commande ps du système), pour les tests. */
export interface Source { proc?: string; ps?: (avecEnv: boolean) => string }
/** Un processus de la table : `nom` (comm, ou premier mot de la commande), `marque` : son environnement porte la marque cherchée. */
interface Ligne { ppid: number; etat: string; nom: string; commande: string; marque: boolean }

/**
 * Démons partagés (revue L837, M2, repris de SHARED_DAEMONS de src/proc.ts) : lancés à la demande par la première session qui en a besoin, ils portent sa
 * marque et la passent aux panneaux et clients venus d'ailleurs ; tuer le serveur tmux qu'une session a démarré tuerait les panneaux que le lead y ouvre
 * ensuite. Épargnés quand ils portent la marque, avec tout ce qui en descend.
 */
export const DEMONS_PARTAGES = new Set(['tmux', 'screen', 'gpg-agent', 'dirmngr']);
const base = (mot: string) => (mot.trim().split(/\s/)[0].replace(/:$/, '').split('/').pop() ?? '').toLowerCase();
const demonPartage = (l: Ligne) => DEMONS_PARTAGES.has(base(l.nom)) || DEMONS_PARTAGES.has(base(l.commande));

/** Attente bloquante, sans processus fils (le run est synchrone de bout en bout). */
export const dormir = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** La table des processus lue dans /proc, ou null quand `proc` est illisible. */
function tableProc(proc: string, cle: string): Map<number, Ligne> | null {
  let pids: string[];
  try { pids = readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  const t = new Map<number, Ligne>();
  for (const d of pids) {
    let s: string, marque = false, commande = '';
    try { s = readFileSync(`${proc}/${d}/stat`, 'utf8'); } catch { continue; } // fini entre-temps
    try { marque = readFileSync(`${proc}/${d}/environ`, 'utf8').split('\0').includes(cle); } catch { /* processus d'un autre utilisateur */ }
    // la commande ne sert qu'aux processus marqués (ligne de fin, démon partagé) : lue pour eux seuls, la table est relue toutes les 100 ms pendant la grâce
    if (marque) try { commande = readFileSync(`${proc}/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* fini entre-temps */ }
    const fin = s.lastIndexOf(')'), c = s.slice(fin + 2).split(' ');
    t.set(Number(d), { ppid: Number(c[1]), etat: c[0], nom: s.slice(s.indexOf('(') + 1, fin), commande, marque });
  }
  return t;
}

/**
 * Arguments de `ps` : pid, ppid, état et commande, suivie de l'environnement quand `avecEnv`, sans limite de largeur. macOS (ps BSD) : « -E  Display the
 * environment as well » (son `-e` ne montre pas l'environnement) ; Linux (procps) : « e  Show the environment after the command » (lettre sans tiret).
 */
export function argsPs(plateforme: NodeJS.Platform, avecEnv: boolean): string[] {
  const darwin = plateforme === 'darwin';
  return [`${darwin ? '-' : ''}ax${avecEnv ? (darwin ? 'E' : 'e') : ''}ww`, '-o', 'pid=,ppid=,stat=,command='];
}
const psSysteme = (avecEnv: boolean) =>
  execFileSync('ps', argsPs(process.platform, avecEnv), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

/**
 * La table des processus lue par `ps`, ou null quand ps échoue. Deux lectures : avec l'environnement, pour la marque (un mot entier : l'id `x` ne reconnaît
 * pas `x0`) ; sans, pour la commande affichée (l'environnement porte des secrets et ne s'écrit jamais au journal).
 */
function tablePs(ps: (avecEnv: boolean) => string, cle: string): Map<number, Ligne> | null {
  let avec: string, sans: string;
  try { avec = ps(true); sans = ps(false); } catch { return null; }
  const lignes = (texte: string) => texte.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s(.*)$/.exec(l)).filter((m) => m !== null);
  const commandes = new Map(lignes(sans).map((m) => [Number(m[1]), m[4].trim()]));
  const t = new Map<number, Ligne>();
  for (const m of lignes(avec)) {
    const pid = Number(m[1]), commande = commandes.get(pid) ?? '';
    t.set(pid, { ppid: Number(m[2]), etat: m[3], nom: commande, commande, marque: ` ${m[4]} `.includes(` ${cle} `) });
  }
  return t;
}

/** Vrai quand `pid` ou l'un de ses ancêtres est un démon partagé qui porte la marque (un tmux sans la marque est celui du lead : il n'épargne rien). */
function sousDemonPartage(t: Map<number, Ligne>, pid: number): boolean {
  const vus = new Set<number>();
  for (let p = pid, l = t.get(p); p > 1 && l && !vus.has(p); p = l.ppid, l = t.get(p)) {
    if (l.marque && demonPartage(l)) return true;
    vus.add(p);
  }
  return false;
}

/** Le processus courant et ses ancêtres : jamais visés, même s'ils portent la marque (un run lancé depuis la porte d'un autre run). */
function ancetres(t: Map<number, Ligne>): Set<number> {
  const s = new Set<number>();
  for (let p = process.pid; p > 1 && !s.has(p); p = t.get(p)?.ppid ?? 0) s.add(p);
  return s;
}

/**
 * Les processus vivants qui portent la marque du run `id` (zombies exclus), hors du processus courant et de ses ancêtres et hors des démons partagés et de
 * leurs descendants ; lus dans /proc, sinon par ps ; null quand ni l'un ni l'autre n'est lisible : rien n'est contrôlé, et l'appelant le dit.
 */
export function processusDuRun(id: string, src: Source = {}): Processus[] | null {
  const cle = `${MARQUE}=${id}`, t = tableProc(src.proc ?? '/proc', cle) ?? tablePs(src.ps ?? psSysteme, cle);
  if (!t) return null;
  const exclus = ancetres(t), vus: Processus[] = [];
  for (const [pid, l] of t) {
    if (!l.marque || exclus.has(pid) || /^[ZX]/.test(l.etat) || sousDemonPartage(t, pid)) continue;
    vus.push({ pid, commande: l.commande.length > 120 ? `${l.commande.slice(0, 119)}…` : l.commande });
  }
  return vus;
}

const signaler = (l: Processus[], s: NodeJS.Signals) => { for (const p of l) try { process.kill(p.pid, s); } catch { /* déjà fini */ } };
/** Attend jusqu'à `ms` que plus aucun processus du run ne vive ; rend ceux qui vivent encore. */
function attendreFin(id: string, ms: number, src: Source): Processus[] {
  let l = processusDuRun(id, src) ?? [];
  for (const fin = Date.now() + ms; l.length && Date.now() < fin; l = processusDuRun(id, src) ?? []) dormir(PAS_MS);
  return l;
}

/**
 * Arrête le groupe du run : SIGTERM à chaque processus marqué, `graceMs` pour finir seul, puis SIGKILL à ceux qui restent ; repris jusqu'à trois fois, un
 * processus pouvant en lancer un autre pendant la grâce. `restants` : ce qui vit encore après la dernière passe, qu'il faut dire. null : ni /proc ni ps.
 */
export function arreterProcessusDuRun(id: string, o: Source & { graceMs?: number } = {}): Arret | null {
  const grace = o.graceMs ?? GRACE_PROCESSUS_MS, arretes = new Map<number, Processus>();
  let l = processusDuRun(id, o);
  if (!l) return null;
  for (let n = 0; l.length && n < PASSES; n++) {
    for (const p of l) arretes.set(p.pid, p);
    signaler(l, 'SIGTERM');
    const tenaces = attendreFin(id, grace, o);
    signaler(tenaces, 'SIGKILL');
    l = attendreFin(id, 1000, o);
  }
  return { arretes: [...arretes.values()], restants: l };
}

const nommer = (l: Processus[]) => l.map((p) => `${p.pid}${p.commande ? ` (${p.commande})` : ''}`).join(', ');
/** Ce que la fin du run dit de son groupe : rien quand aucun processus ne restait, les processus arrêtés, et ceux qui vivent encore (à tuer à la main). */
export function lignesArret(id: string, a: Arret | null): string[] {
  if (!a) return [`processus du run ${id} non contrôlés : ni /proc ni ps lisibles sur ce système (un serveur lancé par la session peut vivre encore)`];
  return [...(a.arretes.length ? [`processus du run ${id} arrêtés (${a.arretes.length}) : ${nommer(a.arretes)}`] : []),
    ...(a.restants.length ? [`processus du run ${id} ENCORE VIVANTS après SIGKILL (${a.restants.length}) : ${nommer(a.restants)} — kill -9 ${a.restants.map((p) => p.pid).join(' ')}`] : [])];
}

/** Joue `corps` avec la marque du run `id` dans l'environnement du processus (héritée par tout ce qu'il lance), puis rend la marque d'avant. */
export function marque<T>(id: string, corps: () => T): T {
  const avant = process.env[MARQUE];
  process.env[MARQUE] = id;
  try { return corps(); } finally { if (avant === undefined) delete process.env[MARQUE]; else process.env[MARQUE] = avant; }
}

/** Arrête le groupe du run `id` et écrit ce qu'en dit la fin (lignesArret). */
export function arreterEtDire(id: string, out: (l: string) => void, src: Source = {}): Arret | null {
  const a = arreterProcessusDuRun(id, src);
  for (const l of lignesArret(id, a)) out(l);
  return a;
}

/** La fin d'un run : son groupe arrêté, dit, et gardé dans son état (`processus`) quand il y avait quelque chose à dire. */
export function arreterGroupe(e: AvecGroupe, out: (l: string) => void, src: Source = {}): void {
  const a = arreterEtDire(e.id, out, src);
  if (!a) e.processus = { arretes: [], restants: [], controle: false };
  else garder(e, a);
}
/** Garde dans l'état les pids arrêtés et restants quand il y en avait, sinon retire ce qu'une fin précédente y avait laissé. */
function garder(e: AvecGroupe, a: Arret): void {
  if (a.arretes.length || a.restants.length) e.processus = { arretes: a.arretes.map((p) => p.pid), restants: a.restants.map((p) => p.pid) };
  else delete e.processus;
}

/**
 * Une session du run et sa suite : ce qu'un run tué a laissé (sa session, ses serveurs) est arrêté avant, puis tout est joué sous la marque du run. Au départ,
 * rien n'est dit quand rien ne restait, ni quand le système ne permet aucun contrôle (revue L837, M1) : la fin du run le dira, une fois.
 */
export function dansGroupe<T>(e: AvecGroupe, out: (l: string) => void, corps: () => T, src: Source = {}): T {
  const a = arreterProcessusDuRun(e.id, src);
  if (a) {
    for (const l of lignesArret(e.id, a)) out(l);
    garder(e, a);
  }
  return marque(e.id, corps);
}
