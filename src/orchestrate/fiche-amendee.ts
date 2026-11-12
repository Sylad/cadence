import { git, onRemote } from '../git.js';
import { citedRefs } from '../link.js';
import type { Ref } from '../plan.js';

// La fiche d'un rescellé amendée depuis le commit rouge (`cadence spec reseal`) : quels commits de la fiche sont admis, et pourquoi.
// L217 : un lot en cours n'admet que ses propres commits. L229 : un lot livré admet aussi ceux de son porteur et d'un lot fini.
// L713 (issue #56) : et ceux d'un lot abandonné ; un lot clos ne réécrira plus un commit poussé, la fiche vivante fait foi. Chaque commit admis pour son seul
// lot clos est rendu (`amendements`), pour le journal `resceaux`. Un commit d'un autre lot en cours bloque toujours, le refus nomme ce lot et les gestes.

/** Un commit de la fiche admis au rescellé d'un lot livré parce que son lot est fini (`done`) ou abandonné (`dropped`). */
export interface Amendement { sha: string; lot: string; etat: 'done' | 'dropped'; raison: string }

const CLOS: Record<string, string> = { done: 'fini', dropped: 'abandonné' };

/**
 * Les commits de `red..HEAD` qui ont touché `fiche` (à appeler quand elle a changé) : l'erreur du premier qui n'est pas admis, sinon le sha court du dernier
 * (`ficheAmendee`) et les amendements admis pour leur lot clos, du plus ancien au plus récent. `etats` : le statut au plan de chaque lot.
 */
export function admettreFiche(repo: string, o: { fiche: string; lot: string; red: string; porteur?: string; refsOf: (text: string) => Ref[]; etats: Record<string, string> }): { ficheAmendee?: string; amendements: Amendement[] } {
  const { fiche, lot, red, porteur, etats } = o;
  const commits = git(repo, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${red}..HEAD`, '--', fiche]).split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => { const [sha = '', subject = '', body = ''] = r.split('\x1f'); return { sha, day: '', subject, body: body.trim() }; });
  const cites = (c: (typeof commits)[number]) => [...new Set(citedRefs(c, o.refsOf).map((r) => r.lot))];
  const propres = new Set([lot, porteur]);
  // Seul le chemin du porteur (lot livré) admet un lot clos ; un lot en cours n'admet que lui-même (L217, L229 R4).
  const clos = (l: string) => porteur !== undefined && (etats[l] ?? '') in CLOS;
  const fautif = commits.find((c) => !cites(c).some((l) => propres.has(l) || clos(l)));
  if (fautif && porteur) throw new Error(refusPorteur(repo, o, fautif.sha, cites(fautif)));
  if (fautif) throw new Error(`la fiche ${fiche} a été modifiée depuis le commit rouge ${red.slice(0, 7)} par un commit qui ne cite pas ${lot} : ${fautif.sha.slice(0, 7)}`);
  const amendements = commits
    .filter((c) => !cites(c).some((l) => propres.has(l)))
    .reverse()
    .map((c) => {
      const par = cites(c).find(clos) as string;
      const etat = etats[par] as Amendement['etat'];
      return { sha: c.sha.slice(0, 7), lot: par, etat, raison: `lot ${par} ${CLOS[etat]} : son commit de la fiche est publié et ne se réécrit pas, la fiche vivante fait foi` };
    });
  return { ficheAmendee: commits[0]?.sha.slice(0, 7), amendements };
}

/**
 * Le refus d'un lot livré, avec le geste outillé de chaque cas, jamais une édition à la main de `acceptation-<lot>.json` (issue #56) : un lot en cours cité
 * (autre que le porteur) se clôt ou devient le porteur ; un lot pas commencé se clôt ou se démarre pour devenir le porteur ; un commit sans lot du plan se
 * réécrit pour citer le porteur s'il n'est pas poussé, sinon la fiche revient à son contenu du commit rouge dans un commit du porteur (comptée inchangée).
 */
function refusPorteur(repo: string, o: { fiche: string; lot: string; red: string; porteur?: string; etats: Record<string, string> }, sha: string, lots: string[]): string {
  const court = sha.slice(0, 7);
  const debut = `la fiche ${o.fiche} a été modifiée depuis le commit rouge ${o.red.slice(0, 7)} par`;
  const enCours = lots.filter((l) => o.etats[l] === 'doing');
  const [premier] = enCours;
  if (premier) return `${debut} ${court}, commit du lot en cours ${enCours.join(', ')} qui n'est pas le porteur ${o.porteur} : il bloque le rescellé tant que ${premier} est en cours — clore ${premier} (raf done ${premier}) ou l'abandonner (raf drop ${premier}), puis relancer ; ou, si ${premier} porte la correction du test, relancer avec --porteur ${premier}`;
  const constat = `${debut} un commit qui ne cite ni ${o.lot}, ni le porteur ${o.porteur}, ni un lot livré : ${court} (cite : ${lots.length ? lots.join(', ') : 'aucun lot'})`;
  const aFaire = lots.find((l) => o.etats[l] !== undefined);
  if (aFaire) return `${constat} — ${aFaire} n'est pas commencé (${o.etats[aFaire]}) : clore ${aFaire} (raf done ${aFaire}) ou l'abandonner (raf drop ${aFaire}), puis relancer ; ou, si ${aFaire} porte la correction du test, le démarrer (raf start ${aFaire}) et relancer avec --porteur ${aFaire}`;
  const inconnus = lots.length ? ` (${lots.join(', ')} ${lots.length > 1 ? "ne sont pas" : "n'est pas"} au plan)` : '';
  if (!onRemote(repo, sha)) return `${constat} — ce commit n'est pas poussé${inconnus} : le réécrire pour qu'il cite le porteur ${o.porteur} (git commit --amend s'il est le dernier commit, sinon git rebase -i ${court}^ et reword), puis relancer`;
  return `${constat} — ce commit est poussé et ne se réécrit pas${inconnus} : remettre la fiche au contenu du commit rouge dans un commit qui cite le porteur (git checkout ${o.red.slice(0, 7)} -- ${o.fiche}, puis git commit -m "docs(${o.porteur}): fiche remise au commit rouge" -- ${o.fiche}) et relancer, une fiche revenue au contenu du commit rouge compte comme inchangée ; l'amendement se refait ensuite dans un commit qui cite ${o.porteur}`;
}
