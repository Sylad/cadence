import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { refDepartLot, retardSurBranche } from '../scripts/qualite.mjs';
import { redExcerpt, redTestsText } from '../src/orchestrate/cycle/checks.js';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

const QUALITE = join(process.cwd(), 'scripts/qualite.mjs');

/** Un dépôt dont main a `avance` commits de plus que origin/main (posé à la main : pas de remote réel). */
function depot(avance: number, { origin = true }: { origin?: boolean } = {}) {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (n: number) => { writeFileSync(join(dir, `f${n}.txt`), String(n)); git('add', '--', `f${n}.txt`); git('commit', '-qm', `c${n}`); };
  commit(0);
  if (origin) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (let i = 1; i <= avance; i++) commit(i);
  return { dir, git };
}

describe('L645 — le cliquet contre origin/main refuse un origin/main en retard sur main, avant de mesurer', () => {
  it('R1 — origin/main en retard de 2 commits : le refus dit « origin/main est en retard de 2 commits sur main »', () => {
    const { dir } = depot(2);
    const r = retardSurBranche(dir, 'origin/main');
    expect(r?.code).toBe(1);
    expect(r?.texte).toContain('origin/main est en retard de 2 commits sur main');
  });

  it('R1 — un seul commit de retard : le singulier', () => {
    expect(retardSurBranche(depot(1).dir, 'origin/main')?.texte).toContain('en retard de 1 commit sur main');
  });

  it('R1 — origin/main à jour : pas de refus', () => {
    expect(retardSurBranche(depot(0).dir, 'origin/main')).toBeNull();
  });

  it('R1 — une référence qui n’est pas origin/<branche> n’est pas jugée (main, un sha)', () => {
    const { dir } = depot(2);
    expect(retardSurBranche(dir, 'main')).toBeNull();
    expect(retardSurBranche(dir, 'HEAD~1')).toBeNull();
  });

  it('R1 — sans branche locale du même nom (clone de la CI) ou sans origin/main : pas de refus, lireRef dira le reste', () => {
    const { dir, git } = depot(2);
    git('branch', '-m', 'main', 'autre');
    expect(retardSurBranche(dir, 'origin/main')).toBeNull();
    expect(retardSurBranche(depot(0, { origin: false }).dir, 'origin/main')).toBeNull();
  });

  it('R1 — la ligne de commande refuse (code 1) avec ce texte, sans passer par la mesure', () => {
    const { dir } = depot(3);
    const t0 = Date.now();
    const r = spawnSync('node', [QUALITE, '--contre', 'origin/main'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('origin/main est en retard de 3 commits sur main');
    expect(Date.now() - t0).toBeLessThan(10000);
  });
});

describe('L645 — le test compare à la ligne de base du départ du lot', () => {
  it('R2 — origin/main à jour : la référence est origin/main (comme tests.yml)', () => {
    expect(refDepartLot(depot(0).dir)).toBe('origin/main');
  });

  it('R2 — origin/main en retard sur main : la référence est main, le départ du lot (comme la porte)', () => {
    expect(refDepartLot(depot(2).dir)).toBe('main');
  });
});

describe('L645 — le journal garde les 20 premières lignes du test rouge', () => {
  const bloc = Array.from({ length: 60 }, (_, i) => `    ligne${i + 1}`);
  const sortie = [' FAIL  test/a.test.ts > R1 — un', ...bloc, ' FAIL  test/b.test.ts > R2 — deux', '    autre1'].join('\n');
  const texte = redTestsText('npx vitest run', 1, sortie);

  it('R3 — le début du premier test rouge est dans le constat, vingt lignes pas une de plus', () => {
    const journal = redExcerpt({ source: 'tests', gravite: 'bloquant', texte });
    expect(journal).toContain('ligne1 ;');
    expect(journal).toContain('ligne20');
    expect(journal).not.toContain('ligne21');
    expect(journal).toContain('test/a.test.ts > R1 — un');
  });

  it('R3 — le bloc s’arrête au test rouge suivant', () => {
    const court = redTestsText('c', 1, [' FAIL  test/a.test.ts > R1', '  e1', '  e2', ' FAIL  test/b.test.ts > R2', '  autre'].join('\n'));
    const journal = redExcerpt({ source: 'tests', gravite: 'bloquant', texte: court });
    expect(journal).toContain('e2');
    expect(journal).not.toContain('autre');
  });

  it('R3 — sans test nommé, le constat reste celui d’avant (fin de la sortie)', () => {
    expect(redTestsText('cmd', 2, 'a\nb')).toBe('cmd en échec (code 2) :\na\nb');
  });
});
