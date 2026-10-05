import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

export interface Commit {
  sha: string;
  day: string;
  subject: string;
  body: string;
}

function git(cwd: string, args: string[]): string {
  // Le journal complet d'un gros dépôt dépasse le Mo par défaut : sans marge, il serait lu comme vide.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024 });
}

export function gitRoot(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Commits reachable from HEAD, newest first. Empty when the repo has no commit yet. */
export function readCommits(cwd: string, opts: { since?: string; range?: string } = {}): Commit[] {
  const args = ['log', `--format=%H${FIELD}%cs${FIELD}%s${FIELD}%b${RECORD}`];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.range) args.push(opts.range);
  let out: string;
  try {
    out = git(cwd, args);
  } catch {
    return [];
  }
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, day, subject, body = ''] = r.split(FIELD);
      return { sha, day, subject, body: body.trim() };
    });
}

/**
 * Dossier où git exécute réellement les hooks : gère worktrees, core.hooksPath
 * (y compris « ~/… ») et Husky v9, dont `.husky/_` est généré — les hooks à la main vont dans `.husky/`.
 */
export function hooksDir(cwd: string): string {
  const dir = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'hooks']).trim());
  return basename(dir) === '_' && basename(dirname(dir)) === '.husky' ? dirname(dir) : dir;
}

/** Fichiers modifiés par un commit, relatifs à la racine du dépôt (noms accentués ou à espaces compris). */
export function changedFiles(cwd: string, sha: string): string[] {
  // -z : noms séparés par NUL, jamais échappés ; quotepath=off en plus pour les sorties qui citeraient quand même.
  return git(cwd, ['-c', 'core.quotepath=off', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha]).split('\0').filter(Boolean);
}

/** Contenu d'un fichier à un commit (`<sha>^` pour l'état d'avant) ; null s'il n'existe pas à ce commit. */
export function fileAt(cwd: string, rev: string, file: string): string | null {
  try {
    return git(cwd, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

/** Sha complet de HEAD, null tant que le dépôt n'a aucun commit. */
export function headSha(cwd: string): string | null {
  return tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
}

/** Sha complet du commit que désigne `rev` (sha abrégé, branche, tag), null s'il n'existe pas. */
export function resolveCommit(cwd: string, rev: string): string | null {
  return tryGit(cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
}

export interface RepoStatus {
  /** null en HEAD détachée. */
  branch: string | null;
  /** Fichiers suivis modifiés (index ou arbre de travail). */
  dirty: number;
  untracked: number;
  /** Branche amont, null s'il n'y en a pas. */
  upstream: string | null;
  /** Commits locaux absents de l'amont. */
  ahead: number;
}

export function repoStatus(cwd: string): RepoStatus {
  const lines = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const upstream = tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const ahead = upstream && headSha(cwd) ? Number(tryGit(cwd, ['rev-list', '--count', '@{u}..HEAD']) ?? 0) : 0;
  return {
    branch: tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    dirty: lines.length - untracked,
    untracked,
    upstream,
    ahead,
  };
}

/** Branche amont suivie (« origin/main ») et son sha tel que connu localement (sans réseau), null sans amont. */
export function upstreamHead(cwd: string): { ref: string; sha: string } | null {
  const ref = tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const sha = ref ? tryGit(cwd, ['rev-parse', '--verify', '-q', '@{u}']) : null;
  return ref && sha ? { ref, sha } : null;
}

/** Le commit est-il contenu dans une branche distante connue localement ? */
export function onRemote(cwd: string, sha: string): boolean {
  return (tryGit(cwd, ['branch', '-r', '--contains', sha]) ?? '').length > 0;
}

/** Chemin d'un fichier propre au dépôt local, dans le dossier git (jamais commité, un par worktree). */
export function gitPath(cwd: string, name: string): string {
  return resolve(cwd, git(cwd, ['rev-parse', '--git-path', name]).trim());
}

/** Dossier git commun à tous les worktrees du dépôt. */
export function gitCommonDir(cwd: string): string {
  return resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim());
}

/** `a` est-il un ancêtre de `b` (objets présents) ? */
export function isAncestor(cwd: string, a: string, b: string): boolean {
  return tryGit(cwd, ['merge-base', '--is-ancestor', a, b]) !== null;
}

/**
 * Instant (ms), date d'auteur (conservée par rebase, amend, cherry-pick), du commit qui a ajouté chaque fichier
 * de `dir` SOUS CE NOM (--no-renames : un renommage compte comme un ajout, l'historique antérieur n'est pas suivi),
 * clé = chemin relatif à `dir`.
 * Vide hors d'un dépôt git ; un fichier jamais commité en est absent.
 */
export function addedTimes(dir: string): Map<string, number> {
  const times = new Map<string, number>();
  let out: string;
  try {
    // quotepath=off + -z : noms accentués tels quels, sans guillemets ni échappement octal.
    out = git(dir, ['-c', 'core.quotepath=off', 'log', '-z', '--diff-filter=A', '--no-renames', '--relative', '--name-only', `--format=${RECORD}%aI`, '--', '.']);
  } catch {
    return times;
  }
  // Enregistrement = RECORD date \0 \n nom \0 nom \0 … ; le plus ancien ajout l'emporte.
  for (const record of out.split(RECORD).filter(Boolean)) {
    const [stamp, ...files] = record.split('\0');
    const t = Date.parse(stamp);
    for (const [i, f] of files.entries()) {
      const name = i === 0 ? f.replace(/^\n/, '') : f;
      if (name) times.set(name, Math.min(t, times.get(name) ?? Infinity));
    }
  }
  return times;
}
