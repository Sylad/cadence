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
