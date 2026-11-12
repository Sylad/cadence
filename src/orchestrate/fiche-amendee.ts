import { git } from '../git.js';
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
  if (fautif && porteur) throw new Error(refusPorteur(o, fautif.sha.slice(0, 7), cites(fautif)));
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

/** Le refus d'un lot livré : un lot en cours cité (autre que le porteur) est nommé avec ses gestes ; sinon les lots cités et la voie de L229. */
function refusPorteur(o: { fiche: string; lot: string; red: string; porteur?: string; etats: Record<string, string> }, sha: string, lots: string[]): string {
  const debut = `la fiche ${o.fiche} a été modifiée depuis le commit rouge ${o.red.slice(0, 7)} par`;
  const enCours = lots.filter((l) => o.etats[l] === 'doing');
  const [premier] = enCours;
  if (premier) return `${debut} ${sha}, commit du lot en cours ${enCours.join(', ')} qui n'est pas le porteur ${o.porteur} : il bloque le rescellé tant que ${premier} est en cours — clore ${premier} (raf done ${premier}) ou l'abandonner (raf drop ${premier}), puis relancer ; ou, si ${premier} porte la correction du test, relancer avec --porteur ${premier}`;
  return `${debut} un commit qui ne cite ni ${o.lot}, ni le porteur ${o.porteur}, ni un lot livré : ${sha} (cite : ${lots.length ? lots.join(', ') : 'aucun lot'}) — faire citer le porteur ou un lot livré par ce commit (le réécrire avant qu'il soit poussé) ou, sinon, rescelle à la main avec le lead`;
}
