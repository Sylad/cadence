import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Day } from './dates.js';
import { gitPath } from './git.js';

/** Dossier d'état local de cadence (notes de clôture, verrou et journal des livraisons). */
export function stateDir(cwd: string): string {
  const dir = gitPath(cwd, 'cadence');
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

export function readLock(dir: string): Lock | null {
  const file = join(dir, 'deliver.lock');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { pid: Number(raw.pid), sha: String(raw.sha), started: String(raw.started) };
  } catch {
    // Un verrou illisible est traité comme appartenant à un processus mort.
    return { pid: 0, sha: '?', started: '?' };
  }
}

/** Crée le verrou ; renvoie false s'il existe déjà (création exclusive). */
export function writeLock(dir: string, lock: Lock): boolean {
  try {
    writeFileSync(join(dir, 'deliver.lock'), JSON.stringify(lock), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function removeLock(dir: string): void {
  rmSync(join(dir, 'deliver.lock'), { force: true });
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
