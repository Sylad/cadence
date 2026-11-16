// L745 (issue #62) : un run fini en conflit dont l'unique commit a été intégré à la main sur main restait « conflit » dans --liste, worktree et branche gardés.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, git } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const ioTest = (cwd: string) => { const sortie: string[] = []; return { cwd, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };
const lancer = async (repo: string, ...a: string[]) => { const io = ioTest(repo), code = await cmdRun(a, io); return { code, texte: io.sortie.join('\n') }; };
const branche = (repo: string, b: string) => git(repo, 'branch', '--list', b) !== '';

/** Un run fini en « conflit » : sa session commite fait.txt, main en commite un autre, et la reprise pour résoudre ne fait rien. */
function runEnConflit(): { repo: string; e: Etat } {
  const repo = depot();
  const travail = (cwd: string) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'autre'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'fait.txt ailleurs'); };
  const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([travail, () => {}]), out: () => {}, attendre: null });
  expect(e.etat).toBe('conflit');
  expect(existsSync(e.worktree)).toBe(true);
  return { repo, e };
}

describe('cadence run --liste et --clore : un run intégré à la main (L745, issue #62)', () => {
  it('commits absents de main : --liste dit « conflit », --clore refuse en nommant le commit et ne retire rien', async () => {
    const { repo, e } = runEnConflit();
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  conflit  Crée fait.txt`, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(1);
    expect(r.texte).toMatch(/refusé : 1 commit\(s\) du run absent\(s\) de main : [0-9a-f]{7} ajoute fait\.txt ; intègre-les d'abord/);
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toBeUndefined();
  });

  it('commit fusionné à la main sur main : --liste dit « integre a la main », --clore retire worktree et branche et le note ; --liste dit clos', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    expect(git(repo, 'log', '--oneline', `main..${e.branche}`)).toBe(''); // la situation de l'issue
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(était conflit ; worktree et branche : cadence run --clore ${e.id}\\)  Crée`, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(0);
    expect(r.texte).toMatch(/clos — tous ses commits sont sur main/);
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(e.worktree);
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
    expect(etat.etat).toBe('conflit');
    expect(etat.clos?.cible).toBe(git(repo, 'rev-parse', 'main'));
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(main = [0-9a-f]{7}\\), clos le \\d{4}-\\d\\d-\\d\\d \\(était conflit\\)`, 'm'));
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 0, texte: expect.stringMatching(/déjà clos/) });
  });

  it('même patch rejoué à la main (cherry-pick), worktree et branche retirés à la main : la tête notée à la fin du run suffit', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'revert', '--no-edit', 'HEAD'); // retire « fait.txt ailleurs » : le commit du run s'applique tel quel
    git(repo, ...ID, 'cherry-pick', e.branche);
    git(repo, 'worktree', 'remove', '--force', e.worktree); git(repo, 'branch', '-D', e.branche);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(était conflit`, 'm'));
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toBeDefined();
  });

  it('refus : run qui se reprend (attente), worktree avec des modifications non commitées, id inconnu', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    writeFileSync(join(e.worktree, 'brouillon.txt'), 'x');
    const sale = await lancer(repo, '--clore', e.id);
    expect(sale).toMatchObject({ code: 1, texte: expect.stringMatching(/modifications non commitées : brouillon\.txt/) });
    expect(existsSync(e.worktree)).toBe(true);
    writeFileSync(e.fichier, JSON.stringify({ ...JSON.parse(readFileSync(e.fichier, 'utf8')), etat: 'attente' }));
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  attente  `, 'm'));
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/le run est attente : il se reprend/) });
    expect((await lancer(repo, '--clore', 'inconnu')).code).toBe(1);
    expect((await lancer(repo, '--clore')).code).toBe(2);
  });
});
