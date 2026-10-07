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

/** Remplace les notes pour la prochaine session. Ne les efface jamais : c'est `clearNext`, demandé exprès. */
export function writeNext(dir: string, date: Day, lines: string[]): void {
  if (lines.length === 0) throw new Error('writeNext : aucune ligne');
  writeFileSync(join(dir, 'next.md'), `# ${date}\n${lines.map((l) => `- ${l.replace(/\n/g, ' ')}`).join('\n')}\n`);
}

/** Efface les notes pour la prochaine session ; rend celles qui s'y trouvaient, null s'il n'y en avait pas. */
export function clearNext(dir: string): Next | null {
  const previous = readNext(dir);
  rmSync(join(dir, 'next.md'), { force: true });
  return previous;
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

/** Pose un fichier de façon atomique (lien vers un fichier complet : il n'existe jamais à moitié écrit) ; false s'il existe déjà (EEXIST) ; toute autre erreur est relancée. `tag` distingue les fichiers temporaires d'un même processus. */
export function linkNewFile(file: string, content: string, tag: string | number): boolean {
  const tmp = `${file}.${tag}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    // Seul EEXIST veut dire « déjà là » ; EPERM, EMLINK… (pas de liens physiques ici) remontent au lieu de passer pour un verrou tenu.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Retire un verrou périmé seulement s'il est encore celui qu'on a lu : il est écarté par renommage, `same` relit
 * l'écart, et s'il a changé il est rendu à son nouveau porteur. Partagé par le verrou de livraison et celui de l'URL UX.
 */
export function removeStaleFile(file: string, same: (aside: string) => boolean): boolean {
  const aside = `${file}.stale.${process.pid}`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  if (same(aside)) {
    rmSync(aside, { force: true });
    return true;
  }
  // Un autre processus a pris le verrou entre-temps : le lui rendre.
  try {
    linkSync(aside, file);
  } catch {
    // Un troisième l'a déjà repris : le sien fait foi.
  }
  rmSync(aside, { force: true });
  return false;
}

/** Cause d'une pose de verrou impossible, en une ligne : « verrou <chemin> : <errno> » (le code, sinon le message). */
export function lockFault(file: string, e: unknown): string {
  return `verrou ${file} : ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
}

/** Pose le verrou de façon atomique (lien vers un fichier complet) ; false s'il existe déjà. */
export function writeLock(dir: string, lock: Lock): boolean {
  return linkNewFile(lockPath(dir), JSON.stringify(lock), lock.pid);
}

/** Retire un verrou périmé seulement s'il est encore celui qu'on a lu ; sinon le laisse en place. */
export function removeStaleLock(dir: string, seen: Lock): boolean {
  return removeStaleFile(lockPath(dir), (aside) => {
    const now = readLockFile(aside);
    return !!now && now.pid === seen.pid && now.sha === seen.sha && now.started === seen.started;
  });
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
