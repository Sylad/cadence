// L745 (issue #62) : un run fini sans intégration (conflit, avance rapide refusée, porte rouge…) dont le lead a ensuite intégré les commits à la main
// restait « conflit » dans cadence run --liste, worktree et branche gardés. --liste le dit intégré à la main quand tous ses commits sont sur la cible
// (même commit, ou même patch rejoué : git cherry), ou, revue M1, quand chaque fichier qu'il change a sur la cible le contenu de sa tête (conflit résolu
// à la main : le patch-id change) ; cadence run --clore <id> retire alors son worktree et sa branche, et le note dans l'état du run. Une résolution qui
// diffère du run n'est pas une preuve : --clore la refuse en nommant les fichiers, et --force clôt sans preuve, noté comme tel.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { etatVu, occupantRun, retirerRun, type Etat } from './run.js';

/** Un run qui vit encore ou se reprend (--reponse) n'est pas fini : ni « intégré à la main », ni clos. */
const REPRENABLES = ['en-cours', 'interrompu', 'attente', 'quota'];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const sha = (repo: string, ref: string) => { const r = git(repo, 'rev-parse', '--verify', '-q', ref); return r.status === 0 ? r.stdout.trim() : ''; };
const noms = (r: ReturnType<typeof git>) => r.stdout.split('\n').filter(Boolean);

/** `tete` sur un refus : les commits du run manquent à la cible, seul refus que --force passe. */
export type Integration = { integre: true; tete: string; cible: string; preuve: string } | { integre: false; raison: string; tete?: string; cible?: string };

/** La tête du run : sa branche, sinon la tête notée à la fin du run (`tete`, objet encore présent), sinon le HEAD de son worktree. */
function teteDuRun(e: Etat): string {
  return sha(e.repo, `refs/heads/${e.branche}`) || (e.tete ? sha(e.repo, `${e.tete}^{commit}`) : '') || (existsSync(e.worktree) ? sha(e.worktree, 'HEAD') : '');
}

/** Revue L745 (M1) : les fichiers que le run change depuis son départ de la cible (merge-base), et ceux dont la cible n'a pas le contenu de la tête du run. */
function contenuSurCible(e: Etat, tete: string, cible: string): { fichiers: string[]; differents: string[] } {
  const depart = git(e.repo, 'merge-base', cible, tete).stdout.trim() || e.base;
  const fichiers = noms(git(e.repo, 'diff', '--name-only', '--no-renames', depart, tete));
  return { fichiers, differents: fichiers.length ? noms(git(e.repo, 'diff', '--name-only', '--no-renames', tete, cible, '--', ...fichiers)) : [] };
}

/** Tous les commits du run (base..tête) sont-ils sur la cible, ou leur contenu ? Sinon, la raison en une phrase. */
export function integrationManuelle(e: Etat): Integration {
  const tete = teteDuRun(e), cible = sha(e.repo, `refs/heads/${e.cible}`);
  if (!cible) return { integre: false, raison: `la branche cible ${e.cible} n'existe plus` };
  if (!tete) return { integre: false, raison: `branche ${e.branche} et worktree absents, tête du run inconnue : intégration invérifiable` };
  const n = git(e.repo, 'rev-list', '--count', `${e.base}..${tete}`);
  if (n.status !== 0 || n.stdout.trim() === '0') return { integre: false, raison: 'le run n\'a aucun commit : rien n\'a été intégré' };
  const c = git(e.repo, 'cherry', '-v', cible, tete, e.base);
  if (c.status !== 0) return { integre: false, raison: `git cherry a échoué : ${c.stderr.trim()}` };
  const absents = c.stdout.split('\n').filter((l) => l.startsWith('+ ')).map((l) => `${l.slice(2, 9)}${l.slice(42)}`);
  if (!absents.length) return { integre: true, tete, cible, preuve: `tous ses commits sont sur ${e.cible}` };
  const { fichiers, differents } = contenuSurCible(e, tete, cible);
  if (!differents.length) return { integre: true, tete, cible, preuve: `les fichiers du run (${fichiers.join(', ')}) ont sur ${e.cible} le contenu de sa tête (conflit résolu à la main)` };
  return { integre: false, tete, cible, raison: `${absents.length} commit(s) du run absent(s) de ${e.cible} : ${absents.join(' ; ')} ; intègre-les d'abord (contenu différent sur ${e.cible} : `
    + `${differents.join(', ')} ; si ta résolution les a changés exprès, clos sans preuve : cadence run --clore ${e.id} --force)` };
}

/** L'état que --liste montre : « integre a la main » pour un run fini non intégré dont les commits ou leur contenu sont sur la cible, ou déjà clos. */
export function etatListe(e: Etat): string {
  if (e.clos?.force) return `clos le ${e.clos.date.slice(0, 10)} par --force, sans preuve d'intégration (était ${e.etat})`;
  if (e.clos) return `integre a la main (${e.cible} = ${e.clos.cible.slice(0, 7)}), clos le ${e.clos.date.slice(0, 10)} (était ${e.etat})`;
  const vu = etatVu(e);
  if (vu === 'integre' || REPRENABLES.includes(vu)) return vu;
  const i = integrationManuelle(e);
  return i.integre ? `integre a la main (était ${vu} ; worktree et branche : cadence run --clore ${e.id})` : vu;
}

/** cadence run --clore <id> [--force] : retire le worktree et la branche d'un run fini non intégré dont les commits ou leur contenu sont sur la cible ;
 * refuse sinon, en disant pourquoi. `force` passe seulement le refus « commits absents de la cible » (la tête du run est connue et donnée). */
export function clore(e: Etat, out: (l: string) => void, force = false): number {
  const refus = (r: string) => { out(`cadence run --clore ${e.id} refusé : ${r}`); return 1; };
  if (e.clos) { out(`cadence run ${e.id} : déjà clos le ${e.clos.date.slice(0, 10)}`); return 0; }
  const vu = etatVu(e);
  if (vu === 'integre') return refus('intégré par cadence run, son worktree et sa branche sont déjà retirés');
  const p = occupantRun(e.fichier);
  if (REPRENABLES.includes(vu) || p) return refus(`le run est ${vu}${p ? ` (processus ${p.pid})` : ''} : il se reprend (cadence run --reponse ${e.id} "…") ou s'attend, il ne se clôt pas`);
  const i = integrationManuelle(e);
  if (!i.integre && !(force && i.tete && i.cible)) return refus(i.raison);
  if (existsSync(e.worktree)) {
    const sale = git(e.worktree, 'status', '--porcelain');
    if (sale.stdout.trim()) return refus(`le worktree ${e.worktree} a des modifications non commitées : ${sale.stdout.trim().split('\n').map((l) => l.slice(3)).join(', ')}`);
  }
  const echec = retirerRun(e);
  if (echec) return refus(echec);
  const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat, tete = i.tete as string, cible = i.cible as string;
  etat.clos = { date: new Date().toISOString(), cible, tete, ...(i.integre ? {} : { force: true as const }) };
  writeFileSync(e.fichier, JSON.stringify(etat, null, 1));
  out(i.integre ? `cadence run ${e.id} : clos — ${i.preuve} (${cible.slice(0, 7)}) ; worktree ${e.worktree} et branche ${e.branche} retirés`
    : `cadence run ${e.id} : clos sans preuve d'intégration (--force) ; worktree ${e.worktree} et branche ${e.branche} retirés ; tête du run : ${tete} (git branch <nom> ${tete.slice(0, 7)} la retrouve tant que git la garde)`);
  return 0;
}
