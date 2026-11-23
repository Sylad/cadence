// L807 : `cadence news new` lancé dans une session de cadence run écrit l'entrée dans le worktree du run, jamais dans l'arbre principal. Le 22-11
// (warhammer L98 r1), le squelette laissé dans l'arbre principal a fait refuser l'intégration du run (fichier que le run modifie aussi).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';

function raf(cwd: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-09-28', ...env }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-09-28T09:30:00') });
  return { code, out: out.join('\n') };
}

/** Un dépôt avec un lot visible commité, et un worktree du run sur une branche à lui (comme cadence run le crée). */
function depotEtWorktree() {
  const main = gitRepo();
  raf(main, {}, 'init', '--project', 'demo');
  raf(main, {}, 'add', 'Un', 'lot', '--visible');
  execFileSync('git', ['add', '-A'], { cwd: main });
  commit(main, 'init');
  const wt = join(tempDir(), 'demo-run');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'cadence/run-1', wt, 'HEAD'], { cwd: main });
  return { main, wt };
}

const entrees = (repo: string) => (existsSync(join(repo, 'docs/nouveautes')) ? readdirSync(join(repo, 'docs/nouveautes')).filter((f) => f.endsWith('.md')) : []);
const sale = (repo: string) => execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();

describe('news new dans une session de cadence run (L807)', () => {
  it('lancé depuis le worktree du run : l\'entrée est dans le worktree, l\'arbre principal reste propre', () => {
    const { main, wt } = depotEtWorktree();
    const r = raf(wt, { CADENCE_CLONE: wt }, 'news', 'new', 'L1', '--title', 'Une nouveauté');
    expect(r.code).toBe(0);
    expect(entrees(wt)).toEqual(['2026-09-28-une-nouveaute.md']);
    expect(entrees(main)).toEqual([]);
    expect(sale(main)).toBe('');
  });

  it('lancé depuis l\'arbre principal (cd de la session) : l\'entrée va quand même dans le worktree du run', () => {
    const { main, wt } = depotEtWorktree();
    const r = raf(main, { CADENCE_CLONE: wt }, 'news', 'new', 'L1', '--title', 'Une nouveauté');
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(wt, 'docs/nouveautes/2026-09-28-une-nouveaute.md'));
    expect(entrees(wt)).toEqual(['2026-09-28-une-nouveaute.md']);
    expect(entrees(main)).toEqual([]);
    expect(sale(main)).toBe('');
  });

  it('depuis un sous-dossier de l\'arbre principal aussi', () => {
    const { main, wt } = depotEtWorktree();
    mkdirSync(join(main, 'frontend'));
    expect(raf(join(main, 'frontend'), { CADENCE_CLONE: wt }, 'news', 'new', 'L1', '--title', 'Une nouveauté').code).toBe(0);
    expect(entrees(wt)).toHaveLength(1);
    expect(entrees(main)).toEqual([]);
  });

  it('hors run (pas de CADENCE_CLONE) ou CADENCE_CLONE d\'un autre dépôt : le dossier courant fait foi', () => {
    const { main } = depotEtWorktree();
    const autre = gitRepo();
    expect(raf(main, { CADENCE_CLONE: autre }, 'news', 'new', 'L1', '--title', 'Une nouveauté').code).toBe(0);
    expect(entrees(main)).toEqual(['2026-09-28-une-nouveaute.md']);
    expect(entrees(autre)).toEqual([]);
    const seul = depotEtWorktree();
    expect(raf(seul.main, {}, 'news', 'new', 'L1', '--title', 'Une nouveauté').code).toBe(0);
    expect(entrees(seul.main)).toHaveLength(1);
  });

  it('--dir explicite reste respecté', () => {
    const { main, wt } = depotEtWorktree();
    expect(raf(main, { CADENCE_CLONE: wt }, 'news', 'new', 'L1', '--title', 'Une nouveauté', '--dir', 'ailleurs').code).toBe(0);
    expect(readdirSync(join(main, 'ailleurs'))).toHaveLength(1);
    expect(entrees(wt)).toEqual([]);
  });
});
