import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffDays, toDay, type Day } from './dates.js';

export interface Stale {
  path: string;
  /** Jours depuis la dernière modification. */
  age: number;
}

export const CLEAN_DAYS = 7;

/** `*` ne remplace que des caractères d'un nom : un motif ne traverse jamais un `/`. */
const segmentRe = (seg: string): RegExp =>
  new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

function expand(pattern: string, root: string): string[] {
  const home = homedir();
  const full = pattern === '~' || pattern.startsWith('~/') ? join(home, pattern.slice(1)) : pattern;
  const abs = isAbsolute(full) ? full : join(root, full);
  const parts = abs.split('/').filter((p) => p !== '');
  let found = ['/'];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of found) {
      if (!part.includes('*')) {
        const p = join(base, part);
        if (existsSync(p)) next.push(p);
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      const re = segmentRe(part);
      // Comme le shell : `*` n'attrape pas un nom en « . » sauf si le motif commence lui-même par « . ».
      for (const n of names) if (re.test(n) && (part.startsWith('.') || !n.startsWith('.'))) next.push(join(base, n));
    }
    found = next;
  }
  return found;
}

/** Vrai si ce chemin est un dépôt git ou en contient un, à n'importe quelle profondeur : un clone n'est jamais à supprimer. */
function holdsRepo(path: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.name === '.git')) return true;
  return entries.some((e) => e.isDirectory() && holdsRepo(join(path, e.name)));
}

/** Date de modification la plus récente d'un chemin ou, pour un dossier, de tout son contenu (liens non suivis). */
function newestMtime(path: string): Date {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    // Illisible ou disparu pendant le parcours : on ne peut pas affirmer qu'il est périmé, il compte comme récent.
    return new Date();
  }
  let newest = st.mtime;
  if (!st.isDirectory()) return newest;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return newest;
  }
  for (const n of names) {
    const m = newestMtime(join(path, n));
    if (m > newest) newest = m;
  }
  return newest;
}

/** Vrai si git suit ce chemin (ou un fichier dessous), dans le dépôt qui le contient : on ne propose jamais de supprimer du versionné. */
function tracked(path: string): boolean {
  const git = (cwd: string, args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const top = git(dirname(path), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return false;
  const rel = relative(top.stdout.trim(), join(realpathSync(dirname(path)), basename(path)));
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
  const r = git(top.stdout.trim(), ['ls-files', '--', rel]);
  return r.status === 0 && r.stdout.trim() !== '';
}

/**
 * Éléments qui correspondent aux motifs et n'ont pas été modifiés depuis plus de `days` jours,
 * du plus vieux au plus récent. Ne supprime rien.
 */
export function staleFiles(root: string, patterns: string[], days: number, today: Day): Stale[] {
  const seen = new Map<string, Stale>();
  for (const pattern of patterns) {
    for (const path of expand(pattern, root)) {
      if (seen.has(path) || path === root || path.split('/').includes('.git')) continue;
      const age = diffDays(toDay(newestMtime(path)), today);
      if (age > days && !holdsRepo(path) && !tracked(path)) seen.set(path, { path, age });
    }
  }
  return [...seen.values()].sort((a, b) => b.age - a.age || a.path.localeCompare(b.path));
}
