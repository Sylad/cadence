import { type LotCtx, workDir as wd } from './ctx.js';
import { toolBinOf, withoutLaunchVars } from '../snapshot.js';
import { delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { TEST_WORKERS_ENV } from '../workers.js';
import { trackGroup } from '../launch.js';
export const shEscape = (s: string) => s.replace(/\s+/g, ' ').replace(/[\\"$`]/g, '\\$&');

/** Commande du projet, asynchrone : la boucle d'événements reste libre (délai de l'autre créneau, signaux). Son groupe est tué au délai et au signal. */
/**
 * PATH des commandes que le programme lance lui-même (porte, ligne de base, démarrage, acceptation, verdict) : le même que celui des sessions,
 * le lien `node-bin/<version>` du .nvmrc du lot en tête (L351). Sans .nvmrc, rien : le PATH hérité reste tel quel.
 */
function nodePath(c: LotCtx): { PATH?: string } {
  const link = c.lot.node?.link;
  return link ? { PATH: [toolBinOf(c.wave.store.dir), link, process.env.PATH ?? ''].filter(Boolean).join(delimiter) } : {};
}

export function sh(c: LotCtx, command: string, timeoutMs = 30 * 60_000, env: Record<string, string> = {}, cwd = wd(c)): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...withoutLaunchVars(process.env), ...nodePath(c), ...(c.wave.testWorkers ? { [TEST_WORKERS_ENV]: String(c.wave.testWorkers) } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pid = child.pid;
    if (pid === undefined) {
      child.once('error', (e) => resolve({ code: 127, output: String(e.message) }));
      return;
    }
    const untrack = trackGroup(pid);
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (d: Buffer) => {
      if (size < 64 * 1024 * 1024) chunks.push(d);
      size += d.length;
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // déjà mort
      }
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      untrack();
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // groupe vide
      }
      resolve({ code: code ?? (signal ? 137 : 1), output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}