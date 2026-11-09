import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Banc } from './banc.js';

export class FuturVisible extends Error {}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Commande du banc dans son propre groupe, sortie dans le journal ; au retour ou au délai, le groupe entier est tué. */
export function shell(quoi: string, cmd: string, cwd: string, log: string, delaiMs: number): number {
  const fd = openSync(log, 'w');
  try {
    const r = spawnSync('setsid', ['bash', '-c', cmd], { cwd, stdio: ['ignore', fd, fd], timeout: delaiMs, killSignal: 'SIGKILL' });
    if (r.pid) try { process.kill(-r.pid, 'SIGKILL'); } catch { /* groupe déjà vide */ } // jamais kill(0) : ce serait notre propre groupe
    if (r.error || r.signal) throw new Error(`${quoi} : délai de ${delaiMs / 60_000} min dépassé, voir ${log}`);
    return r.status ?? 1;
  } finally { closeSync(fd); }
}

/** Clone de travail d'un bras : à la base, sans remote, sans rien de postérieur (tags, branches, reflog). */
export function preparer(b: Banc, cible: string, delaiMs = 30 * 60_000): { testsBase: number } {
  rmSync(cible, { recursive: true, force: true });
  mkdirSync(dirname(cible), { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', b.source, cible]);
  git(cible, 'checkout', '-q', '-B', 'main', b.base);
  git(cible, 'remote', 'remove', 'origin');
  for (const br of git(cible, 'branch', '--format=%(refname:short)').split('\n')) if (br && br !== 'main') git(cible, 'branch', '-D', '-q', br);
  for (const t of git(cible, 'tag').split('\n').filter(Boolean)) if (spawnSync('git', ['merge-base', '--is-ancestor', t, 'HEAD'], { cwd: cible }).status !== 0) git(cible, 'tag', '-d', t);
  git(cible, 'reflog', 'expire', '--expire=now', '--all');
  git(cible, 'gc', '-q', '--prune=now');
  const futur = git(cible, 'rev-list', '--all', '--not', 'HEAD');
  if (futur) throw new FuturVisible(`banc ${b.id} : ${futur.split('\n').length} commit(s) postérieur(s) à la base restent joignables`);
  if (shell('install', b.install, cible, `${cible}.install.log`, delaiMs) !== 0) throw new Error(`install : voir ${cible}.install.log`);
  return { testsBase: shell('tests', b.tests, cible, `${cible}.tests-base.log`, delaiMs) };
}
