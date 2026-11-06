import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { refDepartLot, retardSurBranche } from '../scripts/qualite.mjs';
import { redExcerpt, redTestsText } from '../src/orchestrate/cycle/checks.js';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

const QUALITE = join(process.cwd(), 'scripts/qualite.mjs');

function depot() {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (n: string) => { writeFileSync(join(dir, `f${n}.txt`), n); git('add', '--', `f${n}.txt`); git('commit', '-qm', `c${n}`); };
  commit('0');
  return { dir, git, commit };
}

describe('L645 bords — le refus d’un origin/<branche> en retard', () => {
  it('une branche à slash : origin/feature/x en retard de 2 commits est refusée avec son nom', () => {
    const { dir, git, commit } = depot();
    git('checkout', '-qb', 'feature/x');
    git('update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    commit('1'); commit('2');
    expect(retardSurBranche(dir, 'origin/feature/x')?.texte).toContain('origin/feature/x est en retard de 2 commits sur feature/x');
  });

  it('origin/main en avance sur main (main en retard) : pas de refus', () => {
    const { dir, git, commit } = depot();
    commit('1');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(retardSurBranche(dir, 'origin/main')).toBeNull();
    expect(refDepartLot(dir)).toBe('origin/main');
  });

  it('origin/main absent alors que main existe : pas de refus ni de « en retard de 0 »', () => {
    const { dir } = depot();
    expect(retardSurBranche(dir, 'origin/main')).toBeNull();
  });

  it('la ligne de commande refuse aussi en mode --ecrire, sans rien écrire', () => {
    const { dir, git, commit } = depot();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    commit('1');
    const r = spawnSync('node', [QUALITE, '--ecrire', '--contre', 'origin/main'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('origin/main est en retard de 1 commit sur main');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('la ligne de commande avec --contre main (la porte) ne refuse pas pour retard', () => {
    const { dir, git, commit } = depot();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    commit('1');
    const r = spawnSync('node', [QUALITE, '--contre', 'main'], { cwd: dir, encoding: 'utf8' });
    expect(r.stderr).not.toContain('en retard');
  });
});

describe('L645 bords — les 20 premières lignes du test rouge au journal', () => {
  const journal = (sortie: string) => redExcerpt({ source: 'tests', gravite: 'bloquant', texte: redTestsText('npx vitest run', 1, sortie) });

  it('un bloc dont les lignes commencent par « - » (diff vitest) reste dans l’ordre, sans être pris pour des tests nommés', () => {
    const sortie = [' FAIL  test/a.test.ts > R1', 'AssertionError: x', '- Expected', '+ Received', '- origin/main est en retard de 4 commits sur main'].join('\n');
    const j = journal(sortie);
    expect(j).toContain('origin/main est en retard de 4 commits sur main');
    expect(j).toContain('- test/a.test.ts > R1');
  });

  it('le FAIL nommé est tout au bout d’une sortie de 200 lignes : son début est gardé', () => {
    const bruit = Array.from({ length: 200 }, (_, i) => `bruit${i}`);
    const sortie = [...bruit, ' FAIL  test/a.test.ts > R1', 'MESSAGE-DU-REFUS', 'x'].join('\n');
    expect(journal(sortie)).toContain('MESSAGE-DU-REFUS');
  });

  it('sortie colorée (ANSI) et préfixe de projet vitest : le message est gardé', () => {
    const sortie = ['\u001b[31m FAIL \u001b[39m |unit| test/a.test.ts > R1', '\u001b[31mMESSAGE-ANSI\u001b[39m'].join('\n');
    const j = journal(sortie);
    expect(j).toContain('MESSAGE-ANSI');
    expect(j).not.toContain('\u001b');
  });

  it('un nom de test à « :» ou « » » ne casse pas la relecture du marqueur', () => {
    const sortie = [' FAIL  test/a.test.ts > R1 « x » :', 'a', 'b'].join('\n');
    const j = journal(sortie);
    expect(j.endsWith('a ; b')).toBe(true);
  });

  it('exactement 20 lignes puis une 21e : la 21e est absente, la 20e présente ; avec 5 lignes : toutes', () => {
    const l = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}x`);
    const j20 = journal([' FAIL  test/a.test.ts > R1', ...l(21)].join('\n'));
    expect(j20).toContain('L20x');
    expect(j20).not.toContain('L21x');
    const j5 = journal([' FAIL  test/a.test.ts > R1', ...l(5)].join('\n'));
    expect(j5).toContain('L5x');
  });

  it('un constat ancien (sans marqueur) passe encore par redExcerpt', () => {
    expect(redExcerpt({ source: 'tests', gravite: 'bloquant', texte: 'cmd en échec (code 1) :\n- a > b\nfin' })).toBe('cmd en échec (code 1) ; - a > b');
  });
});
