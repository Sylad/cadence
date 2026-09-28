import { execFileSync } from 'node:child_process';

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

export function gitDir(cwd: string): string {
  return git(cwd, ['rev-parse', '--absolute-git-dir']).trim();
}

export function hooksDir(cwd: string): string {
  const custom = (() => {
    try {
      return git(cwd, ['config', '--get', 'core.hooksPath']).trim();
    } catch {
      return '';
    }
  })();
  if (custom) return custom.startsWith('/') ? custom : `${gitRoot(cwd)}/${custom}`;
  return `${gitDir(cwd)}/hooks`;
}
