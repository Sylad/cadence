// L745 (issue #62) : un run fini sans intégration (conflit, porte rouge…) que le lead a intégré à la main restait « conflit » dans cadence run --liste.
// 5e passe, changement de conception (quatre revues, quatre façons de perdre du travail tant que --clore supprimait sur une preuve d'intégration) : --liste ne
// fait que montrer, --clore ne retire rien qu'il n'ait d'abord archivé sous refs/cadence/archive/. Plus de patch-id, de reconnaissance par le contenu ni de --force.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { etatVu, occupantRun, oublierReglages, type Etat } from './run.js';

/** Un run qui vit encore ou se reprend (--reponse) n'est pas fini : ni « intégré à la main », ni clos. */
const REPRENABLES = ['en-cours', 'interrompu', 'attente', 'quota'];
export const ARCHIVES = 'refs/cadence/archive/';
export interface Tete { ref: string; sha: string }

function git(cwd: string, ...a: string[]) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...a], { cwd, encoding: 'utf8' });
  return { code: r.status, sortie: (r.stdout ?? '').replace(/\n+$/, ''), erreur: (r.stderr ?? '').trim() || r.error?.message || `code ${r.status}` };
}
/** Une commande git en échec n'est jamais lue comme une réponse : --clore refuse sans rien toucher, --liste dit « inconnu ». */
function sur(cwd: string, ...a: string[]): string {
  const r = git(cwd, ...a);
  if (r.code !== 0) throw new Error(`git ${a[0]} a échoué dans ${cwd} : ${r.erreur}`);
  return r.sortie;
}
/** Le commit de `ref`, '' si elle n'existe pas : rev-parse --verify -q rend alors le code 1 ; tout autre code est un échec, jamais une absence. */
function commit(repo: string, ref: string): string {
  const r = git(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (r.code !== 0 && r.code !== 1) throw new Error(`git rev-parse a échoué dans ${repo} : ${r.erreur}`);
  return r.code === 0 ? r.sortie : '';
}

/** L'entrée du worktree du run dans git worktree list, « prunable » comprise : un dossier supprimé à la main garde son HEAD dans le dépôt. */
function worktreeConnu(e: Etat): { head: string; surBranche: boolean } | undefined {
  const bloc = sur(e.repo, 'worktree', 'list', '--porcelain').split('\n\n').map((b) => b.split('\n')).find((b) => b[0] === `worktree ${e.worktree}`);
  const head = bloc?.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '';
  if (bloc && !(head && commit(e.repo, head))) throw new Error(`le HEAD du worktree ${e.worktree} ne se lit pas (« ${head} »)`);
  return bloc && { head, surBranche: bloc.includes(`branch refs/heads/${e.branche}`) };
}

/** Les têtes connues du run, chacune avec sa référence d'archive : sa branche, le HEAD de son worktree (détaché compris) et la tête notée à la fin du run. */
export function tetesDuRun(e: Etat, wt = worktreeConnu(e)): Tete[] {
  const t = [{ ref: `${ARCHIVES}${e.id}`, sha: commit(e.repo, `refs/heads/${e.branche}`) }, { ref: `${ARCHIVES}${e.id}-worktree`, sha: wt?.head ?? '' },
    { ref: `${ARCHIVES}${e.id}-fin`, sha: e.tete ? commit(e.repo, e.tete) : '' }];
  return t.filter((x, i) => x.sha && t.findIndex((y) => y.sha === x.sha) === i);
}

/** Pose l'archive puis vérifie qu'elle existe sur ce commit ; une archive du même nom sur un autre commit n'est jamais écrasée. */
function archiver(repo: string, t: Tete): void {
  const deja = commit(repo, t.ref);
  if (!deja) sur(repo, 'update-ref', t.ref, t.sha, '');
  if (commit(repo, t.ref) === t.sha) return;
  throw new Error(deja ? `l'archive ${t.ref} existe déjà sur un autre commit (${deja.slice(0, 7)}) : renomme-la d'abord (git update-ref)` : `l'archive ${t.ref} n'a pas pu être posée`);
}

/** Retire le dossier du worktree s'il est propre ; rend '' s'il est retiré, sinon pourquoi il reste. Au moindre doute il reste : git worktree remove, sans
 * --force, a le dernier mot (il refuse un fichier modifié ou non suivi, un sous-module initialisé, un dossier qui n'est plus un worktree) ; le status
 * d'abord, parce que le réglage status.showUntrackedFiles=no cacherait un fichier non suivi à git worktree remove. */
export function retirerWorktree(e: Etat): string {
  if (!existsSync(e.worktree)) return 'son dossier est déjà absent, son entrée reste à git (git worktree prune)';
  const sales = git(e.worktree, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none');
  if (sales.code !== 0) return `git status y a échoué (${sales.erreur})`;
  if (sales.sortie) return `fichiers modifiés ou non suivis : ${sales.sortie.split('\n').map((l) => l.slice(3)).join(', ')}`;
  const r = git(e.repo, 'worktree', 'remove', e.worktree);
  return r.code === 0 ? '' : `git worktree remove a refusé (${r.erreur})`;
}

/** --liste, affichage seul : « integre a la main » seulement quand la tête du run (sa branche, sinon la tête notée à la fin du run) est un ancêtre de la
 * cible ; tout autre cas reste l'état du run, avec le nombre de commits absents de la cible. */
export function integration(e: Etat): { integre: boolean; cible: string; absents: string } {
  try {
    const cible = commit(e.repo, `refs/heads/${e.cible}`), tete = commit(e.repo, `refs/heads/${e.branche}`) || (e.tete ? commit(e.repo, e.tete) : '');
    if (!cible || !tete) return { integre: false, cible, absents: `inconnu (${cible ? 'tête du run inconnue' : `branche ${e.cible} absente`})` };
    const ancetreDe = (ref: string) => git(e.repo, 'merge-base', '--is-ancestor', tete, ref).code === 0;
    if (ancetreDe(e.base)) return { integre: false, cible, absents: '0 (le run n\'a aucun commit)' };
    return { integre: ancetreDe(cible), cible, absents: sur(e.repo, 'rev-list', '--count', tete, '--not', cible) };
  } catch (x) { return { integre: false, cible: '', absents: `inconnu (${(x as Error).message})` }; }
}

/** L'état que --liste montre, et pour un run fini non intégré le nombre de ses commits absents de la cible. */
export function etatListe(e: Etat): { etat: string; absents?: string } {
  if (e.clos) {
    const quand = `clos le ${e.clos.date.slice(0, 10)}`, etait = `était ${e.etat}${e.clos.restes?.length ? ` ; ${e.clos.restes.join(' ; ')}` : ''}`;
    return { etat: e.clos.integre ?? !e.clos.force ? `integre a la main (${e.cible} = ${e.clos.cible.slice(0, 7)}), ${quand} (${etait})` : `${quand} sans intégration, travail archivé : cadence run --archives (${etait})` };
  }
  const vu = etatVu(e);
  if (vu === 'integre' || REPRENABLES.includes(vu)) return { etat: vu };
  const i = integration(e);
  return i.integre ? { etat: `integre a la main (était ${vu} ; worktree et branche : cadence run --clore ${e.id})` } : { etat: vu, absents: i.absents };
}

/** cadence run --clore <id> : archive chaque tête connue du run, vérifie les archives, puis retire la branche et, s'il est propre, le dossier du worktree.
 * Intégré ou non, le run est clos : rien de ce qui est retiré n'est perdu. Refusé pour un run qui se reprend, et quand une archive ne peut pas être posée. */
export function clore(e: Etat, out: (l: string) => void): number {
  const refus = (r: string) => { out(`cadence run --clore ${e.id} refusé : ${r}`); return 1; };
  if (e.clos) { out(`cadence run ${e.id} : déjà clos le ${e.clos.date.slice(0, 10)}`); return 0; }
  const vu = etatVu(e);
  if (vu === 'integre') return refus('intégré par cadence run, son worktree et sa branche sont déjà retirés');
  const p = occupantRun(e.fichier);
  if (REPRENABLES.includes(vu) || p) return refus(`le run est ${vu}${p ? ` (processus ${p.pid})` : ''} : il se reprend (cadence run --reponse ${e.id} "…") ou s'attend, il ne se clôt pas`);
  let wt: ReturnType<typeof worktreeConnu>, tetes: Tete[];
  try {
    wt = worktreeConnu(e); tetes = tetesDuRun(e, wt);
    for (const t of tetes) archiver(e.repo, t);
  } catch (x) { return refus(`${(x as Error).message} ; rien n'a été retiré`); }
  // Chaque tête connue est archivée et vérifiée : on ne retire que ce qu'une archive garde (la branche qu'on a lue, le worktree dont on a lu le HEAD).
  const i = integration(e), garde = wt ? retirerWorktree(e) : existsSync(e.worktree) ? 'git ne le connaît pas comme worktree de ce dépôt' : '';
  const restes = garde ? [`worktree ${e.worktree} gardé : ${garde}`] : [];
  if (garde && wt?.surBranche && existsSync(e.worktree)) git(e.worktree, 'checkout', '-q', '--detach'); // rend la branche sans toucher à un fichier
  const b = tetes[0]?.ref === `${ARCHIVES}${e.id}` ? git(e.repo, 'branch', '-D', e.branche) : null;
  if (b && b.code !== 0) restes.push(`branche ${e.branche} gardée (${b.erreur})`);
  if (!existsSync(e.worktree)) oublierReglages(e.worktree);
  const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
  etat.clos = { date: new Date().toISOString(), cible: i.cible, tete: tetes[0]?.sha ?? '', integre: i.integre, archives: tetes.map((t) => t.ref), ...(restes.length ? { restes } : {}) };
  writeFileSync(e.fichier, JSON.stringify(etat, null, 1));
  out(`cadence run ${e.id} : clos — ${i.integre ? `sa tête est sur ${e.cible} (${i.cible.slice(0, 7)})` : `non intégré, commits absents de la cible : ${i.absents}`} ; `
    + `archives : ${tetes.map((t) => `${t.ref} (${t.sha.slice(0, 7)})`).join(', ') || 'aucune, aucune tête connue'} ; ${restes.join(' ; ') || 'worktree et branche retirés'} ; `
    + 'les retrouver : cadence run --archives');
  return 0;
}

/** cadence run --archives : chaque archive posée par --clore, et la commande git qui en refait une branche. */
export function archives(repo: string): string[] {
  const l = sur(repo, 'for-each-ref', '--format=%(refname) %(objectname:short) %(committerdate:short) %(subject)', ARCHIVES).split('\n').filter(Boolean);
  return l.length ? l.map((x) => `${x}\n    restaurer : git branch archive-${x.split(' ')[0].slice(ARCHIVES.length)} ${x.split(' ')[0]}`) : ['aucune archive'];
}
