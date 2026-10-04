import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pidAlive } from '../state.js';

export interface OLock {
  pid: number;
  wave: string;
  started: string;
}

/** Nom du verrou d'orchestration d'un dépôt, dans l'état commun aux worktrees (celui de `deliver`). */
export const REPO_LOCK = 'orchestrate.lock';

function read(file: string): (OLock & { unreadable?: boolean; ageMs: number }) | null {
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
    return { pid: Number(raw.pid), wave: String(raw.wave), started: String(raw.started), ageMs };
  } catch {
    return { pid: 0, wave: '?', started: '?', unreadable: true, ageMs };
  }
}

const alive = (l: { pid: number; unreadable?: boolean; ageMs: number }) => (l.unreadable ? l.ageMs < 5_000 : pidAlive(l.pid));

/** Le verrou s'il est tenu par un processus vivant, sinon null (absent ou périmé). */
export function activeLock(file: string): OLock | null {
  const l = read(file);
  return l && alive(l) ? l : null;
}

/**
 * Pose le verrou (lien vers un fichier complet : atomique). Un verrou de pid mort est retiré — `stale` le
 * dit pour avertir. `held` : le porteur vivant quand la pose échoue.
 */
export function takeLock(file: string, lock: OLock): { ok: true; stale?: OLock } | { ok: false; held: OLock } {
  let stale: OLock | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = join(dirname(file), `.orchestrate.lock.${lock.pid}.${Date.now()}.${attempt}.tmp`);
    writeFileSync(tmp, JSON.stringify(lock));
    try {
      linkSync(tmp, file);
      return stale ? { ok: true, stale } : { ok: true };
    } catch {
      // déjà là
    } finally {
      rmSync(tmp, { force: true });
    }
    const seen = read(file);
    if (!seen) continue;
    if (alive(seen)) return { ok: false, held: seen };
    // périmé : l'écarter seulement s'il est encore celui qu'on a lu
    const aside = `${file}.stale.${process.pid}`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    const now = read(aside);
    if (now && now.pid === seen.pid && now.wave === seen.wave && now.started === seen.started) {
      stale = { pid: seen.pid, wave: seen.wave, started: seen.started };
      rmSync(aside, { force: true });
    } else {
      try {
        linkSync(aside, file);
      } catch {
        // repris par un tiers
      }
      rmSync(aside, { force: true });
    }
  }
  const held = read(file);
  return { ok: false, held: held ?? lock };
}

/** Retire le verrou s'il appartient à ce pid. */
export function releaseLock(file: string, pid: number): void {
  const l = read(file);
  if (l && l.pid === pid) rmSync(file, { force: true });
}
