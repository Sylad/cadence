import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

export interface Commit {
  sha: string;
  day: string;
  subject: string;
  body: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Fichiers modifiés par un commit, relatifs à la racine du dépôt. */
export function changedFiles(cwd: string, sha: string): string[] {
  return git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
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
