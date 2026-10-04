import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addDays, toDay } from '../src/dates.js';

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

/*
 * Le nettoyage mesure l'âge sur max(mtime, ctime) et le ctime d'un fichier ne se fixe pas : il vaut
 * toujours « maintenant ». Les tests ne peuvent donc pas vieillir un fichier en 2026-09 comme avant ;
 * ils placent « aujourd'hui » 30 jours dans le futur et datent les fichiers par rapport à lui
 * (le mtime, bien plus récent que le ctime réel, décide alors de l'âge).
 */
export const CLEAN_TODAY = addDays(toDay(new Date()), 30);
/** Date du jour CLEAN_TODAY décalé de `offset` jours (négatif = passé). */
export const cleanAt = (offset: number, time = '10:00:00'): Date => new Date(`${addDays(CLEAN_TODAY, offset)}T${time}`);
