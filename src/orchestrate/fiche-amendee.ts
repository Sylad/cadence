import { git, onRemote } from '../git.js';
import { citedRefs } from '../link.js';
import type { Ref } from '../plan.js';

// La fiche d'un rescellé amendée depuis le commit rouge (`cadence spec reseal`) : quels commits de la fiche sont admis, et pourquoi.
// L217 : un lot en cours n'admet que ses propres commits. L229 : un lot livré admet aussi ceux de son porteur et d'un lot fini.
// L713 (issue #56) : et ceux d'un lot abandonné ; un lot clos ne réécrira plus un commit poussé, la fiche vivante fait foi. Chaque commit admis pour son seul
// lot clos est rendu (`amendements`), pour le journal `resceaux`. Un commit d'un autre lot en cours bloque toujours, le refus nomme ce lot et les gestes.
// L729 (issue #60) : un commit acquitté par `raf ignore` (sha ou sujet exact, la section `acknowledged` du plan) est admis aussi, et inscrit dans `amendements`
// avec la raison de l'acquittement : le commit poussé d'un collègue, fait hors cadence, ne force plus à remettre la fiche au commit rouge.

/** Un commit de la fiche admis au rescellé parce que son lot est fini (`done`) ou abandonné (`dropped`, lot livré seulement), ou parce qu'il est acquitté (`raf ignore`). */
export type Amendement = { sha: string; lot: string; etat: 'done' | 'dropped'; raison: string } | { sha: string; etat: 'acquitté'; raison: string };

/** Un acquittement de `raf ignore` tel que le plan le garde : sha complet ou sujet exact, et sa raison. */
export interface Acquittement { sha?: string; subject?: string; date?: string; reason?: string }

const CLOS: Record<string, string> = { done: 'fini', dropped: 'abandonné' };

/**
 * Les commits de `red..HEAD` qui ont touché `fiche` (à appeler quand elle a changé) : l'erreur du premier qui n'est pas admis, sinon le sha court du dernier
 * (`ficheAmendee`) et les amendements admis pour leur lot clos ou leur acquittement (`acquittes`, L729), du plus ancien au plus récent. `etats` : le statut au plan de chaque lot.
 */
export function admettreFiche(repo: string, o: { fiche: string; lot: string; red: string; porteur?: string; refsOf: (text: string) => Ref[]; etats: Record<string, string>; acquittes?: Acquittement[] }): { ficheAmendee?: string; amendements: Amendement[] } {
  const { fiche, lot, red, porteur, etats } = o;
  const acquittes = o.acquittes ?? [];
  const commits = git(repo, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${red}..HEAD`, '--', fiche]).split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => { const [sha = '', subject = '', body = ''] = r.split('\x1f'); return { sha, day: '', subject, body: body.trim() }; });
  const cites = (c: (typeof commits)[number]) => [...new Set(citedRefs(c, o.refsOf).map((r) => r.lot))];
  const propres = new Set([lot, porteur]);
  // Seul le chemin du porteur (lot livré) admet un lot clos ; un lot en cours n'admet que lui-même (L217, L229 R4).
  const clos = (l: string) => porteur !== undefined && (etats[l] ?? '') in CLOS;
  // Comme `raf check` (audit.ts) : par le sha complet, ou par le sujet exact pour une entrée sans sha.
  const acquit = (c: (typeof commits)[number]) => acquittes.find((a) => (a.sha !== undefined && a.sha === c.sha) || (a.sha === undefined && a.subject === c.subject));
  const fautif = commits.find((c) => !acquit(c) && !cites(c).some((l) => propres.has(l) || clos(l)));
  if (fautif && porteur) throw new Error(refusPorteur(repo, o, fautif.sha, cites(fautif)));
  if (fautif) throw new Error(`la fiche ${fiche} a été modifiée depuis le commit rouge ${red.slice(0, 7)} par un commit qui ne cite pas ${lot} : ${fautif.sha.slice(0, 7)}`);
  const amendements = commits
    .filter((c) => !cites(c).some((l) => propres.has(l)))
    .reverse()
    .map((c): Amendement => {
      const a = acquit(c);
      if (a) return { sha: c.sha.slice(0, 7), etat: 'acquitté', raison: `acquitté par raf ignore${a.date ? ` le ${a.date}` : ''} : ${a.reason?.trim() || 'sans raison donnée'}` };
      const par = cites(c).find(clos) as string;
      const etat = etats[par] as 'done' | 'dropped';
      return { sha: c.sha.slice(0, 7), lot: par, etat, raison: `lot ${par} ${CLOS[etat]} : son commit de la fiche est publié et ne se réécrit pas, la fiche vivante fait foi` };
    });
  return { ficheAmendee: commits[0]?.sha.slice(0, 7), amendements };
}

/**
 * Le refus d'un lot livré, avec le geste outillé de chaque cas, jamais une édition à la main de `acceptation-<lot>.json` (issue #56) : un lot en cours cité
 * (autre que le porteur) se clôt ou devient le porteur ; un lot pas commencé se clôt ou se démarre pour devenir le porteur ; un commit sans lot du plan se
 * réécrit pour citer le porteur s'il n'est pas poussé ; poussé ou non, il s'acquitte (`raf ignore`, L729), sans défaire le travail des lots livrés depuis le commit rouge.
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
  const acquitter = `l'acquitter (raf ignore ${court} --reason "pourquoi ce commit amende la fiche hors d'un lot", plan commité), puis relancer : il est admis et inscrit dans resceaux avec sa raison`;
  if (!onRemote(repo, sha)) return `${constat} — ce commit n'est pas poussé${inconnus} : le réécrire pour qu'il cite le porteur ${o.porteur} (git commit --amend s'il est le dernier commit, sinon git rebase -i ${court}^ et reword), puis relancer ; ou ${acquitter}`;
  return `${constat} — ce commit est poussé et ne se réécrit pas${inconnus} : ${acquitter}`;
}
