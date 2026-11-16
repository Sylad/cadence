// L745 (issue #62) : un run fini en conflit dont l'unique commit a été intégré à la main sur main restait « conflit » dans --liste, worktree et branche gardés.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { commitsHorsCible, commitsSansPatchSurCible, fichiersNonCommites, GitEnEchec, gitOuEchec, integrationManuelle, tetesDuRun } from '../src/run/clore.js';
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
  // 4e passe : la reconnaissance par le contenu des fichiers est retirée (hors contrat). Une résolution de conflit faite à la main change le patch-id :
  // elle n'est plus reconnue, qu'elle garde le contenu du run ou non ; --clore nomme le commit et --force clôt en le nommant perdu.
  it.each([['le contenu du run', undefined], ['un autre contenu', 'ok et autre']])('conflit résolu à la main (patch-id différent) avec %s : pas reconnu ; --clore nomme le commit, --force clôt en le nommant perdu', async (_, contenu) => {
    const { repo, e } = runEnConflit();
    resoudreALaMain(repo, e, contenu);
    const tete = git(repo, 'rev-parse', e.branche);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  conflit  `, 'm'));
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(1);
    expect(r.texte).toMatch(/refusé : 1 commit\(s\) du run absent\(s\) de main : [0-9a-f]{7} ajoute fait\.txt ; intègre-les d'abord/);
    expect(r.texte).toContain(`cadence run --clore ${e.id} --force`);
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    const f = await lancer(repo, '--clore', e.id, '--force');
    expect(f.code).toBe(0);
    expect(f.texte).toMatch(/clos sans preuve d'intégration \(--force\)/);
    expect(f.texte).toContain(`1 commit(s) perdu(s), absent(s) de main : ${tete.slice(0, 7)} ajoute fait.txt ; tête(s) du run : ${tete} `);
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toMatchObject({ force: true, tete });
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
    expect(r.texte).toMatch(/1 commit\(s\) du run absent\(s\) de main : [0-9a-f]{7} ajoute fait\.txt ; intègre-les d'abord/);
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toBeUndefined();
  });
});

// 4e passe : le contrat de docs/v2/2026-11-09-cadence-run.md (« Tableau de --liste et --clore »), un test par ligne du tableau, puis les cas des revues.
/** Un run fini en « porte-rouge » (la porte demande fait.txt, la session ne le crée pas) : ses commits sont ceux de `travail`, rien n'est intégré. */
function runPorteRouge(travail: (cwd: string) => void, avant?: (repo: string) => void): { repo: string; e: Etat } {
  const repo = depot();
  avant?.(repo);
  const e = executerRun({ repo, demande: 'Travaille', exec: fauxClaude([travail]), out: () => {}, attendre: null });
  expect(e.etat).toBe('porte-rouge');
  expect(existsSync(e.worktree)).toBe(true);
  return { repo, e };
}
const ecrit = (cwd: string, fichier: string, contenu: string | Buffer) => { writeFileSync(join(cwd, fichier), contenu); git(cwd, 'add', '-A'); };
const commit = (cwd: string, message: string, ...options: string[]) => { git(cwd, ...ID, 'commit', '-qm', message, ...options); return git(cwd, 'rev-parse', 'HEAD'); };
const depose = (fichier: string, contenu: string | Buffer = 'travail du run') => (cwd: string) => { ecrit(cwd, fichier, contenu); commit(cwd, `ajoute ${fichier}`); };
/** Le lead rejoue des commits du run sur la cible, qui a avancé entre-temps (sans quoi le cherry-pick referait le même commit, donc un ancêtre). */
const rejoue = (repo: string, ...commits: string[]) => { depose('main-avance.txt')(repo); git(repo, ...ID, 'cherry-pick', '--allow-empty', ...commits); };
const tetes = (repo: string, e: Etat) => ({ tetes: [git(repo, 'rev-parse', e.branche)], cible: git(repo, 'rev-parse', 'main') });
/** Un git dont la sous-commande `sous` échoue (code 128), les autres passant au vrai git ; rend de quoi remettre le PATH. */
function gitEnPanne(repo: string, sous: string): () => void {
  const bin = dossierTemp('git-ko-'), vrai = git(repo, '--exec-path'), path = process.env.PATH;
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in -c|*=*) ;; *) [ "$a" = ${sous} ] && { echo "fatal: ${sous} en panne" >&2; exit 128; }; break ;; esac; done\nexec "${vrai}/git" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${path}`;
  return () => { process.env.PATH = path; };
}
/** Ni « integre a la main » dans --liste, ni clos : --clore refuse (code 1) en donnant `raison`, worktree, branche et état intacts. */
async function resteOuvert(repo: string, e: Etat, raison: RegExp): Promise<string> {
  expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  ${e.etat}  `, 'm'));
  const r = await lancer(repo, '--clore', e.id);
  expect(r.code).toBe(1);
  expect(r.texte).toMatch(raison);
  expect(existsSync(e.worktree)).toBe(true);
  expect(branche(repo, e.branche)).toBe(true);
  expect(JSON.parse(readFileSync(e.fichier, 'utf8')).clos).toBeUndefined();
  return r.texte;
}

describe('contrat de --liste et --clore (L745, 4e passe) : une ligne du tableau, un test', () => {
  it.each(['for-each-ref', 'rev-parse', 'cat-file', 'status', 'rev-list', 'diff-tree', 'patch-id'])('ligne 1 : git %s en échec = non intégré, la commande est nommée, --clore refuse', async (sous) => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    rejoue(repo, e.branche);
    expect(integrationManuelle(e)).toMatchObject({ integre: true, preuve: 'tous ses commits sont sur main (1 par le même patch rejoué)' });
    const remettre = gitEnPanne(repo, sous);
    try {
      expect(() => gitOuEchec(repo, [sous])).toThrow(GitEnEchec);
      const i = integrationManuelle(e);
      expect(i.integre).toBe(false);
      expect(i).toMatchObject({ raison: expect.stringMatching(new RegExp(`^git ${sous} a échoué dans .* : fatal: ${sous} en panne : intégration invérifiable$`)) });
      expect('perdus' in i).toBe(false); // --force ne passe pas un échec de git
      if (sous === 'rev-parse') return; // la CLI s'en sert avant le tableau pour trouver le run : elle échoue plus tôt, sans rien retirer
      await resteOuvert(repo, e, new RegExp(`refusé : git ${sous} a échoué`));
      expect((await lancer(repo, '--clore', e.id, '--force')).code).toBe(1);
      expect(branche(repo, e.branche)).toBe(true);
    } finally { remettre(); }
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
  });

  it('ligne 2 : les têtes du run sont sa branche, le HEAD de son worktree (détaché compris) et la tête notée ; aucune = non intégré', () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    const fin = git(repo, 'rev-parse', e.branche);
    expect(e.tete).toBe(fin);
    expect(tetesDuRun(e)).toEqual([fin]);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'b.txt', 'suite');
    const detache = commit(e.worktree, 'suite sur HEAD détaché');
    expect(tetesDuRun(e)).toEqual([fin, detache]);
    git(e.worktree, 'checkout', '-q', e.branche);
    git(e.worktree, ...ID, 'commit', '-q', '--amend', '-m', 'a.txt réécrit'); // la branche ne porte plus la tête notée : elle reste à prouver
    expect(tetesDuRun(e)).toEqual([git(repo, 'rev-parse', e.branche), fin]);
    git(repo, 'worktree', 'remove', '--force', e.worktree); git(repo, 'branch', '-D', e.branche);
    expect(tetesDuRun(e)).toEqual([fin]);
    expect(tetesDuRun({ ...e, tete: '0'.repeat(40) })).toEqual([]);
    expect(integrationManuelle({ ...e, tete: undefined })).toMatchObject({ integre: false, raison: expect.stringMatching(/tête du run inconnue/) });
  });

  it('ligne 2 : un dossier de worktree qui n\'est plus un worktree git = non intégré', () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    rejoue(repo, e.branche);
    git(repo, 'worktree', 'remove', '--force', e.worktree);
    mkdirSync(e.worktree); writeFileSync(join(e.worktree, 'reste.txt'), 'x');
    expect(() => tetesDuRun(e)).toThrow(GitEnEchec);
    expect(integrationManuelle(e)).toMatchObject({ integre: false, raison: expect.stringMatching(/^git rev-parse a échoué .* : intégration invérifiable$/s) });
    const parent = dirname(dirname(e.worktree)); // le dossier se retrouve dans un autre dépôt : son HEAD n'est pas celui du run
    git(parent, 'init', '-q'); git(parent, ...ID, 'commit', '-q', '--allow-empty', '-m', 'autre dépôt');
    expect(integrationManuelle(e)).toMatchObject({ integre: false, raison: expect.stringMatching(/n'est plus un worktree git \(dépôt trouvé : .*\) : intégration invérifiable$/) });
  });

  it('ligne 3 : un fichier non suivi ou modifié du worktree = non intégré, fichiers nommés tels quels ; --force ne le passe pas', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    rejoue(repo, e.branche);
    expect(fichiersNonCommites(e)).toEqual([]);
    git(repo, 'config', 'status.showUntrackedFiles', 'no'); // le réglage qui cache les fichiers non suivis ne les cache pas ici
    writeFileSync(join(e.worktree, 'a.txt'), 'modifié');
    mkdirSync(join(e.worktree, 'notes'));
    writeFileSync(join(e.worktree, 'notes', 'décision.md'), 'x');
    expect(fichiersNonCommites(e).sort()).toEqual(['a.txt', 'notes/décision.md']);
    await resteOuvert(repo, e, /refusé : le worktree .* a des modifications non commitées : a\.txt, notes\/décision\.md$/);
    expect((await lancer(repo, '--clore', e.id, '--force')).code).toBe(1);
    expect(readFileSync(join(e.worktree, 'a.txt'), 'utf8')).toBe('modifié');
    expect(fichiersNonCommites({ ...e, worktree: join(e.worktree, 'absent') })).toEqual([]);
  });

  it('ligne 4 : un run sans commit depuis sa base = non intégré', () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    expect(integrationManuelle({ ...e, base: git(repo, 'rev-parse', e.branche) })).toMatchObject({ integre: false, raison: expect.stringMatching(/aucun commit/) });
  });

  it('ligne 5 : seuls les commits qui ne sont pas des ancêtres de la cible restent à prouver, fusions comprises', async () => {
    const { repo, e } = runPorteRouge((cwd) => { depose('a.txt')(cwd); depose('b|c.txt')(cwd); });
    const [a, b] = [git(repo, 'rev-parse', `${e.branche}~1`), git(repo, 'rev-parse', e.branche)];
    expect(commitsHorsCible(repo, [b], git(repo, 'rev-parse', 'main'))).toEqual([{ sha: b, fusion: false, sujet: 'ajoute b|c.txt' }, { sha: a, fusion: false, sujet: 'ajoute a.txt' }]);
    git(repo, ...ID, 'merge', '-q', '--no-ff', '--no-edit', e.branche); // le commit de fusion est sur la cible, les commits du run en sont des ancêtres
    expect(commitsHorsCible(repo, [b], git(repo, 'rev-parse', 'main'))).toEqual([]);
    expect(integrationManuelle(e)).toMatchObject({ integre: true, preuve: 'tous ses commits sont sur main' });
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
  });

  const LIGNES = 'un\ndeux\ntrois\nquatre\ncinq\nsix\nsept\nhuit\n';
  it('ligne 6 : un commit rejoué à l\'identique sur une cible qui a avancé (même patch-id, autres lignes, nom accentué) est prouvé', async () => {
    const { repo, e } = runPorteRouge((cwd) => { ecrit(cwd, 'décision.md', `${LIGNES}neuf\n`); commit(cwd, 'décide'); }, (r) => { ecrit(r, 'décision.md', LIGNES); commit(r, 'base de la décision'); });
    ecrit(repo, 'décision.md', `zéro\n${LIGNES}`); commit(repo, 'main avance');
    git(repo, ...ID, 'cherry-pick', e.branche);
    const { tetes: t, cible } = tetes(repo, e), hors = commitsHorsCible(repo, t, cible);
    expect(hors.map((c) => c.sujet)).toEqual(['décide']);
    expect(commitsSansPatchSurCible(repo, t, cible, hors)).toEqual([]);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(était porte-rouge ; worktree et branche : cadence run --clore ${e.id}\\)`, 'm'));
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 0, texte: expect.stringContaining('clos — tous ses commits sont sur main (1 par le même patch rejoué)') });
    expect(branche(repo, e.branche)).toBe(false);
  });

  // Ligne 7 : chaque cas est un commit de la cible qui ressemble à celui du run sans le rejouer à l'identique. `run` commite dans le worktree, `main` sur la cible.
  const gitlink = (cwd: string) => { mkdirSync(join(cwd, 'sub')); git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${git(cwd, 'rev-parse', 'HEAD')},sub`); };
  const SOUS_MODULE = { run: (cwd: string) => { ecrit(cwd, 'a.txt', 'x'); gitlink(cwd); commit(cwd, 'travail'); }, main: (r: string) => { ecrit(r, 'a.txt', 'x'); commit(r, 'travail'); } };
  const PRESQUE: Record<string, { run: (cwd: string) => void; main: (repo: string) => void; avant?: (repo: string) => void }> = {
    'des espaces en plus (indentation)': { run: (cwd) => { ecrit(cwd, 'a.txt', 'x\n  y\n'); commit(cwd, 'travail'); }, main: (r) => { ecrit(r, 'a.txt', 'x\ny\n'); commit(r, 'travail'); } },
    'un autre contenu binaire': { run: (cwd) => { ecrit(cwd, 'a.bin', Buffer.from([0, 1])); commit(cwd, 'travail'); }, main: (r) => { ecrit(r, 'a.bin', Buffer.from([0, 2])); commit(r, 'travail'); } },
    'un changement de mode en moins (chmod +x)': { run: (cwd) => { writeFileSync(join(cwd, 'a.txt'), 'x'); chmodSync(join(cwd, 'a.txt'), 0o755); git(cwd, 'add', '-A'); commit(cwd, 'travail'); }, main: (r) => { ecrit(r, 'a.txt', 'x'); commit(r, 'travail'); } },
    'un bump de sous-module en moins, diff.ignoreSubmodules=all': { ...SOUS_MODULE, avant: (r) => git(r, 'config', 'diff.ignoreSubmodules', 'all') },
    'un bump de sous-module en moins, ignore = all dans .gitmodules': { ...SOUS_MODULE, avant: (r) => { ecrit(r, '.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n'); commit(r, 'sous-module ignoré'); } },
    'un fichier en moins (deux fichiers dans le commit du run)': { run: (cwd) => { ecrit(cwd, 'a.txt', 'x'); ecrit(cwd, 'b.txt', 'y'); commit(cwd, 'travail'); }, main: (r) => { ecrit(r, 'a.txt', 'x'); commit(r, 'travail'); } },
    'rien (le commit du run est vide : pas de patch-id)': { run: (cwd) => { commit(cwd, 'travail', '--allow-empty'); }, main: (r) => { commit(r, 'travail', '--allow-empty'); } },
  };
  it.each(Object.keys(PRESQUE))('ligne 7 : un commit de la cible avec %s ne prouve rien : non intégré, commit nommé, --clore refuse', async (cas) => {
    const { run, main, avant } = PRESQUE[cas], { repo, e } = runPorteRouge(run, avant);
    depose('main-avance.txt')(repo);
    main(repo);
    const { tetes: t, cible } = tetes(repo, e), hors = commitsHorsCible(repo, t, cible);
    expect(commitsSansPatchSurCible(repo, t, cible, hors)).toEqual([{ sha: t[0], fusion: false, sujet: 'travail' }]);
    await resteOuvert(repo, e, new RegExp(`refusé : 1 commit\\(s\\) du run absent\\(s\\) de main : ${t[0].slice(0, 7)} travail ; intègre-les d'abord`));
  });

  it('ligne 8 (revue r3, M3) : un commit de fusion du run qui n\'est pas sur la cible n\'est jamais prouvé, même si ses commits simples sont rejoués', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    git(e.worktree, 'checkout', '-q', '-b', 'cote', e.base);
    depose('cote.txt')(e.worktree);
    git(e.worktree, 'checkout', '-q', e.branche);
    git(e.worktree, ...ID, 'merge', '-q', '--no-ff', '--no-commit', 'cote');
    ecrit(e.worktree, 'resolution.txt', 'écrit dans la fusion'); // une « evil merge » : du contenu que seul le commit de fusion porte
    const fusion = commit(e.worktree, 'fusionne cote');
    rejoue(repo, `${e.branche}^1`, `${e.branche}^2`); // le lead rejoue les deux commits simples
    expect(git(repo, 'cherry', 'main', e.branche)).not.toMatch(/^\+/m); // git cherry ne voit pas la fusion : il dirait « tout est sur main »
    const { tetes: t, cible } = tetes(repo, e), hors = commitsHorsCible(repo, t, cible);
    expect(hors).toHaveLength(3);
    expect(commitsSansPatchSurCible(repo, t, cible, hors)).toEqual([{ sha: fusion, fusion: true, sujet: 'fusionne cote' }]);
    await resteOuvert(repo, e, new RegExp(`1 commit\\(s\\) du run absent\\(s\\) de main : ${fusion.slice(0, 7)} fusionne cote \\(commit de fusion\\) ; intègre-les d'abord`));
    expect(existsSync(join(repo, 'resolution.txt'))).toBe(false);
  });

  it('lignes 9 et 10 : sans --force, --clore refuse en nommant les commits ; --force clôt et nomme chaque commit perdu et chaque tête', async () => {
    const { repo, e } = runPorteRouge((cwd) => { depose('a.txt')(cwd); depose('b.txt')(cwd); });
    rejoue(repo, `${e.branche}~1`); // a.txt est repris, b.txt non
    const b = git(repo, 'rev-parse', e.branche);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'c.txt', 'suite');
    const c = commit(e.worktree, 'suite détachée');
    const refus = await resteOuvert(repo, e, /refusé : 2 commit\(s\) du run absent\(s\) de main : /);
    for (const perdu of [`${c.slice(0, 7)} suite détachée ;`, `${b.slice(0, 7)} ajoute b.txt ;`]) expect(refus).toContain(perdu);
    expect(refus).not.toContain('ajoute a.txt');
    const f = await lancer(repo, '--clore', e.id, '--force');
    expect(f.code).toBe(0);
    expect(f.texte).toContain('2 commit(s) perdu(s), absent(s) de main : ');
    for (const perdu of [`${c.slice(0, 7)} suite détachée ;`, `${b.slice(0, 7)} ajoute b.txt ;`, `tête(s) du run : ${b}, ${c} (git branch`]) expect(f.texte).toContain(perdu);
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
    expect(git(repo, 'cat-file', '-t', c)).toBe('commit'); // la tête imprimée se retrouve encore
  });
});

describe('cas de la troisième revue de L745 : plus de faux « integre a la main », --clore ne supprime plus de travail absent de main', () => {
  it('M2 : un commit fait sur un HEAD détaché du worktree, branche déjà fusionnée : --clore refuse et le nomme', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    expect(integrationManuelle(e).integre).toBe(true);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'perdu.txt', 'x');
    const perdu = commit(e.worktree, 'perdu');
    await resteOuvert(repo, e, new RegExp(`1 commit\\(s\\) du run absent\\(s\\) de main : ${perdu.slice(0, 7)} perdu ;`));
    expect(git(e.worktree, 'rev-parse', 'HEAD')).toBe(perdu);
  });

  it('M1 : index du worktree corrompu (git status échoue) et modification non commitée : --clore refuse, la modification reste', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    writeFileSync(join(e.worktree, 'fait.txt'), 'résolution locale, non commitée');
    writeFileSync(resolve(e.worktree, git(e.worktree, 'rev-parse', '--git-path', 'index')), 'index corrompu');
    await resteOuvert(repo, e, /refusé : git status a échoué dans .* : intégration invérifiable$/);
    expect((await lancer(repo, '--clore', e.id, '--force')).code).toBe(1);
    expect(readFileSync(join(e.worktree, 'fait.txt'), 'utf8')).toBe('résolution locale, non commitée');
  });

  it.each([
    ['diff.ignoreSubmodules=all', (r: string) => { git(r, 'config', 'diff.ignoreSubmodules', 'all'); }],
    ['ignore = all dans .gitmodules', (r: string) => { ecrit(r, '.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n'); commit(r, 'sous-module ignoré'); }],
  ])('B1 : conflit résolu sur main sans le bump de sous-module du run (%s) : ni intégré ni clos, la branche garde le bump', async (_, regler) => {
    const repo = depot();
    regler(repo);
    const travail = (cwd: string) => {
      writeFileSync(join(cwd, 'fait.txt'), 'ok'); git(cwd, 'add', '-A');
      mkdirSync(join(cwd, 'sub')); // un sous-module non peuplé, comme dans un worktree neuf
      git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${git(cwd, 'rev-parse', 'HEAD')},sub`);
      commit(cwd, 'ajoute fait.txt');
      ecrit(repo, 'fait.txt', 'autre'); commit(repo, 'fait.txt ailleurs');
    };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([travail, () => {}]), out: () => {}, attendre: null });
    expect(e.etat).toBe('conflit');
    ecrit(repo, 'fait.txt', 'ok'); commit(repo, 'ajoute fait.txt'); // la résolution garde fait.txt du run, pas son bump de sous-module
    expect(git(repo, 'ls-tree', 'main', 'sub')).toBe('');
    await resteOuvert(repo, e, /1 commit\(s\) du run absent\(s\) de main : [0-9a-f]{7} ajoute fait\.txt ; intègre-les d'abord/);
    expect(git(repo, 'ls-tree', e.branche, 'sub')).toMatch(/^160000 commit /);
  });
});
