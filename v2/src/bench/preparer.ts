import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Banc } from './banc.js';

export class FuturVisible extends Error {}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function shell(cmd: string, cwd: string, log: string): number {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  writeFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status ?? 1;
}

/** Clone de travail d'un bras : à la base, sans remote, sans rien de postérieur (tags, branches, reflog). */
export function preparer(b: Banc, cible: string): { testsBase: number } {
  rmSync(cible, { recursive: true, force: true });
  mkdirSync(dirname(cible), { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', b.source, cible]);
  git(cible, 'checkout', '-q', '-B', 'main', b.base);
  git(cible, 'remote', 'remove', 'origin');
  for (const br of git(cible, 'branch', '--format=%(refname:short)').split('\n')) if (br && br !== 'main') git(cible, 'branch', '-D', '-q', br);
  for (const t of git(cible, 'tag').split('\n').filter(Boolean)) {
    if (spawnSync('git', ['merge-base', '--is-ancestor', t, 'HEAD'], { cwd: cible }).status !== 0) git(cible, 'tag', '-d', t);
  }
  git(cible, 'reflog', 'expire', '--expire=now', '--all');
  git(cible, 'gc', '-q', '--prune=now');
  const futur = git(cible, 'rev-list', '--all', '--not', 'HEAD');
  if (futur) throw new FuturVisible(`banc ${b.id} : ${futur.split('\n').length} commit(s) postérieur(s) à la base restent joignables`);
  shell(b.install, cible, `${cible}.install.log`);
  return { testsBase: shell(b.tests, cible, `${cible}.tests-base.log`) };
}
