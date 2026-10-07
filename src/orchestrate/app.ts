import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { linkNewFile, lockFault, pidAlive, removeStaleFile } from '../state.js';
import { withoutLaunchVars } from './snapshot.js';

/** Défaut de `orchestrate.ux.timeout` : secondes d'attente de la réponse de l'application. */
export const APP_TIMEOUT_S = 300;
/** Délai entre le SIGTERM et le SIGKILL du groupe de l'application. */
export const APP_KILL_AFTER_MS = 10_000;

export type AppState = { kind: 'ready' } | { kind: 'busy' } | { kind: 'unverified'; cause: string };

export interface AppRun {
  state: AppState;
  /** SIGTERM au groupe, puis SIGKILL s'il vit encore après `killAfterMs`. Sans effet quand rien n'a été lancé. */
  stop: () => Promise<void>;
}

export interface AppOpts {
  command: string;
  url: string;
  cwd: string;
  log: string;
  timeoutMs: number;
  killAfterMs?: number;
  /** Intervalle entre deux sondes (ms). */
  every?: number;
  /** Dossier de liens Node du `.nvmrc` du projet (`linkNodeBin`) : en tête du PATH de l'application, comme celui des sessions. */
  nodeBin?: string;
}

/** L'environnement de l'application : celui de l'orchestrateur, avec le Node du projet en tête du PATH quand il y en a un (sans préfixe nvm, qui sort en code 3 sous sh). */
function appEnv(nodeBin?: string): NodeJS.ProcessEnv {
  const env = withoutLaunchVars(process.env);
  return nodeBin ? { ...env, PATH: [nodeBin, env.PATH ?? ''].filter(Boolean).join(delimiter) } : env;
}

const live = new Set<() => Promise<void>>();

/** Au signal de la vague : arrête les applications lancées (SIGTERM, puis SIGKILL après le délai). L'appelant l'attend avant de mourir. */
export async function stopApps(): Promise<void> {
  await Promise.all([...live].map((stop) => stop()));
}

function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Vrai quand l'URL répond en HTTP avec un statut inférieur à 500. */
export async function responds(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
    await r.body?.cancel();
    return r.status < 500;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(file: string): string {
  try {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-15).join('\n');
    return lines.slice(-1500) || '(journal vide)';
  } catch {
    return '(journal illisible)';
  }
}

/** Verrou inter-processus de l'URL (nom : le port seul pour la machine locale, sinon hôte:port) : deux vagues (deux processus) qui déclarent la même URL ne lancent pas deux applications sur le même port. */
export function uxLockFile(url: string): string {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  // localhost, 127.0.0.1 et ::1 désignent la même machine : même port, même verrou
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return join(tmpdir(), `cadence-ux-${local ? '' : `${u.hostname.replace(/[^\w.-]/g, '_')}-`}${port}.lock`);
}

/** Contenu du verrou : un pid, ou null quand le fichier est vide, illisible, ou rendu entre-temps. */
function readUrlLock(file: string): { text: string; age: number } | null {
  try {
    return { text: readFileSync(file, 'utf8').trim(), age: Date.now() - statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Pose du verrou : lien vers un fichier complet (le verrou n'existe jamais à moitié écrit, comme `writeLock` de state.ts).
 * Un verrou d'un pid mort est écarté par renommage, puis retiré seulement s'il est encore celui qu'on a lu — sinon
 * il est rendu à son nouveau porteur (comme `removeStaleLock`) : deux vagues ne se volent pas le verrou.
 * Faux quand un processus vivant le tient. `pid` : celui du porteur (le nôtre, sauf test).
 */
export function takeUrlLock(file: string, pid = process.pid): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (linkNewFile(file, String(pid), `${pid}.${attempt}`)) return true;
    const seen = readUrlLock(file);
    if (!seen) continue; // rendu entre-temps
    // Un fichier vide est un verrou posé par une version qui l'écrivait en deux temps : on ne le vole qu'au bout de 5 s.
    if (seen.text === '' ? seen.age < 5_000 : pidAlive(Number(seen.text))) return false;
    removeStaleFile(file, (aside) => readUrlLock(aside)?.text === seen.text);
  }
  return false;
}

function releaseUrlLock(file: string): void {
  try {
    if (Number(readFileSync(file, 'utf8').trim()) === process.pid) rmSync(file, { force: true });
  } catch {
    /* déjà rendu */
  }
}

/**
 * Lance l'application de la revue UX : prend le verrou de l'URL (attente comptée dans le délai), sonde l'URL (qui répond
 * déjà : rien n'est lancé), lance la commande depuis `cwd` dans son propre groupe de processus (sortie dans `log`),
 * puis sonde jusqu'à une réponse HTTP < 500 — le groupe lancé encore vivant — ou au délai. Le verrou est rendu à `stop`.
 */
export async function startApp(o: AppOpts): Promise<AppRun> {
  const none = async () => {};
  const deadline = Date.now() + o.timeoutMs;
  const lock = uxLockFile(o.url);
  const held = { state: { kind: 'unverified', cause: `url tenue par une autre vague (${o.url})` }, stop: none } as const;
  try {
    while (!takeUrlLock(lock)) {
      if (Date.now() >= deadline) return held;
      await sleep(o.every ?? 500);
    }
  } catch (e) {
    // Verrou impossible à poser (pas de liens physiques…) : comme un journal illisible, la revue UX n'a pas lieu, la cause est dite.
    return { state: { kind: 'unverified', cause: lockFault(lock, e) }, stop: none };
  }
  const release = () => releaseUrlLock(lock);
  if (Date.now() >= deadline) {
    release(); // obtenu après le délai : toute l'attente a été passée à celle du verrou, il ne reste rien pour lancer l'application
    return held;
  }
  try {
    return await launch(o, deadline, release);
  } catch (e) {
    release();
    throw e;
  }
}

/** `release` rend le verrou : dès que rien ne tourne (busy, échec), sinon à la fin de `stop`, une fois le groupe disparu. */
async function launch(o: AppOpts, deadline: number, release: () => void): Promise<AppRun> {
  const none = async () => {};
  const available = Math.max(0, deadline - Date.now()); // le délai de l'étape moins l'attente du verrou : c'est lui que le message annonce
  if (await responds(o.url)) {
    release();
    return { state: { kind: 'busy' }, stop: none };
  }
  let fd: number;
  try {
    fd = openSync(o.log, 'a');
  } catch (e) {
    release();
    return { state: { kind: 'unverified', cause: `journal ${o.log} : ${(e as Error).message}` }, stop: none };
  }
  const child = spawn('sh', ['-c', o.command], { cwd: o.cwd, env: appEnv(o.nodeBin), stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) {
    const cause = await new Promise<string>((r) => child.once('error', (e) => r(e.message)));
    release();
    return { state: { kind: 'unverified', cause: `lancement impossible : ${cause}` }, stop: none };
  }
  const gone: { why?: string } = {};
  child.once('error', (e) => (gone.why = `lancement impossible : ${e.message}`));
  child.once('close', (code, sig) => (gone.why = `la commande s'est arrêtée (${sig ?? `code ${code}`})`));
  const stop = async () => {
    live.delete(stop);
    try {
      if (!signal(pid, 'SIGTERM')) return;
      const limit = Date.now() + (o.killAfterMs ?? APP_KILL_AFTER_MS);
      while (Date.now() < limit && signal(pid, 0)) await sleep(50);
      signal(pid, 'SIGKILL');
      for (let i = 0; i < 40 && signal(pid, 0); i++) await sleep(25); // le SIGKILL n'est pas instantané : le groupe disparu, pas seulement signalé
    } finally {
      release(); // après l'arrêt de l'application seulement : l'autre vague ne trouve pas un port encore tenu
    }
  };
  live.add(stop);
  for (;;) {
    if (await responds(o.url)) {
      if (signal(pid, 0)) return { state: { kind: 'ready' }, stop };
      gone.why ??= 'la commande s\'est arrêtée alors que l\'URL répond (autre processus ?)'; // la réponse n'est pas la nôtre
      break;
    }
    if (gone.why || Date.now() >= deadline) break;
    await sleep(o.every ?? 500);
  }
  const why = gone.why ?? `l'URL n'a pas répondu en ${Math.round(available / 1000)} s`;
  await stop();
  return { state: { kind: 'unverified', cause: `${why}. Fin du journal :\n${tail(o.log)}` }, stop: none };
}
