// L745 (issue #62) : un run fini sans intégration (conflit, avance rapide refusée, porte rouge…) dont le lead a ensuite intégré les commits à la main
// restait « conflit » dans cadence run --liste, worktree et branche gardés. --liste le dit intégré à la main quand tous ses commits sont sur la cible
// (même commit, ou même patch rejoué : git cherry) ; cadence run --clore <id> retire alors son worktree et sa branche, et le note dans l'état du run.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { libererReglages } from '../bench/bras.js';
import { etatVu, occupantRun, type Etat } from './run.js';

/** Un run qui vit encore ou se reprend (--reponse) n'est pas fini : ni « intégré à la main », ni clos. */
const REPRENABLES = ['en-cours', 'interrompu', 'attente', 'quota'];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const sha = (repo: string, ref: string) => { const r = git(repo, 'rev-parse', '--verify', '-q', ref); return r.status === 0 ? r.stdout.trim() : ''; };

export type Integration = { integre: true; tete: string; cible: string } | { integre: false; raison: string };

/** La tête du run : sa branche, sinon la tête notée à la fin du run (`tete`, objet encore présent), sinon le HEAD de son worktree. */
function teteDuRun(e: Etat): string {
  return sha(e.repo, `refs/heads/${e.branche}`) || (e.tete ? sha(e.repo, `${e.tete}^{commit}`) : '') || (existsSync(e.worktree) ? sha(e.worktree, 'HEAD') : '');
}

/** Tous les commits du run (base..tête) sont-ils sur la cible ? Sinon, la raison en une phrase. */
export function integrationManuelle(e: Etat): Integration {
  const tete = teteDuRun(e), cible = sha(e.repo, `refs/heads/${e.cible}`);
  if (!cible) return { integre: false, raison: `la branche cible ${e.cible} n'existe plus` };
  if (!tete) return { integre: false, raison: `branche ${e.branche} et worktree absents, tête du run inconnue : intégration invérifiable` };
  const n = git(e.repo, 'rev-list', '--count', `${e.base}..${tete}`);
  if (n.status !== 0 || n.stdout.trim() === '0') return { integre: false, raison: 'le run n\'a aucun commit : rien n\'a été intégré' };
  const c = git(e.repo, 'cherry', '-v', cible, tete, e.base);
  if (c.status !== 0) return { integre: false, raison: `git cherry a échoué : ${c.stderr.trim()}` };
  const absents = c.stdout.split('\n').filter((l) => l.startsWith('+ ')).map((l) => `${l.slice(2, 9)}${l.slice(42)}`);
  if (absents.length) return { integre: false, raison: `${absents.length} commit(s) du run absent(s) de ${e.cible} : ${absents.join(' ; ')} ; intègre-les d'abord` };
  return { integre: true, tete, cible };
}

/** L'état que --liste montre : « integre a la main » pour un run fini non intégré dont tous les commits sont sur la cible, ou déjà clos. */
export function etatListe(e: Etat): string {
  if (e.clos) return `integre a la main (${e.cible} = ${e.clos.cible.slice(0, 7)}), clos le ${e.clos.date.slice(0, 10)} (était ${e.etat})`;
  const vu = etatVu(e);
  if (vu === 'integre' || REPRENABLES.includes(vu)) return vu;
  const i = integrationManuelle(e);
  return i.integre ? `integre a la main (était ${vu} ; worktree et branche : cadence run --clore ${e.id})` : vu;
}

/** cadence run --clore <id> : retire le worktree et la branche d'un run fini non intégré dont tous les commits sont sur la cible ; refuse sinon, en disant pourquoi. */
export function clore(e: Etat, out: (l: string) => void): number {
  const refus = (r: string) => { out(`cadence run --clore ${e.id} refusé : ${r}`); return 1; };
  if (e.clos) { out(`cadence run ${e.id} : déjà clos le ${e.clos.date.slice(0, 10)}`); return 0; }
  const vu = etatVu(e);
  if (vu === 'integre') return refus('intégré par cadence run, son worktree et sa branche sont déjà retirés');
  const p = occupantRun(e.fichier);
  if (REPRENABLES.includes(vu) || p) return refus(`le run est ${vu}${p ? ` (processus ${p.pid})` : ''} : il se reprend (cadence run --reponse ${e.id} "…") ou s'attend, il ne se clôt pas`);
  const i = integrationManuelle(e);
  if (!i.integre) return refus(i.raison);
  if (existsSync(e.worktree)) {
    const sale = git(e.worktree, 'status', '--porcelain');
    if (sale.stdout.trim()) return refus(`le worktree ${e.worktree} a des modifications non commitées : ${sale.stdout.trim().split('\n').map((l) => l.slice(3)).join(', ')}`);
    const r = git(e.repo, 'worktree', 'remove', '--force', e.worktree);
    if (r.status !== 0 && existsSync(e.worktree)) return refus(`git worktree remove a échoué : ${r.stderr.trim()}`);
  }
  git(e.repo, 'worktree', 'prune');
  if (sha(e.repo, `refs/heads/${e.branche}`)) {
    const r = git(e.repo, 'branch', '-D', e.branche);
    if (r.status !== 0) return refus(`git branch -D ${e.branche} a échoué : ${r.stderr.trim()}`);
  }
  libererReglages(e.worktree);
  rmSync(`${e.worktree}.reglages`, { recursive: true, force: true });
  const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
  etat.clos = { date: new Date().toISOString(), cible: i.cible, tete: i.tete };
  writeFileSync(e.fichier, JSON.stringify(etat, null, 1));
  out(`cadence run ${e.id} : clos — tous ses commits sont sur ${e.cible} (${i.cible.slice(0, 7)}) ; worktree ${e.worktree} et branche ${e.branche} retirés`);
  return 0;
}
