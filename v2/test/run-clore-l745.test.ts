// L745 (issue #62) : un run fini en conflit dont l'unique commit a été intégré à la main sur main restait « conflit » dans --liste, worktree et branche gardés.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { integrationManuelle } from '../src/run/clore.js';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, git } from './run-outils.js';
import { dossierTemp } from './temp.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const ioTest = (cwd: string) => { const sortie: string[] = []; return { cwd, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };
const lancer = async (repo: string, ...a: string[]) => { const io = ioTest(repo), code = await cmdRun(a, io); return { code, texte: io.sortie.join('\n') }; };
const branche = (repo: string, b: string) => git(repo, 'branch', '--list', b) !== '';

/** Un run fini en « conflit » : sa session commite fait.txt (et `aussi`, s'il est donné), main en commite un autre, et la reprise pour résoudre ne fait rien. */
function runEnConflit(aussi?: string): { repo: string; e: Etat } {
  const repo = depot();
  const travail = (cwd: string) => { if (aussi) writeFileSync(join(cwd, aussi), 'travail du run'); commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'autre'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'fait.txt ailleurs'); };
  const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([travail, () => {}]), out: () => {}, attendre: null });
  expect(e.etat).toBe('conflit');
  expect(existsSync(e.worktree)).toBe(true);
  return { repo, e };
}

/** Le conflit résolu à la main : cherry-pick du run sur main, fait.txt écrit avec `contenu` (le contenu du run par défaut), cherry-pick --continue. */
function resoudreALaMain(repo: string, e: Etat, contenu = git(repo, 'show', `${e.branche}:fait.txt`), lacher?: string): void {
  expect(() => git(repo, ...ID, 'cherry-pick', e.branche)).toThrow(); // le patch ne s'applique pas tel quel : c'est le conflit du run
  writeFileSync(join(repo, 'fait.txt'), contenu); git(repo, 'add', 'fait.txt');
  if (lacher) git(repo, '--literal-pathspecs', 'rm', '-q', '-f', '--', lacher); // la résolution ne garde pas ce fichier du run
  git(repo, ...ID, '-c', 'core.editor=true', 'cherry-pick', '--continue');
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
  it('revue M1 : conflit résolu à la main (cherry-pick, patch-id différent) avec le contenu du run : reconnu par le contenu, --clore le retire', async () => {
    const { repo, e } = runEnConflit();
    resoudreALaMain(repo, e);
    expect(git(repo, 'cherry', 'main', e.branche)).toMatch(/^\+ /); // git cherry seul ne le reconnaît pas
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(était conflit ; worktree et branche : cadence run --clore ${e.id}\\)`, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r).toMatchObject({ code: 0, texte: expect.stringMatching(/clos — les fichiers du run \(fait\.txt\) ont sur main le contenu de sa tête/) });
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
  });

  it('revue M1 : résolution qui diffère du run : --clore refuse en nommant le fichier et dit comment clore (--force) ; --force le clôt, --liste le dit forcé', async () => {
    const { repo, e } = runEnConflit();
    resoudreALaMain(repo, e, 'ok et autre');
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  conflit  `, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(1);
    expect(r.texte).toMatch(/absent\(s\) de main : [0-9a-f]{7} ajoute fait\.txt ; intègre-les d'abord \(contenu différent sur main : fait\.txt ; si ta résolution/);
    expect(r.texte).toContain(`cadence run --clore ${e.id} --force`);
    expect(existsSync(e.worktree)).toBe(true);
    const f = await lancer(repo, '--clore', e.id, '--force');
    expect(f).toMatchObject({ code: 0, texte: expect.stringMatching(/clos sans preuve d'intégration \(--force\)/) });
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  clos le \\d{4}-\\d\\d-\\d\\d par --force, sans preuve d'intégration \\(était conflit\\)`, 'm'));
  });

  it('revue M2 : --reponse sur un run clos est refusé, sans session, et l\'état reste celui du run clos', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
    const avant = readFileSync(e.fichier, 'utf8'), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    expect(() => repondreRun(e.id, repo, 'reprends', { exec: fauxClaude([], appels), out: () => {}, attendre: null }))
      .toThrow(new RegExp(`${e.id} est clos \\(--clore\\) le \\d{4}-\\d\\d-\\d\\d : worktree et branche retirés, rien à reprendre`));
    expect(appels).toHaveLength(0);
    expect(readFileSync(e.fichier, 'utf8')).toBe(avant);
    expect(await lancer(repo, '--reponse', e.id, 'reprends')).toMatchObject({ code: 1, texte: expect.stringMatching(/est clos/) });
  });

  it('revue m1 : refus de --clore pour un run intégré par cadence run, un run sans commit, une tête inconnue ; --force ne passe pas un worktree sale', async () => {
    const { repo, e } = runEnConflit();
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat, ecrire = (x: Partial<Etat>) => writeFileSync(e.fichier, JSON.stringify({ ...etat, ...x }));
    ecrire({ etat: 'integre' });
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/intégré par cadence run/) });
    ecrire({ base: git(repo, 'rev-parse', e.branche) });
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/aucun commit/) });
    ecrire({});
    writeFileSync(join(e.worktree, 'brouillon.txt'), 'x');
    expect(await lancer(repo, '--clore', e.id, '--force')).toMatchObject({ code: 1, texte: expect.stringMatching(/non commitées : brouillon\.txt/) });
    git(repo, 'worktree', 'remove', '--force', e.worktree); git(repo, 'branch', '-D', e.branche); ecrire({ tete: undefined });
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/tête du run inconnue/) });
    expect((await lancer(repo, '--clore', e.id, '--autre')).code).toBe(2);
  });

  // Seconde revue L745 (B1) : git diff --name-only citait les noms accentués, les noms repartaient vers git comme pathspecs (« : » initial, « \ »)
  // et le code de sortie était ignoré : ces runs passaient pour intégrés et --clore supprimait leur branche.
  it.each(['décision.md', ':deux-points.txt', 'a\\b.txt'])('revue r2 : un fichier du run nommé %s absent de main : ni « integre a la main », ni clos ; --clore le nomme', async (nom) => {
    const { repo, e } = runEnConflit(nom);
    resoudreALaMain(repo, e, undefined, nom);
    expect(git(repo, '--literal-pathspecs', 'ls-files', '--', nom)).toBe(''); // le travail du run sur ce fichier n'est pas sur main
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  conflit  `, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(1);
    expect(r.texte).toContain(`contenu différent sur main : ${nom} ;`);
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toBeUndefined();
  });

  it('revue r2 : le même fichier accentué repris tel quel sur main est reconnu, et la preuve le nomme en clair', async () => {
    const { repo, e } = runEnConflit('décision.md');
    resoudreALaMain(repo, e);
    const r = await lancer(repo, '--clore', e.id);
    expect(r).toMatchObject({ code: 0, texte: expect.stringContaining('clos — les fichiers du run (décision.md, fait.txt) ont sur main le contenu de sa tête') });
    expect(branche(repo, e.branche)).toBe(false);
  });

  it('revue r2 : un git diff qui échoue (code non nul) ne vaut jamais « intégré »', () => {
    const { repo, e } = runEnConflit();
    resoudreALaMain(repo, e);
    expect(integrationManuelle(e).integre).toBe(true); // le contenu du run est bien sur main
    const bin = dossierTemp('git-diff-ko-'), vrai = git(repo, '--exec-path'), path = process.env.PATH;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = diff ] && { echo "fatal: diff en panne" >&2; exit 128; }\nexec "${vrai}/git" "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${path}`;
    try {
      const i = integrationManuelle(e);
      expect(i).toMatchObject({ integre: false, raison: expect.stringMatching(/intègre-les d'abord \(contenu différent sur main : invérifiable, git diff a échoué ;/) });
    } finally { process.env.PATH = path; }
  });
});
