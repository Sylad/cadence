// L767 : le dossier des runs (../.cadence-run) gardait tout : 51 dossiers de captures et 174 fichiers d'état le 17-11. `cadence run --purger` retire les
// fichiers d'un run fini depuis plus de N jours (`run.purgeAfterDays` de cadence.yaml, 14 par défaut) : état, verrou, captures, question, réglages, et son
// journal --fond quand plus aucun run gardé ne le cite. `--dry-run` liste sans rien retirer. Seuls les runs intégrés par cadence run ou clos par --clore
// sont candidats, et seulement quand leur worktree n'existe plus et qu'aucun processus ne tient leur verrou : un run en cours, en attente (question), en
// quota ou rendu au lead (conflit, porte rouge…) n'est jamais touché. Les archives git (refs/cadence/archive/) restent.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { occupantRun, oublierReglages, type Etat } from './run.js';

export const PURGE_JOURS_DEFAUT = 14;
const JOUR_MS = 86_400_000;

/** `run.purgeAfterDays` du cadence.yaml du dépôt : un entier positif ou nul ; une autre valeur est refusée avant toute suppression. */
export function joursPurge(repo: string): number {
  const f = join(repo, 'cadence.yaml');
  const v = (existsSync(f) ? (parse(readFileSync(f, 'utf8')) as { run?: { purgeAfterDays?: unknown } } | null)?.run : undefined)?.purgeAfterDays;
  if (v === undefined || v === null) return PURGE_JOURS_DEFAUT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`cadence.yaml : run.purgeAfterDays : un nombre entier de jours, 0 ou plus, attendu (reçu « ${String(v)} »)`);
  return v;
}

/** La date de fin d'un run fini : sa clôture (--clore), sinon la dernière écriture de son état (l'intégration, dernière écriture d'un run intégré). */
const finDuRun = (e: Etat): number => (e.clos ? Date.parse(e.clos.date) : statSync(e.fichier).mtimeMs);

/** Pourquoi le run est gardé, ou '' s'il se purge. */
function garde(e: Etat, limite: number): string {
  if (!e.clos && e.etat !== 'integre') return 'pas fini'; // en cours, interrompu, en attente, en quota, rendu au lead : jamais touché
  const p = occupantRun(e.fichier);
  if (p) return `processus ${p.pid} tient son verrou`;
  if (existsSync(e.worktree)) return `worktree gardé : ${e.worktree}`;
  if (finDuRun(e) > limite) return 'récent';
  return '';
}

/** Les fichiers annexes du run : `<nom>.json`, `.verrou` dans le dossier des runs ; `<worktree>.captures`, `.question.md`, `.reglages`… à côté du worktree. */
function annexes(e: Etat): string[] {
  const noms = [[dirname(e.fichier), basename(e.fichier).replace(/\.json$/, '')], [dirname(e.worktree), basename(e.worktree)]];
  const vus = new Set<string>();
  for (const [d, nom] of noms) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.startsWith(`${nom}.`)) vus.add(join(d, f));
  }
  return [...vus].sort();
}

interface Candidat { e: Etat; fichiers: string[] }

/**
 * cadence run --purger [--dry-run] : liste chaque run purgeable du dépôt `racine` et ses fichiers, puis les retire (sauf --dry-run). `maintenant` : l'horloge,
 * pour les tests. Les runs gardés qui ont passé le délai (worktree présent, verrou tenu) sont nommés avec leur raison ; un run pas fini ne l'est pas.
 */
export function purger(racine: string, dossier: string, o: { dryRun: boolean; out: (l: string) => void; maintenant?: () => Date }): number {
  const jours = joursPurge(racine), limite = (o.maintenant?.() ?? new Date()).getTime() - jours * JOUR_MS;
  const tous = existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { return [{ ...(JSON.parse(readFileSync(join(dossier, f), 'utf8')) as Etat), fichier: join(dossier, f) }]; } catch { return []; } // illisible : jamais touché
  }) : [];
  const candidats: Candidat[] = [];
  for (const e of tous.filter((x) => x.repo === racine)) {
    const raison = garde(e, limite);
    if (!raison) candidats.push({ e, fichiers: annexes(e) });
    else if (raison !== 'pas fini' && raison !== 'récent') o.out(`gardé ${e.id} : ${raison}`);
  }
  // Un journal --fond est retiré avec le dernier run qui le cite (plusieurs runs peuvent écrire dans le même journal : --reponse --fond).
  const purges = new Set(candidats.map((c) => c.e.fichier));
  const cites = new Set(tous.filter((x) => !purges.has(x.fichier)).map((x) => x.journal).filter(Boolean));
  for (const c of candidats) {
    const j = c.e.journal;
    if (j && dirname(j) === dossier && basename(j).startsWith('fond-') && existsSync(j) && !cites.has(j) && !candidats.some((x) => x !== c && x.fichiers.includes(j))) c.fichiers.push(j);
  }
  const verbe = o.dryRun ? 'à purger' : 'purgé';
  let echecs = 0;
  for (const c of candidats) {
    const fin = new Date(finDuRun(c.e)).toISOString().slice(0, 10), quoi = c.e.clos ? `clos le ${fin}` : `intégré le ${fin}`;
    o.out(`${verbe} ${c.e.id} (${quoi}) : ${c.fichiers.map((f) => basename(f)).join(', ')}`);
    if (o.dryRun) continue;
    for (const f of c.fichiers.filter((x) => x !== c.e.fichier)) {
      try { if (f === `${c.e.worktree}.reglages`) oublierReglages(c.e.worktree); else rmSync(f, { recursive: true, force: true }); }
      catch (x) { echecs++; o.out(`  non retiré : ${f} (${(x as Error).message})`); }
    }
    rmSync(c.e.fichier, { force: true }); // l'état en dernier : un échec au milieu laisse le run listé, et une nouvelle purge reprend
  }
  const n = candidats.length;
  o.out(n ? `${n} run${n > 1 ? 's' : ''} ${o.dryRun ? 'à purger' : `purgé${n > 1 ? 's' : ''}`} (fini${n > 1 ? 's' : ''} depuis plus de ${jours} j, run.purgeAfterDays)`
    + `${o.dryRun ? ' ; pour retirer : cadence run --purger' : ''}` : `aucun run à purger (fini depuis plus de ${jours} j, run.purgeAfterDays)`);
  return echecs ? 1 : 0;
}
