import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { GIT_REPO_VARS, stripGitRepoVars } from './git-env-hygiene.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });

describe('la suite ne fuit pas GIT_DIR dans un dépôt jetable (L677)', () => {
  it('R1 — la suite démarre sans GIT_DIR, GIT_INDEX_FILE ni GIT_WORK_TREE', () => {
    for (const n of GIT_REPO_VARS) expect(process.env[n], n).toBeUndefined();
  });

  it('R2 — un commit de dépôt jetable lancé sous les variables d’un hook ne touche pas le vrai dépôt', () => {
    const real = tempDir();
    const scratch = tempDir();
    const clean = { ...process.env } as NodeJS.ProcessEnv;
    for (const n of GIT_REPO_VARS) delete clean[n];
    git(real, clean, 'init', '-q');
    writeFileSync(join(real, 'a'), 'a');
    git(real, clean, 'add', 'a');
    git(real, clean, 'commit', '-q', '-m', 'vrai message');
    git(scratch, clean, 'init', '-q');
    writeFileSync(join(scratch, 'b'), 'b');

    // ce que git exporte au hook pre-commit du dépôt réel
    const hookEnv = { ...clean, GIT_DIR: join(real, '.git'), GIT_INDEX_FILE: join(real, '.git', 'index'), GIT_WORK_TREE: real };
    const env = stripGitRepoVars(hookEnv);
    git(scratch, env, 'add', 'b');
    expect(git(scratch, env, 'commit', '-q', '-m', 'base').status).toBe(0);

    expect(git(real, clean, 'log', '--format=%s').stdout.trim()).toBe('vrai message');
    expect(git(scratch, clean, 'log', '--format=%s').stdout.trim()).toBe('base');
    // sans le retrait, la fuite est réelle : le commit « base » atterrit dans le vrai dépôt
    git(scratch, hookEnv, 'commit', '-q', '--allow-empty', '-m', 'fuite');
    expect(git(real, clean, 'log', '--format=%s', '-1').stdout.trim()).toBe('fuite');
  });
});
