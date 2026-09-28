import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cadence-'));
}

export function gitRepo(): string {
  const dir = tempDir();
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  return dir;
}

export function commit(dir: string, message: string, date = '2026-09-28T10:00:00'): void {
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}
