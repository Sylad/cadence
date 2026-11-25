// L837 : un run ne laisse aucun processus vivant après sa fin (vécu le 24-11 : `astro preview --port 4391` d'un run, encore là 26 min après la fin).
// Le groupe de processus du run est l'ensemble des processus qui portent sa marque, la variable MARQUE=<id du run>, posée dans l'environnement du run pendant
// qu'il joue : la session, la porte, et tout ce qu'elles lancent en héritent. Un groupe POSIX (pgid) ne suffit pas : l'enveloppe de la session la met déjà dans
// son propre groupe (setsid, ./bench/bras.ts) et tue ce groupe au retour, et un serveur lancé en arrière-plan par la session (outil Bash d'arrière-plan,
// setsid, nohup) en sort ; l'environnement, lui, suit setsid et le double fork. Le run lui-même et ses ancêtres (le veilleur d'un run --fond, le lanceur) ne
// sont jamais visés, ni un processus d'un autre run (une autre marque).
import { readdirSync, readFileSync } from 'node:fs';

/** La variable qui marque les processus d'un run ; sa valeur est l'id du run. */
export const MARQUE = 'CADENCE_RUN_PROCESSUS';
/** Ce qu'un processus du run a, après SIGTERM, pour s'arrêter seul avant SIGKILL. */
export const GRACE_PROCESSUS_MS = 3000;
const PAS_MS = 100, PASSES = 3;

export interface Processus { pid: number; commande: string }
export interface Arret { arretes: Processus[]; restants: Processus[] }
/** Ce que l'état d'un run garde de son groupe arrêté : les pids arrêtés et ceux qui vivaient encore après SIGKILL ; `controle: false` : /proc illisible. */
export interface GroupeArrete { arretes: number[]; restants: number[]; controle?: false }

/** Attente bloquante, sans processus fils (le run est synchrone de bout en bout). */
export const dormir = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** État et ppid d'un processus (/proc/<pid>/stat, après « (comm) »), ou null s'il n'existe plus. */
function stat(proc: string, pid: number): { etat: string; ppid: number } | null {
  try { const c = readFileSync(`${proc}/${pid}/stat`, 'utf8').split(') ').pop()!.split(' '); return { etat: c[0], ppid: Number(c[1]) }; } catch { return null; }
}
/** Le processus courant et ses ancêtres : jamais visés, même s'ils portent la marque (un run lancé depuis la porte d'un autre run). */
function ancetres(proc: string): Set<number> {
  const s = new Set<number>();
  for (let p = process.pid; p > 1 && !s.has(p); p = stat(proc, p)?.ppid ?? 0) s.add(p);
  return s;
}

/** Les processus vivants qui portent la marque du run `id` (zombies exclus), hors du processus courant et de ses ancêtres ; null quand `proc` est illisible
 * (système sans /proc) : rien n'est contrôlé, et l'appelant le dit. */
export function processusDuRun(id: string, proc = '/proc'): Processus[] | null {
  let pids: string[];
  try { pids = readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  const cle = `${MARQUE}=${id}`, exclus = ancetres(proc), vus: Processus[] = [];
  for (const d of pids) {
    const pid = Number(d);
    if (exclus.has(pid)) continue;
    try {
      if (!readFileSync(`${proc}/${d}/environ`, 'utf8').split('\0').includes(cle)) continue;
    } catch { continue; } // processus d'un autre utilisateur, ou fini entre-temps
    const s = stat(proc, pid);
    if (!s || s.etat === 'Z' || s.etat === 'X') continue;
    let commande = '';
    try { commande = readFileSync(`${proc}/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* fini entre-temps */ }
    vus.push({ pid, commande: commande.length > 120 ? `${commande.slice(0, 119)}…` : commande });
  }
  return vus;
}

const signaler = (l: Processus[], s: NodeJS.Signals) => { for (const p of l) try { process.kill(p.pid, s); } catch { /* déjà fini */ } };
/** Attend jusqu'à `ms` que plus aucun processus du run ne vive ; rend ceux qui vivent encore. */
function attendreFin(id: string, ms: number, proc: string): Processus[] {
  let l = processusDuRun(id, proc) ?? [];
  for (const fin = Date.now() + ms; l.length && Date.now() < fin; l = processusDuRun(id, proc) ?? []) dormir(PAS_MS);
  return l;
}

/**
 * Arrête le groupe du run : SIGTERM à chaque processus marqué, `graceMs` pour finir seul, puis SIGKILL à ceux qui restent ; repris jusqu'à trois fois, un
 * processus pouvant en lancer un autre pendant la grâce. `restants` : ce qui vit encore après la dernière passe, qu'il faut dire. null : /proc illisible.
 */
export function arreterProcessusDuRun(id: string, o: { graceMs?: number; proc?: string } = {}): Arret | null {
  const proc = o.proc ?? '/proc', grace = o.graceMs ?? GRACE_PROCESSUS_MS, arretes = new Map<number, Processus>();
  let l = processusDuRun(id, proc);
  if (!l) return null;
  for (let n = 0; l.length && n < PASSES; n++) {
    for (const p of l) arretes.set(p.pid, p);
    signaler(l, 'SIGTERM');
    const tenaces = attendreFin(id, grace, proc);
    signaler(tenaces, 'SIGKILL');
    l = attendreFin(id, 1000, proc);
  }
  return { arretes: [...arretes.values()], restants: l };
}

const nommer = (l: Processus[]) => l.map((p) => `${p.pid}${p.commande ? ` (${p.commande})` : ''}`).join(', ');
/** Ce que la fin du run dit de son groupe : rien quand aucun processus ne restait, les processus arrêtés, et ceux qui vivent encore (à tuer à la main). */
export function lignesArret(id: string, a: Arret | null): string[] {
  if (!a) return [`processus du run ${id} non contrôlés : /proc illisible sur ce système (un serveur lancé par la session peut vivre encore)`];
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
export function arreterEtDire(id: string, out: (l: string) => void): Arret | null {
  const a = arreterProcessusDuRun(id);
  for (const l of lignesArret(id, a)) out(l);
  return a;
}

/** La fin d'un run : son groupe arrêté, dit, et gardé dans son état (`processus`) quand il y avait quelque chose à dire. */
export function arreterGroupe(e: { id: string; processus?: GroupeArrete }, out: (l: string) => void): void {
  const a = arreterEtDire(e.id, out);
  if (!a) e.processus = { arretes: [], restants: [], controle: false };
  else if (a.arretes.length || a.restants.length) e.processus = { arretes: a.arretes.map((p) => p.pid), restants: a.restants.map((p) => p.pid) };
  else delete e.processus;
}

/** Une session du run et sa suite : ce qu'un run tué a laissé (sa session, ses serveurs) est arrêté avant, puis tout est joué sous la marque du run. */
export function dansGroupe<T>(e: { id: string; processus?: GroupeArrete }, out: (l: string) => void, corps: () => T): T {
  arreterGroupe(e, out);
  return marque(e.id, corps);
}
