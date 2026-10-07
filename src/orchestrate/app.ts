import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
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

/**
 * Lance l'application de la revue UX : sonde l'URL (qui répond déjà : rien n'est lancé), lance la commande depuis `cwd`
 * dans son propre groupe de processus (sortie dans `log`), puis sonde jusqu'à une réponse HTTP < 500 ou au délai.
 */
export async function startApp(o: AppOpts): Promise<AppRun> {
  const none = async () => {};
  if (await responds(o.url)) return { state: { kind: 'busy' }, stop: none };
  let fd: number;
  try {
    fd = openSync(o.log, 'a');
  } catch (e) {
    return { state: { kind: 'unverified', cause: `journal ${o.log} : ${(e as Error).message}` }, stop: none };
  }
  const child = spawn('sh', ['-c', o.command], { cwd: o.cwd, env: withoutLaunchVars(process.env), stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) {
    const cause = await new Promise<string>((r) => child.once('error', (e) => r(e.message)));
    return { state: { kind: 'unverified', cause: `lancement impossible : ${cause}` }, stop: none };
  }
  const gone: { why?: string } = {};
  child.once('error', (e) => (gone.why = `lancement impossible : ${e.message}`));
  child.once('close', (code, sig) => (gone.why = `la commande s'est arrêtée (${sig ?? `code ${code}`})`));
  const stop = async () => {
    live.delete(stop);
    if (!signal(pid, 'SIGTERM')) return;
    const limit = Date.now() + (o.killAfterMs ?? APP_KILL_AFTER_MS);
    while (Date.now() < limit && signal(pid, 0)) await sleep(50);
    signal(pid, 'SIGKILL');
    for (let i = 0; i < 40 && signal(pid, 0); i++) await sleep(25); // le SIGKILL n'est pas instantané : le groupe disparu, pas seulement signalé
  };
  live.add(stop);
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (await responds(o.url)) return { state: { kind: 'ready' }, stop };
    if (gone.why || Date.now() >= deadline) break;
    await sleep(o.every ?? 500);
  }
  const why = gone.why ?? `l'URL n'a pas répondu en ${Math.round(o.timeoutMs / 1000)} s`;
  await stop();
  return { state: { kind: 'unverified', cause: `${why}. Fin du journal :\n${tail(o.log)}` }, stop: none };
}
