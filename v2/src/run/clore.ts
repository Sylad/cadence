// L745 (issue #62) : un run fini sans intégration (conflit, porte rouge…) que le lead a intégré à la main restait « conflit » dans cadence run --liste.
// 4e passe : une règle explicite au lieu d'heuristiques, écrite en tableau dans docs/v2/2026-11-09-cadence-run.md (« Tableau de --liste et --clore »), une fonction
// par ligne. « integre a la main » demande une preuve pour CHAQUE commit du run ; tout le reste (git en échec, worktree non vide, cas non prévu) vaut
// « non intégré », et seul --clore --force clôt alors, en nommant les commits perdus. Plus de reconnaissance par le contenu des fichiers ni de git cherry.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { etatVu, occupantRun, retirerRun, type Etat } from './run.js';

/** Un run qui vit encore ou se reprend (--reponse) n'est pas fini : ni « intégré à la main », ni clos. */
const REPRENABLES = ['en-cours', 'interrompu', 'attente', 'quota'];
/** Réglages imposés à chaque commande : un sous-module n'est jamais ignoré, un nom de fichier n'est jamais cité. */
const REGLAGES = ['-c', 'diff.ignoreSubmodules=none', '-c', 'core.quotePath=false'];
/** Le patch d'un commit, le même quels que soient les réglages du dépôt : binaire en entier, gitlink d'un sous-module compris, ni renommage ni filtre. */
const PATCH = ['diff-tree', '--stdin', '--root', '-p', '--full-index', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
  '--submodule=short', '--ignore-submodules=none'];

export class GitEnEchec extends Error {}
export interface Commit { sha: string; fusion: boolean; sujet: string }
/** `perdus` sur un refus : les commits du run sans preuve sur la cible, seul refus que --force passe. */
export type Integration = { integre: true; tetes: string[]; cible: string; preuve: string }
  | { integre: false; raison: string; tetes?: string[]; cible?: string; perdus?: Commit[] };

/** Ligne 1 : une commande git en échec (code non nul, signal, lancement impossible) n'est jamais lue comme une réponse ; integrationManuelle en fait un refus. */
export function gitOuEchec(cwd: string, a: string[], entree?: Buffer | string): Buffer {
  const r = spawnSync('git', [...REGLAGES, ...a], { cwd, input: entree, maxBuffer: Infinity });
  if (r.status !== 0) throw new GitEnEchec(`git ${a[0]} a échoué dans ${cwd} : ${String(r.stderr ?? '').trim() || r.error?.message || `code ${r.status}`}`);
  return r.stdout;
}
const lignes = (cwd: string, ...a: string[]) => gitOuEchec(cwd, a).toString().split('\n').filter(Boolean);
/** Le commit d'une branche locale, '' si elle n'existe pas (for-each-ref rend 0 et rien : une absence, pas un échec). */
const branche = (repo: string, nom: string) => lignes(repo, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${nom}`)
  .find((l) => l.startsWith(`refs/heads/${nom} `))?.split(' ')[1] ?? '';
const nomme = (c: Commit) => `${c.sha.slice(0, 7)} ${c.sujet}${c.fusion ? ' (commit de fusion)' : ''}`;

/** Ligne 2 : les têtes du run, toutes à prouver : sa branche, le HEAD de son worktree (détaché compris) et la tête notée à la fin du run si git l'a encore. */
export function tetesDuRun(e: Etat): string[] {
  const tetes = [branche(e.repo, e.branche)];
  if (existsSync(e.worktree)) {
    const [racine, head] = lignes(e.worktree, 'rev-parse', '--show-toplevel', 'HEAD^{commit}');
    if (realpathSync(racine) !== realpathSync(e.worktree)) throw new GitEnEchec(`${e.worktree} n'est plus un worktree git (dépôt trouvé : ${racine})`);
    tetes.push(head);
  }
  const notee = e.tete ? /^([0-9a-f]{40,64}) commit /.exec(gitOuEchec(e.repo, ['cat-file', '--batch-check'], `${e.tete}\n`).toString()) : null;
  return [...new Set([...tetes, notee?.[1] ?? ''].filter(Boolean))];
}

/** Ligne 3 : les fichiers modifiés ou non suivis du worktree (sous-modules compris), que le retrait du worktree supprimerait. */
export function fichiersNonCommites(e: Etat): string[] {
  if (!existsSync(e.worktree)) return [];
  return lignes(e.worktree, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none').map((l) => l.slice(3));
}

/** Ligne 5 : les commits atteignables depuis une tête du run et pas depuis la cible, fusions comprises ; tous les autres sont des ancêtres de la cible. */
export function commitsHorsCible(repo: string, tetes: string[], cible: string): Commit[] {
  const l = lignes(repo, 'rev-list', '--format=%P|%s', ...tetes, '--not', cible);
  return Array.from({ length: l.length / 2 }, (_, i) => {
    const [parents, ...sujet] = l[2 * i + 1].split('|');
    return { sha: l[2 * i].slice('commit '.length), fusion: parents.includes(' '), sujet: sujet.join('|') };
  });
}

/** Le patch-id de chaque commit simple atteignable depuis `de` et pas depuis `sauf` ; --verbatim : un patch qui ne diffère que par des espaces est un autre patch. */
function patchIds(repo: string, de: string[], sauf: string[]): Map<string, string> {
  const commits = gitOuEchec(repo, ['rev-list', '--no-merges', ...de, '--not', ...sauf]);
  const ids = gitOuEchec(repo, ['patch-id', '--verbatim'], gitOuEchec(repo, PATCH, commits)).toString().split('\n').filter(Boolean);
  return new Map(ids.map((l) => { const [id, commit] = l.split(' '); return [commit, id]; }));
}

/** Lignes 6 à 8 : parmi les commits hors de la cible, ceux qu'aucun commit de la cible ne rejoue à l'identique (même patch-id) ; une fusion et un commit
 * vide n'ont pas de patch-id : ils restent sans preuve. */
export function commitsSansPatchSurCible(repo: string, tetes: string[], cible: string, hors: Commit[]): Commit[] {
  const duRun = patchIds(repo, tetes, [cible]), surCible = new Set(patchIds(repo, [cible], tetes).values());
  return hors.filter((c) => c.fusion || !surCible.has(duRun.get(c.sha) ?? ''));
}

/** Le tableau entier, dans l'ordre de ses lignes : intégré seulement si chaque commit du run est un ancêtre de la cible ou y a son patch à l'identique. */
export function integrationManuelle(e: Etat): Integration {
  const non = (raison: string): Integration => ({ integre: false, raison });
  try {
    const cible = branche(e.repo, e.cible), tetes = tetesDuRun(e), sales = fichiersNonCommites(e);
    if (!cible) return non(`la branche cible ${e.cible} n'existe plus`);
    if (!tetes.length) return non(`branche ${e.branche} et worktree absents, tête du run inconnue : intégration invérifiable`);
    if (sales.length) return non(`le worktree ${e.worktree} a des modifications non commitées : ${sales.join(', ')}`);
    if (lignes(e.repo, 'rev-list', '--count', ...tetes, '--not', e.base)[0] === '0') return non('le run n\'a aucun commit : rien n\'a été intégré');
    const hors = commitsHorsCible(e.repo, tetes, cible), perdus = hors.length ? commitsSansPatchSurCible(e.repo, tetes, cible, hors) : [];
    if (!perdus.length) return { integre: true, tetes, cible, preuve: `tous ses commits sont sur ${e.cible}${hors.length ? ` (${hors.length} par le même patch rejoué)` : ''}` };
    return { integre: false, tetes, cible, perdus, raison: `${perdus.length} commit(s) du run absent(s) de ${e.cible} : ${perdus.map(nomme).join(' ; ')} ; intègre-les d'abord `
      + `(même commit ou même patch) ; s'ils y sont sous une autre forme (conflit résolu à la main) ou ne servent plus, clos en les perdant : cadence run --clore ${e.id} --force` };
  } catch (x) {
    if (!(x instanceof GitEnEchec)) throw x;
    return non(`${x.message} : intégration invérifiable`);
  }
}

/** L'état que --liste montre : « integre a la main » pour un run fini non intégré que le tableau dit intégré, ou déjà clos. */
export function etatListe(e: Etat): string {
  if (e.clos?.force) return `clos le ${e.clos.date.slice(0, 10)} par --force, sans preuve d'intégration (était ${e.etat})`;
  if (e.clos) return `integre a la main (${e.cible} = ${e.clos.cible.slice(0, 7)}), clos le ${e.clos.date.slice(0, 10)} (était ${e.etat})`;
  const vu = etatVu(e);
  if (vu === 'integre' || REPRENABLES.includes(vu)) return vu;
  const i = integrationManuelle(e);
  return i.integre ? `integre a la main (était ${vu} ; worktree et branche : cadence run --clore ${e.id})` : vu;
}

/** Lignes 9 et 10 : cadence run --clore <id> [--force] retire le worktree et la branche d'un run que le tableau dit intégré ; refuse sinon, en donnant la raison.
 * `force` passe un seul refus, « commits absents de la cible », et nomme ces commits : ce sont eux qui sont perdus. */
export function clore(e: Etat, out: (l: string) => void, force = false): number {
  const refus = (r: string) => { out(`cadence run --clore ${e.id} refusé : ${r}`); return 1; };
  if (e.clos) { out(`cadence run ${e.id} : déjà clos le ${e.clos.date.slice(0, 10)}`); return 0; }
  const vu = etatVu(e);
  if (vu === 'integre') return refus('intégré par cadence run, son worktree et sa branche sont déjà retirés');
  const p = occupantRun(e.fichier);
  if (REPRENABLES.includes(vu) || p) return refus(`le run est ${vu}${p ? ` (processus ${p.pid})` : ''} : il se reprend (cadence run --reponse ${e.id} "…") ou s'attend, il ne se clôt pas`);
  const i = integrationManuelle(e);
  if (!i.integre && !(force && i.perdus)) return refus(i.raison);
  const echec = retirerRun(e);
  if (echec) return refus(echec);
  const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat, tetes = i.tetes as string[], cible = i.cible as string;
  etat.clos = { date: new Date().toISOString(), cible, tete: tetes[0], ...(i.integre ? {} : { force: true as const }) };
  writeFileSync(e.fichier, JSON.stringify(etat, null, 1));
  const retires = `worktree ${e.worktree} et branche ${e.branche} retirés`;
  out(i.integre ? `cadence run ${e.id} : clos — ${i.preuve} (${cible.slice(0, 7)}) ; ${retires}`
    : `cadence run ${e.id} : clos sans preuve d'intégration (--force) ; ${retires} ; ${i.perdus?.length} commit(s) perdu(s), absent(s) de ${e.cible} : `
      + `${i.perdus?.map(nomme).join(' ; ')} ; tête(s) du run : ${tetes.join(', ')} (git branch <nom> <sha> les retrouve tant que git les garde)`);
  return 0;
}
