import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addDays, toDay } from '../src/dates.js';
import { assertInside, removeTree } from './tmp-hygiene.js';

const created: string[] = [];

/** Dossier temporaire du test, supprimé à la fin du fichier de test (voir setup-env.ts). */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-'));
  created.push(dir);
  return dir;
}

/** Supprime les dossiers créés par tempDir() dans ce fichier de test, droits rendus avant suppression. */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) removeTree(dir);
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

/**
 * `cadence orchestrate --dry-run` laisse exprès un dossier /tmp/cadence-orchestrate-* pour que l'humain relise
 * les briefs (comportement du produit). Un test qui le lance supprime le sien : il passe la sortie de la commande,
 * on retrouve les lignes « brief : <chemin> » et on supprime le dossier qui les contient.
 */
export function removeDryRunBriefs(output: string): void {
  const root = process.env.CADENCE_TEST_TMP_ROOT;
  // Ligne entière (un chemin temporaire peut contenir des espaces : /Users/John Doe/tmp, C:\\Users\\Sylvain Ladoire\\…).
  const targets = [...output.matchAll(/^\s*brief : (.+?)\s*$/gm)].map((m) => dirname(m[1]!));
  // Tout est validé AVANT la première suppression : une seule cible suspecte et rien n'est supprimé.
  for (const dir of targets) {
    assertInside(dir, root);
    if (!basename(dir).startsWith('cadence-orchestrate-')) {
      throw new Error(`Suppression refusée : ${dir} n'est pas un dossier cadence-orchestrate-*.`);
    }
  }
  for (const dir of targets) removeTree(dir);
}

/** Paquet jetable construit depuis src/ par le global-setup (jamais le dist/ en service) : voir test/global-setup.ts. */
export function testPackage(): string {
  const pkg = process.env.CADENCE_TEST_PACKAGE;
  if (!pkg) throw new Error('CADENCE_TEST_PACKAGE absent : le global-setup de vitest construit le paquet jetable.');
  return pkg;
}
