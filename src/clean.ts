import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffDays, toDay, type Day } from './dates.js';

/*
 * Nettoyage proposé à la clôture : une règle unique, « mesurer entièrement ou ne pas proposer ».
 * Un élément n'est proposé que si tout ce qui le concerne a pu être lu — le dossier du motif listé,
 * chaque entrée de son contenu examinée, la réponse de git obtenue — et que rien de ce qu'on y a lu
 * ne le protège : dépôt git (ou dossier qui en contient un), chemin sous un segment `.git`,
 * fichier suivi par git. Une lecture refusée ou un élément disparu pendant le parcours ne fait
 * jamais lever : l'élément n'est pas proposé et son chemin est rendu dans `unreadable`.
 */

export interface Stale {
  path: string;
  /** Jours depuis la modification la plus récente de l'élément (de son contenu, pour un dossier). */
  age: number;
}

export interface CleanScan {
  /** Éléments à proposer, du plus vieux au plus récent. */
  stale: Stale[];
  /** Chemins qu'on n'a pas pu lire entièrement (lecture refusée, disparu, git sans réponse) : jamais proposés. */
  unreadable: string[];
}

export const CLEAN_DAYS = 7;

/** Absence ordinaire (rien à cet endroit), à distinguer d'une lecture refusée. */
const missing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** `*` ne remplace que des caractères d'un nom : un motif ne traverse jamais un `/`. */
const segmentRe = (seg: string): RegExp =>
  new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/**
 * Chemins qui correspondent au motif. Chaque niveau est lu par readdir, noms écrits en entier compris :
 * un dossier qu'on ne peut pas lister ne livre rien (et est noté illisible, sauf s'il n'existe pas).
 * Comme le shell, un nom en « . » n'est atteint que par un segment de motif qui commence par « . ».
 */
function expand(pattern: string, root: string, unreadable: Set<string>): string[] {
  const full = pattern === '~' || pattern.startsWith('~/') ? join(homedir(), pattern.slice(1)) : pattern;
  const parts = resolve(root, full).split('/').filter((p) => p !== '');
  let found = ['/'];
  for (const part of parts) {
    const re = segmentRe(part);
    const next: string[] = [];
    for (const base of found) {
      let names: string[];
      try {
        names = readdirSync(base);
      } catch (e) {
        if (!missing(e)) unreadable.add(base);
        continue;
      }
      for (const n of names) if (re.test(n) && (part.startsWith('.') || !n.startsWith('.'))) next.push(join(base, n));
    }
    found = next;
  }
  return found;
}

/**
 * Date de modification la plus récente (ms) d'un chemin et, pour un dossier, de tout son contenu
 * (liens non suivis). `null` quand on ne peut pas l'affirmer périmé : un dépôt git est rencontré
 * (une entrée `.git`, dossier ou fichier), ou une lecture échoue — ce chemin est alors noté illisible.
 */
function measure(path: string, unreadable: Set<string>): number | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    unreadable.add(path);
    return null;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    unreadable.add(path);
    return null;
  }
  if (names.includes('.git')) return null;
  let newest = st.mtimeMs;
  for (const n of names) {
    const m = measure(join(path, n), unreadable);
    if (m === null) return null;
    if (m > newest) newest = m;
  }
  return newest;
}

/** Vrai si un dossier ancêtre (ou le dossier lui-même) porte une entrée `.git` ; `null` si on ne peut pas le savoir. */
function underGit(dir: string): boolean | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      lstatSync(join(d, '.git'));
      return true;
    } catch (e) {
      if (!missing(e)) return null;
    }
    if (d === dirname(d)) return false;
  }
}

/** Environnement sans variables GIT_* : un GIT_DIR hérité (hook) ferait répondre un autre dépôt. */
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/**
 * Suivi git du chemin (ou d'un fichier dessous), demandé à git depuis le dossier du chemin, où qu'il soit :
 * `'tracked'`, `'untracked'`, ou `null` si la réponse n'a pas pu être obtenue (dossier introuvable,
 * `.git` présent mais git en échec — dépôt invalide, propriétaire douteux, git absent).
 */
function gitTracking(path: string): 'tracked' | 'untracked' | null {
  let dir: string;
  try {
    dir = realpathSync(dirname(path));
  } catch {
    return null;
  }
  const inRepo = underGit(dir);
  if (inRepo !== true) return inRepo === false ? 'untracked' : null;
  const r = spawnSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', basename(path)], {
    cwd: dir,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) return null;
  return r.stdout === '' ? 'untracked' : 'tracked';
}

/** Vrai si ce chemin est la racine ou l'un de ses ancêtres : le proposer reviendrait à proposer le dépôt. */
const holdsRoot = (path: string, root: string): boolean => {
  const r = relative(path, resolve(root));
  return !(r === '..' || r.startsWith('../'));
};

/**
 * Parcourt les motifs et rend les éléments périmés (plus de `days` jours) qu'on peut proposer de
 * supprimer, ainsi que ceux qu'on n'a pas pu mesurer. Ne supprime rien et ne lève pas sur une
 * lecture refusée.
 */
export function scanStale(root: string, patterns: string[], days: number, today: Day): CleanScan {
  const unreadable = new Set<string>();
  const done = new Set<string>();
  const stale: Stale[] = [];
  for (const pattern of patterns) {
    for (const path of expand(pattern, root, unreadable)) {
      if (done.has(path)) continue;
      done.add(path);
      if (holdsRoot(path, root) || path.split('/').includes('.git')) continue;
      const newest = measure(path, unreadable);
      if (newest === null) continue;
      const age = diffDays(toDay(new Date(newest)), today);
      if (age <= days) continue;
      const git = gitTracking(path);
      if (git === null) unreadable.add(path);
      if (git !== 'untracked') continue;
      stale.push({ path, age });
    }
  }
  return {
    stale: stale.sort((a, b) => b.age - a.age || a.path.localeCompare(b.path)),
    unreadable: [...unreadable].sort(),
  };
}

/** Éléments périmés à proposer (voir `scanStale`), du plus vieux au plus récent. Ne supprime rien. */
export function staleFiles(root: string, patterns: string[], days: number, today: Day): Stale[] {
  return scanStale(root, patterns, days, today).stale;
}
