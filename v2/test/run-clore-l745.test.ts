// L745 (issue #62) : un run fini en conflit dont l'unique commit a été intégré à la main sur main restait « conflit » dans --liste, worktree et branche gardés.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { ARCHIVES, integration, retirerWorktree, tetesDuRun } from '../src/run/clore.js';
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
/** Un git dont la sous-commande `sous` échoue (code 128), les autres passant au vrai git ; rend de quoi remettre le PATH. */
function gitEnPanne(repo: string, sous: string): () => void {
  const bin = dossierTemp('git-ko-'), vrai = git(repo, '--exec-path'), path = process.env.PATH;
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in -c|*=*) ;; *) [ "$a" = ${sous} ] && { echo "fatal: ${sous} en panne" >&2; exit 128; }; break ;; esac; done\nexec "${vrai}/git" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${path}`;
  return () => { process.env.PATH = path; };
}
/** L'invariant de la 5e passe : après --clore, ce commit est encore atteignable par une référence du dépôt (une archive, ou une branche). */
const refsVers = (repo: string, sha: string) => git(repo, 'for-each-ref', '--format=%(refname)', '--contains', sha).split('\n').filter(Boolean);
const archive = (repo: string, e: Etat, suffixe = '') => git(repo, 'rev-parse', `${ARCHIVES}${e.id}${suffixe}`);
const clos = (e: Etat) => (JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat).clos;
/** --liste garde l'état du run et dit combien de ses commits manquent à la cible. */
async function resteDit(repo: string, e: Etat, absents: string): Promise<void> {
  const l = (await lancer(repo, '--liste')).texte;
  expect(l).toMatch(new RegExp(`^${e.id}  ${e.etat}  `, 'm'));
  expect(l).toContain(`\n    commits absents de la cible : ${absents} — main ; clore en archivant son travail : cadence run --clore ${e.id}`);
}
/** --clore clôt (code 0) : la tête de la branche est archivée et vérifiée, la branche retirée ; rend la sortie. */
async function cloreArchive(repo: string, e: Etat): Promise<string> {
  const tete = git(repo, 'rev-parse', e.branche), r = await lancer(repo, '--clore', e.id);
  expect(r).toMatchObject({ code: 0, texte: expect.stringContaining(`archives : ${ARCHIVES}${e.id} (${tete.slice(0, 7)})`) });
  expect(archive(repo, e)).toBe(tete);
  expect(branche(repo, e.branche)).toBe(false);
  expect(clos(e)?.archives).toContain(`${ARCHIVES}${e.id}`);
  return r.texte;
}

describe('cadence run --liste : affichage seul (L745, 5e passe)', () => {
  it('commits absents de main : --liste dit « conflit » et « commits absents de la cible : 1 »', async () => {
    const { repo, e } = runEnConflit();
    await resteDit(repo, e, '1');
  });

  it('tête de la branche ancêtre de main (fusion à la main) : « integre a la main », sans ligne de commits absents', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    expect(integration(e)).toEqual({ integre: true, cible: git(repo, 'rev-parse', 'main'), absents: '0' });
    const l = (await lancer(repo, '--liste')).texte;
    expect(l).toMatch(new RegExp(`^${e.id}  integre a la main \\(était conflit ; worktree et branche : cadence run --clore ${e.id}\\)  Crée`, 'm'));
    expect(l).not.toContain('commits absents');
  });

  it('branche et worktree retirés à la main après la fusion : la tête notée à la fin du run tient lieu de tête de branche', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    git(repo, 'worktree', 'remove', '--force', e.worktree); git(repo, 'branch', '-D', e.branche);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(était conflit`, 'm'));
    expect(integration({ ...e, tete: undefined })).toMatchObject({ integre: false, absents: 'inconnu (tête du run inconnue)' });
  });

  it('plus de reconnaissance par patch-id : le même patch rejoué (cherry-pick) sur une cible qui a avancé reste « porte-rouge », 1 commit absent', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    rejoue(repo, e.branche);
    expect(git(repo, 'cherry', 'main', e.branche)).toMatch(/^- /); // git cherry le dirait rejoué
    await resteDit(repo, e, '1');
  });

  it('run sans commit, branche cible absente, run qui se reprend : jamais « integre a la main »', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    expect(integration({ ...e, base: git(repo, 'rev-parse', e.branche) })).toMatchObject({ integre: false, absents: '0 (le run n\'a aucun commit)' });
    expect(integration({ ...e, cible: 'absente' })).toEqual({ integre: false, cible: '', absents: 'inconnu (branche absente absente)' });
    git(repo, ...ID, 'merge', '-q', '--no-edit', e.branche);
    writeFileSync(e.fichier, JSON.stringify({ ...e, etat: 'attente' }));
    const l = (await lancer(repo, '--liste')).texte; // L767 : la tête sur la cible se dit, l'état reste « attente » (run-purger-l767.test.ts)
    expect(l).toMatch(new RegExp(`^${e.id}  attente, sa tête est sur main `, 'm'));
    expect(l).not.toContain('integre a la main');
    expect(l).not.toContain('commits absents');
  });

  it.each(['rev-parse', 'merge-base', 'rev-list'])('git %s en échec : pas « integre a la main », la raison est dite ou le run reste dans son état', (sous) => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    git(repo, ...ID, 'merge', '-q', '--no-edit', e.branche);
    expect(integration(e).integre).toBe(true);
    const remettre = gitEnPanne(repo, sous);
    try {
      const i = integration(e);
      expect(i.integre).toBe(false);
      if (sous !== 'merge-base') expect(i.absents).toMatch(new RegExp(`^inconnu \\(git ${sous} a échoué dans .* : fatal: ${sous} en panne\\)$`));
    } finally { remettre(); }
  });
});

describe('cadence run --clore : rien n\'est retiré sans avoir été archivé (L745, 5e passe)', () => {
  it('run non intégré : clos sans --force, la tête de la branche est archivée, worktree et branche retirés, --archives donne la commande qui la restaure', async () => {
    const { repo, e } = runEnConflit();
    const tete = git(repo, 'rev-parse', e.branche);
    expect((await lancer(repo, '--archives')).texte).toBe('aucune archive');
    const t = await cloreArchive(repo, e);
    expect(t).toContain(`clos — non intégré, commits absents de la cible : 1 ; archives : ${ARCHIVES}${e.id} (${tete.slice(0, 7)}) ; worktree et branche retirés ; les retrouver : cadence run --archives`);
    expect(existsSync(e.worktree)).toBe(false);
    expect(existsSync(`${e.worktree}.reglages`)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(e.worktree);
    expect(clos(e)).toMatchObject({ integre: false, tete, archives: [`${ARCHIVES}${e.id}`] });
    expect(clos(e)?.restes).toBeUndefined();
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  clos le \\d{4}-\\d\\d-\\d\\d sans intégration, travail archivé : cadence run --archives \\(était conflit\\)  Crée`, 'm'));
    const a = await lancer(repo, '--archives');
    expect(a.code).toBe(0);
    expect(a.texte).toMatch(new RegExp(`^${ARCHIVES}${e.id} ${tete.slice(0, 7)} \\d{4}-\\d\\d-\\d\\d ajoute fait\\.txt\\n    restaurer : git branch archive-${e.id} ${ARCHIVES}${e.id}$`));
    git(repo, 'branch', `archive-${e.id}`, `${ARCHIVES}${e.id}`); // la commande imprimée
    expect(git(repo, 'show', `archive-${e.id}:fait.txt`)).toBe('ok');
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 0, texte: expect.stringMatching(/déjà clos/) });
  });

  it('run intégré à la main : clos, archivé quand même, --liste dit « integre a la main (main = …), clos le … »', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    const t = await cloreArchive(repo, e);
    expect(t).toContain(`clos — sa tête est sur main (${git(repo, 'rev-parse', '--short=7', 'main')})`);
    expect(existsSync(e.worktree)).toBe(false);
    expect(clos(e)).toMatchObject({ integre: true, cible: git(repo, 'rev-parse', 'main') });
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).etat).toBe('conflit');
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main \\(main = [0-9a-f]{7}\\), clos le \\d{4}-\\d\\d-\\d\\d \\(était conflit\\)`, 'm'));
  });

  it('refus : run qui se reprend (attente), run intégré par cadence run, id inconnu ; --force n\'existe plus (usage, code 2)', async () => {
    const { repo, e } = runEnConflit();
    const ecrire = (x: Partial<Etat>) => writeFileSync(e.fichier, JSON.stringify({ ...e, ...x }));
    expect(await lancer(repo, '--clore', e.id, '--force')).toMatchObject({ code: 2, texte: 'usage : cadence run --clore <id>' });
    expect((await lancer(repo, '--clore')).code).toBe(2);
    expect((await lancer(repo, '--clore', 'inconnu')).code).toBe(1);
    ecrire({ etat: 'attente' });
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/le run est attente : il se reprend/) });
    ecrire({ etat: 'integre' });
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(/intégré par cadence run/) });
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    expect(git(repo, 'for-each-ref', ARCHIVES)).toBe('');
  });

  it('les têtes du run : la branche, le HEAD du worktree (détaché compris) et la tête notée ; chacune a son archive, une même tête n\'en a qu\'une', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    const fin = git(repo, 'rev-parse', e.branche);
    expect(e.tete).toBe(fin);
    expect(tetesDuRun(e)).toEqual([{ ref: `${ARCHIVES}${e.id}`, sha: fin }]);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'b.txt', 'suite');
    const detache = commit(e.worktree, 'suite sur HEAD détaché');
    git(repo, 'update-ref', `refs/heads/${e.branche}`, commit(e.worktree, 'branche réécrite', '--amend')); // la branche ne porte plus la tête notée
    git(e.worktree, 'checkout', '-q', '--detach', detache);
    const reecrite = git(repo, 'rev-parse', e.branche);
    expect(tetesDuRun(e)).toEqual([{ ref: `${ARCHIVES}${e.id}`, sha: reecrite }, { ref: `${ARCHIVES}${e.id}-worktree`, sha: detache }, { ref: `${ARCHIVES}${e.id}-fin`, sha: fin }]);
    expect(tetesDuRun({ ...e, tete: '0'.repeat(40) }).map((t) => t.sha)).toEqual([reecrite, detache]);
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
    expect([archive(repo, e), archive(repo, e, '-worktree'), archive(repo, e, '-fin')]).toEqual([reecrite, detache, fin]);
    expect(existsSync(e.worktree)).toBe(false);
    expect(branche(repo, e.branche)).toBe(false);
  });

  it('aucune tête connue (branche et worktree retirés à la main, tête notée absente) : clos sans rien archiver ni retirer', async () => {
    const { repo, e } = runEnConflit();
    git(repo, 'worktree', 'remove', '--force', e.worktree); git(repo, 'branch', '-D', e.branche);
    writeFileSync(e.fichier, JSON.stringify({ ...e, tete: undefined }));
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 0, texte: expect.stringContaining('archives : aucune, aucune tête connue') });
    expect(clos(e)).toMatchObject({ archives: [], integre: false });
  });

  it('worktree non propre (fichier modifié, fichier non suivi caché par status.showUntrackedFiles=no) : le dossier reste intact et la commande le dit ; la branche est archivée puis retirée', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(e.worktree, 'a.txt'), 'modifié');
    mkdirSync(join(e.worktree, 'notes'));
    writeFileSync(join(e.worktree, 'notes', 'décision.md'), 'x');
    const tete = git(repo, 'rev-parse', e.branche), t = await cloreArchive(repo, e);
    expect(t).toContain(`worktree ${e.worktree} gardé : fichiers modifiés ou non suivis : a.txt, notes/décision.md ; les retrouver`);
    expect(readFileSync(join(e.worktree, 'a.txt'), 'utf8')).toBe('modifié');
    expect(readFileSync(join(e.worktree, 'notes', 'décision.md'), 'utf8')).toBe('x');
    expect(git(e.worktree, 'rev-parse', 'HEAD')).toBe(tete); // HEAD détaché sur la tête archivée, index et fichiers intacts
    expect(git(e.worktree, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all')).toBe('M a.txt\n?? notes/décision.md');
    expect(clos(e)?.restes).toEqual([`worktree ${e.worktree} gardé : fichiers modifiés ou non suivis : a.txt, notes/décision.md`]);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  clos le .* \\(était porte-rouge ; worktree .* gardé : fichiers modifiés ou non suivis : a\\.txt, notes/décision\\.md\\)`, 'm'));
  });

  it('un dossier que git ne connaît pas comme worktree du dépôt n\'est jamais retiré', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    git(repo, 'worktree', 'remove', '--force', e.worktree);
    mkdirSync(e.worktree); writeFileSync(join(e.worktree, 'reste.txt'), 'x');
    const t = await cloreArchive(repo, e);
    expect(t).toContain(`worktree ${e.worktree} gardé : git ne le connaît pas comme worktree de ce dépôt`);
    expect(readFileSync(join(e.worktree, 'reste.txt'), 'utf8')).toBe('x');
  });

  it.each(['worktree', 'rev-parse', 'update-ref'])('git %s en échec avant la fin de l\'archivage : refus, rien n\'est retiré', async (sous) => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    const remettre = gitEnPanne(repo, sous);
    try {
      if (sous === 'rev-parse') expect(() => tetesDuRun(e)).toThrow(/git rev-parse a échoué dans .* : fatal: rev-parse en panne/); // la CLI s'en sert plus tôt, pour trouver le run
      else expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringMatching(new RegExp(`refusé : git ${sous} a échoué dans .* : fatal: ${sous} en panne ; rien n'a été retiré$`)) });
    } finally { remettre(); }
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    expect(clos(e)).toBeUndefined();
    await cloreArchive(repo, e);
  });

  it.each(['status', 'branch'])('git %s en échec après l\'archivage : ce qui n\'a pas pu être contrôlé ou retiré reste, et la commande le dit', async (sous) => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    const tete = git(repo, 'rev-parse', e.branche), remettre = gitEnPanne(repo, sous);
    let r: { code: number; texte: string };
    try { r = await lancer(repo, '--clore', e.id); } finally { remettre(); }
    expect(r.code).toBe(0);
    expect(archive(repo, e)).toBe(tete);
    if (sous === 'status') expect(r.texte).toContain(`worktree ${e.worktree} gardé : git status y a échoué (fatal: status en panne)`);
    else expect(r.texte).toContain(`branche ${e.branche} gardée (fatal: branch en panne)`);
    expect(existsSync(e.worktree)).toBe(sous === 'status');
    expect(branche(repo, e.branche)).toBe(sous === 'branch');
  });

  it('une archive du même nom sur un autre commit n\'est jamais écrasée : refus, rien n\'est retiré', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    const autre = git(repo, 'rev-parse', 'main');
    git(repo, 'update-ref', `${ARCHIVES}${e.id}`, autre);
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringContaining(`l'archive ${ARCHIVES}${e.id} existe déjà sur un autre commit (${autre.slice(0, 7)})`) });
    expect(archive(repo, e)).toBe(autre);
    expect(existsSync(e.worktree)).toBe(true);
    expect(branche(repo, e.branche)).toBe(true);
    git(repo, 'update-ref', `${ARCHIVES}${e.id}`, git(repo, 'rev-parse', e.branche)); // la même archive, déjà posée sur le bon commit : --clore se rejoue
    await cloreArchive(repo, e);
  });

  it('revue M2 : --reponse sur un run clos est refusé, sans session, et l\'état reste celui du run clos', async () => {
    const { repo, e } = runEnConflit();
    expect((await lancer(repo, '--clore', e.id)).code).toBe(0);
    const avant = readFileSync(e.fichier, 'utf8'), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    expect(() => repondreRun(e.id, repo, 'reprends', { exec: fauxClaude([], appels), out: () => {}, attendre: null }))
      .toThrow(new RegExp(`${e.id} est clos \\(--clore\\) le \\d{4}-\\d\\d-\\d\\d : sa branche est retirée, son travail archivé \\(cadence run --archives\\), rien à reprendre`));
    expect(appels).toHaveLength(0);
    expect(readFileSync(e.fichier, 'utf8')).toBe(avant);
    expect(await lancer(repo, '--reponse', e.id, 'reprends')).toMatchObject({ code: 1, texte: expect.stringMatching(/est clos/) });
  });
});

// Chaque cas des quatre revues de L745 : --liste ne dit pas « integre a la main » à tort, et après --clore le travail du run est encore atteignable par une référence.
describe('cas des quatre revues de L745 : après --clore, le travail est encore atteignable par une référence', () => {
  it.each([['le contenu du run', undefined], ['un autre contenu', 'ok et autre']])('revue 1 : conflit résolu à la main avec %s : --liste dit « conflit », l\'archive garde le commit du run', async (_, contenu) => {
    const { repo, e } = runEnConflit();
    resoudreALaMain(repo, e, contenu);
    const tete = git(repo, 'rev-parse', e.branche);
    await resteDit(repo, e, '1');
    await cloreArchive(repo, e);
    expect(refsVers(repo, tete)).toEqual([`${ARCHIVES}${e.id}`]);
    expect(git(repo, 'show', `${ARCHIVES}${e.id}:fait.txt`)).toBe('ok');
  });

  it.each(['décision.md', ':deux-points.txt', 'a\\b.txt'])('revue 2 : un fichier du run nommé %s absent de main : --liste dit « conflit », l\'archive garde le fichier', async (nom) => {
    const { repo, e } = runEnConflit(nom);
    resoudreALaMain(repo, e, undefined, nom);
    expect(git(repo, '--literal-pathspecs', 'ls-files', '--', nom)).toBe(''); // le travail du run sur ce fichier n'est pas sur main
    await resteDit(repo, e, '1');
    await cloreArchive(repo, e);
    expect(git(repo, '--literal-pathspecs', 'ls-tree', '--name-only', `${ARCHIVES}${e.id}`, '--', nom)).not.toBe('');
  });

  it.each([
    ['diff.ignoreSubmodules=all', (r: string) => { git(r, 'config', 'diff.ignoreSubmodules', 'all'); }],
    ['ignore = all dans .gitmodules', (r: string) => { ecrit(r, '.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n'); commit(r, 'sous-module ignoré'); }],
  ])('revue 3, B1 : conflit résolu sur main sans le bump de sous-module du run (%s) : --liste dit « conflit », l\'archive garde le bump', async (_, regler) => {
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
    await resteDit(repo, e, '1');
    await cloreArchive(repo, e);
    expect(git(repo, 'ls-tree', `${ARCHIVES}${e.id}`, 'sub')).toMatch(/^160000 commit /);
  });

  it('revue 3, M1 : index du worktree corrompu (git status échoue) et modification non commitée : le dossier et la modification restent', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    const tete = git(repo, 'rev-parse', e.branche);
    writeFileSync(join(e.worktree, 'fait.txt'), 'résolution locale, non commitée');
    writeFileSync(resolve(e.worktree, git(e.worktree, 'rev-parse', '--git-path', 'index')), 'index corrompu');
    const r = await lancer(repo, '--clore', e.id);
    expect(r.code).toBe(0);
    expect(r.texte).toMatch(/gardé : git status y a échoué \(/);
    expect(readFileSync(join(e.worktree, 'fait.txt'), 'utf8')).toBe('résolution locale, non commitée');
    expect(archive(repo, e)).toBe(tete);
  });

  it('revue 3, M2 : un commit fait sur un HEAD détaché du worktree, branche déjà fusionnée : il a son archive', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'perdu.txt', 'x');
    const perdu = commit(e.worktree, 'perdu');
    const t = await cloreArchive(repo, e);
    expect(t).toContain(`${ARCHIVES}${e.id}-worktree (${perdu.slice(0, 7)})`);
    expect(existsSync(e.worktree)).toBe(false);
    expect(refsVers(repo, perdu)).toEqual([`${ARCHIVES}${e.id}-worktree`]);
    expect(git(repo, 'show', `${ARCHIVES}${e.id}-worktree:perdu.txt`)).toBe('x');
  });

  it('revue 3, M3 : un commit de fusion du run qui porte du contenu, ses commits simples rejoués sur main : --liste ne dit pas intégré, l\'archive garde la fusion', async () => {
    const { repo, e } = runPorteRouge(depose('a.txt'));
    git(e.worktree, 'checkout', '-q', '-b', 'cote', e.base);
    depose('cote.txt')(e.worktree);
    git(e.worktree, 'checkout', '-q', e.branche);
    git(e.worktree, ...ID, 'merge', '-q', '--no-ff', '--no-commit', 'cote');
    ecrit(e.worktree, 'resolution.txt', 'écrit dans la fusion'); // une « evil merge » : du contenu que seul le commit de fusion porte
    const fusion = commit(e.worktree, 'fusionne cote');
    rejoue(repo, `${e.branche}^1`, `${e.branche}^2`); // le lead rejoue les deux commits simples
    await resteDit(repo, e, '3');
    await cloreArchive(repo, e);
    expect(refsVers(repo, fusion)).toContain(`${ARCHIVES}${e.id}`);
    expect(git(repo, 'show', `${ARCHIVES}${e.id}:resolution.txt`)).toBe('écrit dans la fusion');
  });

  it('revue 4, B1 : la même ligne insérée dans un autre bloc identique sur main (même patch-id) : --liste dit « porte-rouge », l\'archive garde l\'insertion du run', async () => {
    const BLOC = 'a\nb\nc\nd\ne\nf\n';
    const { repo, e } = runPorteRouge((cwd) => { ecrit(cwd, 'blocs.txt', `a\nb\nc\nX\nd\ne\nf\n${BLOC}`); commit(cwd, 'X dans le bloc 1'); }, (r) => { ecrit(r, 'blocs.txt', BLOC + BLOC); commit(r, 'deux blocs'); });
    ecrit(repo, 'blocs.txt', `${BLOC}a\nb\nc\nX\nd\ne\nf\n`); commit(repo, 'X dans le bloc 2');
    await resteDit(repo, e, '1');
    await cloreArchive(repo, e);
    expect(git(repo, 'show', `${ARCHIVES}${e.id}:blocs.txt`)).toBe(`a\nb\nc\nX\nd\ne\nf\n${BLOC}`.trim());
  });

  it('revue 4, B2 : un commit fait dans un sous-module du worktree, bump fusionné sur main : le dossier du worktree reste, le commit du sous-module aussi', async () => {
    const source = join(dossierTemp('sous-module-'), 'source'), FICHIER = ['-c', 'protocol.file.allow=always'];
    mkdirSync(source); git(source, 'init', '-q', '-b', 'main'); ecrit(source, 'lib.txt', 'v1'); commit(source, 'lib v1');
    let dansSub = '';
    const travail = (cwd: string) => {
      git(cwd, ...FICHIER, 'submodule', 'update', '-q', '--init');
      ecrit(join(cwd, 'sub'), 'lib.txt', 'travail dans le sous-module'); dansSub = commit(join(cwd, 'sub'), 'subwork'); // jamais poussé
      git(cwd, 'add', 'sub'); commit(cwd, 'bump du sous-module');
    };
    const { repo, e } = runPorteRouge(travail, (r) => { git(r, ...FICHIER, 'submodule', 'add', '-q', source, 'sub'); commit(r, 'ajoute le sous-module'); });
    git(repo, 'merge', '-q', '--ff-only', e.branche);
    expect(git(repo, 'ls-tree', 'main', 'sub')).toContain(dansSub);
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  integre a la main `, 'm'));
    const t = await cloreArchive(repo, e);
    expect(t).toMatch(new RegExp(`worktree ${e.worktree} gardé : git worktree remove a refusé \\(.*submodules`));
    expect(git(join(e.worktree, 'sub'), 'cat-file', '-t', dansSub)).toBe('commit');
    expect(git(join(e.worktree, 'sub'), 'show', `${dansSub}:lib.txt`)).toBe('travail dans le sous-module');
  });

  it('revue 4, B3 : dossier du worktree supprimé à la main, commit sur son HEAD détaché : git connaît encore ce HEAD, il est archivé', async () => {
    const { repo, e } = runEnConflit();
    git(repo, ...ID, 'merge', '-q', '-X', 'theirs', '--no-edit', e.branche);
    git(e.worktree, 'checkout', '-q', '--detach');
    ecrit(e.worktree, 'perdu.txt', 'x');
    const perdu = commit(e.worktree, 'perdu');
    rmSync(e.worktree, { recursive: true });
    expect(retirerWorktree(e)).toBe('son dossier est déjà absent, son entrée reste à git (git worktree prune)');
    const t = await cloreArchive(repo, e);
    expect(t).toContain(`${ARCHIVES}${e.id}-worktree (${perdu.slice(0, 7)})`);
    git(repo, 'worktree', 'prune'); // ce que la commande laisse à git
    expect(refsVers(repo, perdu)).toEqual([`${ARCHIVES}${e.id}-worktree`]);
  });
});
