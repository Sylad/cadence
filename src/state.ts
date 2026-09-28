import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Day } from './dates.js';
import { gitCommonDir, gitPath } from './git.js';

/** État local propre au worktree (notes de clôture). */
export function stateDir(cwd: string): string {
  const dir = gitPath(cwd, 'cadence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** État local commun à tous les worktrees (verrou et journal des livraisons) : une seule livraison par dépôt. */
export function sharedStateDir(cwd: string): string {
  const dir = join(gitCommonDir(cwd), 'cadence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Next {
  date: Day;
  lines: string[];
}

export function readNext(dir: string): Next | null {
  const file = join(dir, 'next.md');
  if (!existsSync(file)) return null;
  const [head, ...rest] = readFileSync(file, 'utf8').split('\n');
  const lines = rest.map((l) => l.replace(/^- /, '')).filter(Boolean);
  return { date: head.replace(/^# /, '').trim(), lines };
}

/** Remplace les notes pour la prochaine session ; sans ligne, les efface. */
export function writeNext(dir: string, date: Day, lines: string[]): void {
  const file = join(dir, 'next.md');
  if (lines.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `# ${date}\n${lines.map((l) => `- ${l.replace(/\n/g, ' ')}`).join('\n')}\n`);
}

export interface Lock {
  pid: number;
  sha: string;
  started: string;
}

export function lockPath(dir: string): string {
  return join(dir, 'deliver.lock');
}

function readLockFile(file: string): (Lock & { unreadable?: boolean; ageMs: number }) | null {
  let text: string;
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text);
    return { pid: Number(raw.pid), sha: String(raw.sha), started: String(raw.started), ageMs };
  } catch {
    return { pid: 0, sha: '?', started: '?', unreadable: true, ageMs };
  }
}

export function readLock(dir: string): (Lock & { unreadable?: boolean; ageMs: number }) | null {
  return readLockFile(lockPath(dir));
}

/** Verrou tenu : processus vivant, ou fichier illisible mais tout récent (écriture en cours ailleurs). */
export function lockAlive(lock: { pid: number; unreadable?: boolean; ageMs: number }): boolean {
  return lock.unreadable ? lock.ageMs < 5_000 : pidAlive(lock.pid);
}

/** Pose le verrou de façon atomique (lien vers un fichier complet) ; false s'il existe déjà. */
export function writeLock(dir: string, lock: Lock): boolean {
  const tmp = join(dir, `deliver.lock.${lock.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(lock));
  try {
    linkSync(tmp, lockPath(dir));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Retire un verrou périmé seulement s'il est encore celui qu'on a lu ; sinon le laisse en place. */
export function removeStaleLock(dir: string, seen: Lock): boolean {
  const aside = join(dir, `deliver.lock.stale.${process.pid}`);
  try {
    renameSync(lockPath(dir), aside);
  } catch {
    return false;
  }
  const now = readLockFile(aside);
  if (now && now.pid === seen.pid && now.sha === seen.sha && now.started === seen.started) {
    rmSync(aside, { force: true });
    return true;
  }
  // Un autre processus a pris le verrou entre-temps : le lui rendre.
  try {
    linkSync(aside, lockPath(dir));
  } catch {
    // Un troisième l'a déjà repris : le sien fait foi.
  }
  rmSync(aside, { force: true });
  return false;
}

/** Retire le verrou s'il appartient à ce processus. */
export function releaseLock(dir: string, pid: number): void {
  const lock = readLock(dir);
  if (lock && lock.pid === pid) rmSync(lockPath(dir), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function appendDelivery(dir: string, day: Day, sha: string): void {
  appendFileSync(join(dir, 'deliveries.log'), `${day} ${sha}\n`);
}

export function lastDelivery(dir: string): string | null {
  const file = join(dir, 'deliveries.log');
  if (!existsSync(file)) return null;
  const last = readFileSync(file, 'utf8').trim().split('\n').pop();
  return last?.split(' ')[1] ?? null;
}
