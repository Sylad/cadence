// cadence run : une demande, une session (Opus par défaut, L699 : --modele), de bout en bout (plan n°6, 09-11).
// Le produit joue EXACTEMENT un bras mesuré au banc, choisi par l'aiguillage (aiguillage.ts) : brief v2d + hook « lecture obligatoire »
// quand la demande a des références à lire, brief de Claude seul sinon ; mêmes interdictions. Puis : rebase sur la branche de départ, porte complète UNE fois
// (une reprise de la même session si elle est rouge), intégration en avance rapide ; si la cible a avancé entre-temps, rebase et porte rejoués (L723).
// Le plan (raf) et deliver restent ceux de la v1.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { argsClaude, creerExecuteur, libererReglages, lire, OUTILS_INTERDITS, type Executeur } from '../bench/bras.js';
import { ajouterSession, claudeVide } from '../bench/environnement.js';
import { aiguiller, BRAS_COMPLET, BRAS_LEGER, chemin, modeleRun, referencesDuDepot } from './aiguillage.js';
import { lignePasses, modeleDeDepart, modeleDit, numeroCorrection, PASSE_FABLE, revueDuPlan, runsDuLot, type Passe, type Revue } from './escalade.js';
import { heureLocale, reconnaitreQuota, type Quota } from './quota.js';
import { causeSession } from '../trace.js';
import { arreterGroupe, dansGroupe, dormir, type AvecGroupe } from '../processus.js';
import { CONSIGNE_FINI, garderRapport, origineRapport, type EtatRapport } from '../rapport.js';
import { cheminWorktree, HOOKS, reglagesRun } from '../socle.js';
import { briefRegistre, entreeCommitee, preparerRegistre, registreOuvert, registreTouche } from '../registre.js';
import { fichiersNonCommites, nommerFichiers, PLAN_EN_ATTENTE } from '../../../scripts/arbre-non-commite.mjs'; // L722 : même lecture que src/repo-held.ts
import { environnementPerime, ignorerPerime, lignesPerime } from '../../../scripts/environnement-porte.mjs'; // L764 : même lecture que src/verify-gate.ts
import { commandesDeRegeneration, regenerer, retirerRegenerations, TRAILER_REGENERATION } from './regenerer.js';
import { avecRefusCadence, commandesNommees, interditsDuRun, leverPourCadence } from '../../../scripts/commandes-du-brief.mjs'; // L792, L840 : commandes cadence permises
import { jouerPorte, ligneTestsTouches, quelleSuite } from './porte-run.js'; // L786, L838 : la porte jouée, son verdict et sa mesure
import { lireEtapes } from '../../../scripts/etapes-porte.mjs'; // L786 (revue r1, M1) : mêmes étapes que verify --gate
import { etapeAnalyse } from '../../../scripts/analyse.mjs'; // L801 : l'étape analyse de la porte, cliquet par outil
import { avecMesure, lignesSensibles, type Sensible } from './rejeu.js'; // L842 : rouges rejoués seuls avant correction, commits des corrections
import { etapeTests, lirePorteRapide as lireTestsTouches, type PorteRapide } from '../../../scripts/porte-rapide.mjs'; // L838 : run.fastGate, les tests touchés seulement
import { consigneNouveautes, entreesQuiCitent, ligneNouveautes, lotVisible } from '../../../scripts/nouveautes-du-run.mjs'; // L794 : entrée Nouveautés d'un lot visible
import { debutProcessus, inscrireCreneau, occupantVivant, prendreVerrou, rendreVerrou, roleVerrou } from '../verrou.js';

/** D-15 : le run reprend une minute après l'heure de remise à zéro annoncée, relit son état au plus tard toutes les 10 min (une reprise par --reponse arrête
 * l'attente), et ne reprend pas plus de 5 fois de suite sur un quota (une heure de remise à zéro qui ne remet rien à zéro ne boucle pas). */
const MARGE_REPRISE_MS = 60_000, TRANCHE_ATTENTE_MS = 10 * 60_000, REPRISES_QUOTA_MAX = 5;
const REPRISE_QUOTA = `Le quota est revenu : reprends le travail là où tu t'étais arrêté, dans le même dossier, ${CONSIGNE_FINI}.`;
const BASCULE_FABLE = `La limite Opus est atteinte : tu continues sur Fable. Reprends le travail là où tu t'étais arrêté, dans le même dossier, ${CONSIGNE_FINI}.`;

/** L723 : un conflit au rebase sur la cible, rendu à la session ; `resolu` absent tant qu'elle y travaille (reprise après quota, signal, question), faux si elle
 * ne l'a pas résolu, `message` : son dernier mot. */
export interface Conflit { cible: string; sur: string; fichiers: string[]; resolu?: boolean; message?: string }
/** L724 : une porte rouge rendue à la session pour correction ; `rouge` : la sortie de la porte, `message` : le dernier mot de la session,
 * `verte` : la porte rejouée après la correction, absente tant qu'elle n'a pas été rejouée. L842 : `commits` et `fichiers`, ce que ses sessions ont commité
 * (la mesure des passes « porte rouge » sans commit de code, scripts/passes-porte-rouge.mjs). */
export interface Correction { rouge: string; message?: string; verte?: boolean; commits?: number; fichiers?: string[] }
export type EtatRun = 'en-cours' | 'interrompu' | 'attente' | 'quota' | 'sans-commit' | 'echec' | 'conflit' | 'porte-rouge' | 'environnement-perime' | 'sans-porte' | 'refus-integration' | 'integre';
/** `rapport`, `rapport_tour`, `rapport_sans_marqueur`, `messages` : ../rapport.ts (EtatRapport, issues #57 et #58). */
export interface Etat extends EtatRapport, AvecGroupe { id: string; repo: string; branche: string; cible: string; base: string; worktree: string; fichier: string; demande: string;
  pieces: string[]; taille: string; mode: 'complet' | 'leger'; modele?: string; acces_cluster: boolean; registre?: string; lot?: string; session: string; cout_usd: number;
  etat: EtatRun; detail: string; debut: string; integre?: string; quota?: Quota; journal?: string; conflits?: Conflit[]; corrections?: Correction[];
  /** L726 (escalade.ts) : pourquoi `modele` ; le run est une correction après revue (un run du lot déjà intégré) ; passes de correction du lot avant ce run ;
   * revue non conforme du plan au lancement ; chaque session jouée, son modèle et pourquoi. */
  modele_raison?: string; correction_revue?: boolean; corrections_avant?: number; revue?: Revue; passes?: Passe[];
  /** L745 (clore.ts) : la tête du worktree à la fin d'un run non intégré (archivée par --clore, lue par --liste quand la branche est retirée) ; `clos` : posé par
   * --clore, avec ses archives et ce qui est resté (worktree non propre, branche) ; `force` : un état clos avant la 5e passe, sans preuve d'intégration. */
  tete?: string; /** Revue L764 r1 (M3) : la porte lue au commit du run quand elle diffère de celle de la cible, reprise au détail de l'état integre. */
  porte_changee?: string; /** Revue L801 r3 (M2) : ce que l'analyse d'une porte verte dit à relire (ligne de base neuve, config changée par déclaration). */
  analyse_dite?: string[]; /** L842 : les tests sensibles à la charge de chaque porte jouée (rouges dans la suite, verts rejoués seuls, ./rejeu.ts). */
  sensibles_charge?: Sensible[];
  /** L838 : la porte rapide (run.fastGate) a joué les tests touchés seulement, la ligne qui le dit ; `portes` : chaque porte jouée, sa portée, son issue et sa durée. */
  porte_rapide?: string; portes?: { ciblee: boolean; ok: boolean; duree_s: number }[];
  /** L792 : le brief nomme `cadence spec check` (scripts/commandes-du-brief.mjs) ; la session peut la lancer, reprises comprises. */
  spec_check?: boolean;
  /** L794 : le lot du plan est visible (scripts/nouveautes-du-run.mjs) ; `nouveautes` : à la fin, les entrées du commit du run qui le citent (null : git illisible). */
  lot_visible?: boolean; nouveautes?: { entrees: string[] | null; manquante: boolean };
  /** L796 : la cible a avancé pendant la porte par des commits sur des fichiers que le run ne touche pas : rebasé sur `sur` ; `porte` a jugé le run avant ;
   * `plan_seul` : les commits arrivés ne touchent que le plan ou le registre, la porte n'est pas rejouée ; sinon elle l'est sur le sha rebasé (revue r1, M1). */
  cible_avancee?: { sur: string; commits: number; fichiers: string[]; porte: string; plan_seul?: boolean }[];
  clos?: { date: string; cible: string; tete: string; integre?: boolean; archives?: string[]; restes?: string[]; force?: true } }
/** `maintenant` et `attendre` : l'horloge et l'attente du quota (D-15), simulées par les tests ; `attendre: null` rend la main sans attendre la remise à zéro. */
interface Opts { exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string; maintenant?: () => Date; attendre?: ((ms: number) => void) | null }

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const essaiGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }), dossierRuns = (repo: string) => join(dirname(repo), '.cadence-run');
/** Le fichier d'état du run `id` du dépôt qui contient `repo` (--reponse, --clore). */
export const fichierRun = (repo: string, id: string) => { const racine = git(repo, 'rev-parse', '--show-toplevel'); return join(dossierRuns(racine), `${basename(racine)}-${id}.json`); };
// Écriture atomique (fichier temporaire puis rename) : writeFileSync vide le fichier avant de l'écrire, et un lecteur concurrent (cadence run --liste, un
// autre run du dépôt, le test L773 de deux runs --fond) lisait alors un JSON vide (« Unexpected end of JSON input »). Le temporaire, nommé `<nom>.json.<pid>.tmp`,
// n'est pas lu comme un état (filtre `.json`) et part avec le run à la purge (annexes de purger.ts).
export const sauver = (e: Etat) => { const t = `${e.fichier}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(e, null, 1)); renameSync(t, e.fichier); return e; }; const lireEtat = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Etat;

// L695 (D-9) : le run tient la branche cible du début à la fin ; le pre-commit de raf (raf hook install) y refuse un commit du lead sur un fichier que le
// run touche (L796 : `worktree` dit où les lire ; un commit disjoint passe, le run se rebase dessus à l'intégration), et raf add|note|done|review|ux|demande écrivent dans le plan en attente (L722). Même format que src/repo-held.ts, qui le lit.
const RAF = fileURLToPath(new URL('../../../bin/raf.js', import.meta.url));
const fichierTenu = (repo: string) => join(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')), 'cadence', 'tenu', `run-${process.pid}.json`);
// Revue L695 r1 (D-10) : `start` écrit, un fichier laissé par un run tué (Ctrl-C, SIGKILL, PC éteint) ne tient plus la branche quand son pid est repris.
function tenir(e: Etat): void {
  const f = fichierTenu(e.repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ pid: process.pid, start: debutProcessus(process.pid), kind: 'run', label: `cadence run ${e.id}`, branch: e.cible, since: new Date().toISOString(), worktree: e.worktree }));
}
/**
 * Joue le run en tenant la branche : une exception (un git qui échoue, l'exécuteur qui lève) finit le run en échec et rend le dépôt comme les autres fins.
 * Un run tué par un signal ne passe pas ici : son fichier reste, mais un porteur mort (pid absent ou repris, `start` à l'appui) ne tient rien.
 */
function tenu(e: Etat, o: Opts, corps: () => Etat): Etat {
  tenir(e); const retirer = inscrireCreneau(e); // L710 : le run vivant prend un créneau de sessions (../verrou.ts)
  try {
    return dansGroupe(e, o.out, corps); // L837 : ce qu'un run tué a laissé est arrêté ; tout ce que le run lance porte sa marque, fin() l'arrête
  } catch (x) {
    e.etat = 'echec'; e.detail = `erreur pendant le run : ${(x as Error).message ?? x}`;
    return fin(e, o);
  } finally {
    rmSync(fichierTenu(e.repo), { force: true }); retirer();
  }
}
// D-18 : un seul processus joue ou attend un run ; verrou `<run>.verrou` (../verrou.ts), lu aussi par src/quota-tour.ts (mort : l'attente est arrêtée).
export const fichierVerrou = (fichier: string) => fichier.replace(/\.json$/, '.verrou');
export const occupantRun = (fichier: string) => occupantVivant(fichierVerrou(fichier));
export const etatVu = (e: Etat): EtatRun => (e.etat === 'en-cours' && !occupantRun(e.fichier) ? 'interrompu' : e.etat); // L709 : processus mort (lanceur fermé, kill, PC éteint) ; sur disque, en-cours
function verrouiller(e: Etat): void {
  const p = prendreVerrou(fichierVerrou(e.fichier), 'session'), quand = e.quota?.reprise ? ` après ${heureLocale(e.quota.reprise)}` : '';
  if (p) throw new Error(p.role === 'attente' ? `cadence run : le processus ${p.pid} attend la remise à zéro du quota de ${e.id} et reprendra seul la session${quand} ; `
    + `pour reprendre maintenant : kill ${p.pid}, puis relance cette commande` : `cadence run : une session de ce run tourne déjà (processus ${p.pid}) : attends sa fin`);
}

/** Rend la branche, puis fait appliquer par raf le plan mis en attente pendant le run (raf refuse si un autre programme la tient encore). */
function rendre(e: Etat, o: Opts): void {
  rmSync(fichierTenu(e.repo), { force: true });
  if (!existsSync(join(e.repo, PLAN_EN_ATTENTE))) return;
  const r = spawnSync(process.execPath, [o.raf ?? RAF, 'attente', 'appliquer'], { cwd: e.repo, encoding: 'utf8' }), sortie = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  o.out(r.status === 0 ? sortie : `plan en attente non appliqué (${sortie || r.error?.message || `code ${r.status}`}) : raf attente appliquer à la main`);
}

/** Dépendances non suivies (node_modules, .venv) liées en dur dans le worktree : rapide, et les outils les voient chez eux. */
function copierDeps(repo: string, wt: string): void {
  const r = spawnSync('find', [repo, '-maxdepth', '4', '(', '-name', '.git', '-o', '-name', '.cadence-run', ')', '-prune', '-o', '(', '-name', 'node_modules', '-o', '-name', '.venv', ')', '-type', 'd', '-prune', '-print'], { encoding: 'utf8' });
  for (const d of r.stdout.split('\n').filter(Boolean)) {
    const cible = join(wt, d.slice(repo.length + 1));
    if (existsSync(cible)) continue;
    mkdirSync(dirname(cible), { recursive: true });
    if (spawnSync('cp', ['-al', d, cible]).status !== 0) spawnSync('cp', ['-a', d, cible]);
  }
}

const cadenceYaml = (repo: string) => (existsSync(join(repo, 'cadence.yaml')) ? parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) as { orchestrate?: object; analyse?: unknown; run?: unknown } | null : null);
const orchestrate = (repo: string): { prodAccess?: boolean } => cadenceYaml(repo)?.orchestrate ?? {};
/** L786 (revue r1, M1) : les étapes de verify --gate (scripts/etapes-porte.mjs : build puis test, en chaîne ou en parties) ; `refus` : cadence.yaml que
 * verify --gate refuserait, rien n'est joué ni noté. L801 : l'analyse (clé analyse:, scripts/analyse.mjs) après le build, avant les tests, contre `cible`. */
function etapesDeCadenceYaml(repo: string, cible = 'main'): { commandes: string[]; tests: string[]; rapide?: PorteRapide | null; refus?: string } {
  const p = lireEtapes(orchestrate(repo)), a = etapeAnalyse(cadenceYaml(repo)?.analyse, cible);
  let rapide: PorteRapide | null = null, r: string | undefined; // L838 : run.fastGate mal formé, rien n'est joué (comme une porte que verify --gate refuserait)
  try { rapide = lireTestsTouches(cadenceYaml(repo)?.run, orchestrate(repo), 'cadence.yaml'); } catch (x) { r = (x as Error).message; }
  if (p.refus !== undefined || a.refus !== undefined || r !== undefined) return { commandes: [], tests: [], refus: p.refus !== undefined ? `orchestrate.${p.refus}` : a.refus ?? r };
  const [build, ...reste] = p.etapes, avant = build?.nom === 'build' ? build.commandes : [], tests = (avant.length ? reste : p.etapes).flatMap((x) => x.commandes);
  return { commandes: [...avant, ...a.commandes, ...tests], tests, rapide };
}
const commandesDeCadenceYaml = (repo: string, cible?: string): string[] => etapesDeCadenceYaml(repo, cible).commandes;
/** L764 : la porte d'un run est lue dans cadence.yaml AU COMMIT DU RUN (le worktree, rebasé sur la cible) : un run qui corrige sa propre commande de porte est
 * jugé par elle. Quand elle diffère de celle de l'arbre principal, la sortie le dit (une porte affaiblie par le run se voit dans le journal et à la revue). */
function commandesDuRun(e: Etat, out: (l: string) => void): string[] {
  const cmds = commandesDeCadenceYaml(e.worktree, e.cible), principal = commandesDeCadenceYaml(e.repo, e.cible);
  const dit = cmds.join('\n') === principal.join('\n') ? undefined
    : `porte lue au commit du run (cadence.yaml changé par le run) : ${cmds.join(' puis ') || 'aucune commande'} — l'arbre principal (${e.cible}) aurait joué : ${principal.join(' puis ') || 'aucune commande'}`;
  // Revue L764 r1 : dite une fois par changement (m1, pas à chaque essai ni rebase), gardée pour le détail de l'état integre (M3, comme un conflit résolu, L723).
  if (dit && dit !== e.porte_changee) out(dit);
  e.porte_changee = dit;
  // L838 : avec run.fastGate, l'étape des tests ne joue que les tests touchés depuis le départ du lot sur la cible (scripts/porte-rapide.mjs, repli sûr sur la suite)
  const { tests, rapide } = etapesDeCadenceYaml(e.worktree, e.cible), depart = essaiGit(e.worktree, 'merge-base', 'HEAD', e.cible).stdout.trim();
  const t = etapeTests(e.worktree, depart, rapide ?? null, cadenceYaml(e.worktree), tests);
  if (t.ligne) out(t.ligne);
  e.porte_rapide = t.ciblee ? t.ligne : undefined;
  return [...cmds.slice(0, cmds.length - tests.length), ...t.commandes];
}
/** L764 : l'environnement du worktree avant la porte (node_modules en retard sur package-lock.json, Node du PATH hors de .nvmrc ou engines.node) ; la sortie
 * à rendre quand il est périmé, null sinon (ou CADENCE_PORTE_ENV=jouer, dit dans le journal). */
function perime(e: Etat, out: (l: string) => void): string | null {
  const p = environnementPerime(e.worktree, process.env);
  if (!p.length) return null;
  const lignes = lignesPerime('porte du run', p);
  if (ignorerPerime(process.env)) { out(['porte du run : environnement périmé, porte jouée quand même (CADENCE_PORTE_ENV=jouer) — un rouge peut venir de lui :', ...lignes.slice(1, -1)].join('\n')); return null; }
  return [...lignes, `  après la remise à niveau : cadence run --reponse ${e.id} "environnement remis à niveau" (la session reprend, puis la porte est rejouée)`].join('\n');
}
// L709 (issue #55) : rien de ce qui lie un processus à la session Claude Code lanceuse (pid, socket, auth rafraîchie par l'hôte) ; `neuve` : 1re session, id de l'état.
const LIEN_HOTE = /^CLAUDE_(PID|SSH_\w+|CODE_(CHILD_SESSION|MESSAGING_\w+|SDK_HAS_HOST_AUTH_REFRESH|HOST_SESSION_ID|SESSION_ID))$/;
/** `sujet` : une session qui ne fait pas le travail demandé (L723 : la résolution d'un conflit) ; ses messages ne remplacent pas le rapport du travail. */
function session(e: Etat, prompt: string, o: Opts, neuve = false, sujet?: string): boolean {
  if (!neuve) retirerRegenerations(e.worktree, e.id, e.base); // L781 (revue r1, M2) : la session ne travaille jamais par-dessus la régénération (rien pendant un rebase en cours)
  const exec = o.exec ?? creerExecuteur('claude', 4 * 3600_000);
  // L699 : le modèle est celui du lancement, gardé dans l'état (une reprise par --reponse ne le change pas) ; un état d'avant L699 n'en a pas : opus.
  // orchestrate.prodAccess (comme les vagues de la v1) : sans lui, ni kubectl, ni helm, ni KUBECONFIG ; avec lui, la session joue le banc du projet ; L808 (revue r1) : jamais la garde de lecture d'un bras de banc (CADENCE_LECTURE_BORNEE, _ZONES), un run lit ses pièces hors du worktree
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LIEN_HOTE.test(k) && !/^CADENCE_(RUN_JOURNAL|RUN_ID|LECTURE_BORNEE|LECTURE_ZONES)$/.test(k))), CADENCE_CLONE: e.worktree, CADENCE_PIECES: JSON.stringify(e.pieces), CADENCE_BANC_RACINE: dossierRuns(e.repo), ...(e.acces_cluster ? {} : { KUBECONFIG: '/dev/null' }) };
  const coupes = e.acces_cluster ? OUTILS_INTERDITS.filter((x) => !/kubectl|helm/.test(x)) : OUTILS_INTERDITS;
  const interdits = interditsDuRun(coupes, { specCheck: e.spec_check }); // L840 : cadence analyse permise ; L792 : cadence spec check aussi quand le brief la nomme
  e.passes = [...(e.passes ?? []), { quoi: quoiPasse(e, neuve, sujet), modele: e.modele ?? 'opus', raison: e.modele_raison ?? (e.modele ? 'choisi au lancement' : 'par défaut') }]; // L726
  sauver(e);
  const bras = { ...(e.mode === 'leger' ? BRAS_LEGER : BRAS_COMPLET), modele: e.modele ?? 'opus' }; // L763 : ses hooks s'ajoutent à ceux du socle
  const socle = reglagesRun(e.worktree, process.env, bras.settings);
  const reglages = avecRefusCadence(socle, HOOKS, { specCheck: e.spec_check }); // L840, L792 (revue r1, M1) : tout cadence ou raf hors analyse bornée et spec check|qa refusé par hook
  // L705 : coupes du socle (../socle.ts) ; L842 : ce que commite une session de correction s'ajoute à sa correction (avecMesure)
  const brut = avecMesure(e.corrections, e.worktree, sujet === SUJET_CORRECTION,
    () => exec(['-p', prompt, ...(neuve ? ['--session-id', e.session] : e.session ? ['--resume', e.session] : []), ...argsClaude(bras, e.worktree, interdits, reglages)], { cwd: e.worktree, env }));
  const id = ajouterSession(claudeVide(), brut.stdout).modeles.join(', '); // L756 (issue #61) : l'id exact de la session, pas l'alias passé à --model
  if (id) e.passes.at(-1)!.id_modele = id;
  const r = lire(brut), cause = causeSession(brut); if (cause) o.out(cause); // L711 : une session arrêtée par un signal le dit dans le journal, avant la suite habituelle
  e.session = r.session || e.session; e.cout_usd += r.cout;
  // D-15 : une fin de quota n'est pas un échec. La limite Opus seule bascule sur fable dans la même session ; la limite hebdo bloque tous les modèles : on attend.
  const q = reconnaitreQuota(r.resultat || brut.stdout, (o.maintenant ?? (() => new Date()))());
  // Issue #57 : chaque message de la session va au journal et à l'état quelle que soit sa fin (travail fini, échec, délai, signal, quota) : c'est là que le
  // lead lit ce qui a été fait et ce qui reste. Le rapport est le dernier message marqué « === FINI === » (../rapport.ts, L728 : consigne du brief), fixé seulement
  // si le travail a fini ; ce qui vient après lui va au journal sans le remplacer. Sans marqueur, le dernier message, et l'état le dit (à vérifier au journal).
  garderRapport(e, r.messages, o.out, !q && !r.echec, sujet);
  // L724 : le dernier mot d'une session à sujet va à ce qu'elle traite (le conflit, la correction), à chaque passage : reprise après quota et bascule comprises
  const mot = r.messages.filter((m) => !m.apres).at(-1)?.texte;
  const vise = sujet === SUJET_CONFLIT ? e.conflits?.at(-1) : sujet === SUJET_CORRECTION ? e.corrections?.at(-1) : undefined;
  if (mot && vise) vise.message = mot;
  if (q?.limite === 'opus' && (e.modele ?? 'opus') === 'opus') {
    o.out('limite Opus atteinte : bascule sur fable, même session');
    e.modele = 'fable';
    e.modele_raison = 'limite Opus atteinte';
    sauver(e);
    return session(e, e.session ? BASCULE_FABLE : prompt, o, false, sujet);
  }
  if (q) {
    e.etat = 'quota'; e.quota = q;
    e.detail = `limite ${q.limite === 'hebdo' ? 'hebdo' : 'Opus'} atteinte ; ${q.reprise ? `reprise seule après ${heureLocale(q.reprise)}` : 'heure de reprise illisible, pas de reprise seule'}`
      + ` (« ${q.texte.split('\n')[0]} ») ; pour reprendre avant : cadence run --reponse ${e.id} "reprends" (refusé tant qu'un processus attend : cadence run --liste donne son pid)`;
    return false;
  }
  if (r.echec) { e.etat = 'echec'; e.detail = r.echec; return false; }
  sauver(e);
  return true;
}

/** La session a posé une question (fichier `<worktree>.question.md`) : le run attend la réponse de l'humain. */
function question(e: Etat, o: Opts): Etat | null {
  const q = `${e.worktree}.question.md`;
  if (!existsSync(q)) return null;
  e.etat = 'attente'; e.detail = readFileSync(q, 'utf8'); rmSync(q); o.out(`question (réponds : cadence run --reponse ${e.id} "…") :\n${e.detail}`); return fin(e, o);
}

// L723 : la branche cible avance pendant la porte quand un autre run s'intègre (vécu 2 fois le 13-11, 15 à 35 min de run rendues à la main) : le run se
// rebase, rejoue la porte et retente l'avance rapide, 3 fois au plus ; un conflit de rebase est rendu à la même session, le lead ne reçoit que ce qu'elle n'a pas su résoudre.
const REBASES_MAX = 3;
const rebaseEnCours = (wt: string) => ['rebase-merge', 'rebase-apply'].some((d) => existsSync(resolve(wt, git(wt, 'rev-parse', '--git-path', d))));
const fichiersGit = (cwd: string, ...a: string[]) => essaiGit(cwd, ...a, '-z').stdout.split('\0').filter(Boolean);
const consigneConflit = (e: Etat, fichiers: string[]) => `Le rebase de ta branche sur ${e.cible}, qui a avancé pendant ton travail, est en conflit sur : ${fichiers.join(', ')}.\n`
  + `Le rebase est en cours dans ${e.worktree}. Résous chaque conflit en gardant les deux intentions (le travail de ${e.cible} et le tien), git add, puis `
  + `\`GIT_EDITOR=true git rebase --continue\`, jusqu'à la fin du rebase, sans --skip ni --abort. Ne commite rien d'autre, ${CONSIGNE_FINI}.`;

const SUJET_CONFLIT = 'résolution du conflit au rebase';
// L724 : même modèle pour la correction après porte rouge : son « fini » ne remplace pas le rapport du travail ; la porte rouge, ce que la session en
// dit et la porte rejouée ensuite sont AJOUTÉS à l'état (`corrections`) et au journal.
const SUJET_CORRECTION = 'correction après porte rouge';
/** Ouvre une correction ; une correction encore en attente de sa porte (reprise par --reponse) a été suivie d'une porte rouge : elle n'a pas rendu la porte verte.
 * L726 : à la 3e passe de correction du lot (celles des runs précédents du lot comprises), la session passe sur fable, la même session. */
function ouvrirCorrection(e: Etat, rouge: string, out: (l: string) => void): void {
  const c = e.corrections?.at(-1);
  if (c && c.verte === undefined) c.verte = false;
  e.corrections = [...(e.corrections ?? []), { rouge }];
  const n = numeroCorrection(e);
  if (n >= PASSE_FABLE && e.modele !== 'fable') {
    e.modele = 'fable';
    e.modele_raison = `${n}e passe de correction${e.lot ? ` du lot ${e.lot}` : ''}`;
    out(`${e.modele_raison} : bascule sur fable, même session`);
  }
  sauver(e);
}
/** L726 : ce que fait une session, pour la ligne des modèles du rapport. */
function quoiPasse(e: Etat, neuve: boolean, sujet?: string): string {
  if (sujet === SUJET_CORRECTION) return `correction ${numeroCorrection(e)} (porte rouge)`;
  if (sujet === SUJET_CONFLIT) return 'résolution du conflit au rebase';
  if (neuve) return e.correction_revue ? `correction ${(e.corrections_avant ?? 0) + 1} (après revue)` : 'travail';
  return 'reprise';
}
/** Une session reprise (--reponse, quota) pendant une résolution de conflit ou une correction la continue : même sujet, le rapport du travail reste. */
const sujetEnCours = (e: Etat) => (e.conflits?.length && e.conflits.at(-1)?.resolu === undefined ? SUJET_CONFLIT
  : e.corrections?.length && e.corrections.at(-1)?.verte === undefined ? SUJET_CORRECTION : undefined);
/** L781 : les commandes de run.regenerate (cadence.yaml) jouées avant la porte et commitées en un commit du lot (./regenerer.ts). */
function regenererRun(e: Etat, out: (l: string) => void): { ok: boolean; sortie: string } | null {
  const g = regenerer(e.worktree, e.id, e.lot);
  if (g?.commit) out(`fichiers générés régénérés avant la porte (run.regenerate, L781) : commit ${g.commit} (${nommerFichiers(g.fichiers ?? [])})`);
  return g;
}
/** Les commits de régénération du run arrivés sur la cible (relus à l'intégration : un commit retiré avant un rebase n'y est plus). */
const regenerations = (e: Etat) => essaiGit(e.worktree, 'log', `--format=%h%x09%(trailers:key=${TRAILER_REGENERATION},valueonly)`, `${e.base}..HEAD`).stdout
  .split('\n').map((l) => l.split('\t')).filter(([, v]) => v?.trim() === e.id).map(([h]) => h);
const enBref = (sortie: string) => { const l = sortie.split('\n').map((x) => x.trim()).filter(Boolean); return l.length > 1 ? `${l[0]} … ${l.at(-1)}` : l[0] ?? ''; };
const correctionFaite = (c: Correction) => `porte rouge (${enBref(c.rouge)}) corrigée par la session, porte verte ensuite${c.message ? ` ; la session : ${c.message}` : ''}`;
const conflitResolu = (e: Etat, c: Conflit) => `conflit au rebase sur ${e.cible} (${c.sur.slice(0, 7)}) résolu par la session, fichiers : ${c.fichiers.join(', ')}`
  + `${c.message ? ` ; la session : ${c.message}` : ''}`;

/**
 * Rebase le worktree sur `cible` ; en conflit, la même session le résout. Rend l'état de fin si le run s'arrête, null pour continuer.
 * Le conflit est AJOUTÉ à l'état (`conflits`) et au journal, résolu ou non ; le rapport du travail reste celui du travail (sujet de la session, ../rapport.ts).
 */
function rebaser(e: Etat, o: Opts, cible: string): Etat | null {
  if (rebaseEnCours(e.worktree)) essaiGit(e.worktree, 'rebase', '--abort'); // une résolution coupée (quota, signal) repart de zéro
  const coupe = e.conflits?.at(-1);
  if (coupe && coupe.resolu === undefined) coupe.resolu = false; // L724 : le conflit de la résolution coupée n'est pas résolu ; le rebase rejoué ouvre le sien
  retirerRegenerations(e.worktree, e.id, e.base); // L781 : rejouée après le rebase, sur la cible à jour (sans conflit sur un fichier généré)
  if (essaiGit(e.worktree, 'rebase', '-q', cible).status === 0) return null;
  const fichiers = fichiersGit(e.worktree, 'diff', '--name-only', '--diff-filter=U');
  const c: Conflit = { cible: e.cible, sur: cible, fichiers };
  e.conflits = [...(e.conflits ?? []), c]; sauver(e);
  o.out(`conflit au rebase sur ${e.cible} (${fichiers.join(', ')}) : reprise de la session pour le résoudre`);
  const repondu = session(e, consigneConflit(e, fichiers), o, false, SUJET_CONFLIT), enCours = rebaseEnCours(e.worktree);
  if (enCours) essaiGit(e.worktree, 'rebase', '--abort');
  if (!repondu) return fin(e, o);
  const q = question(e, o);
  if (q) return q;
  if (enCours || essaiGit(e.worktree, 'merge-base', '--is-ancestor', cible, 'HEAD').status !== 0) {
    c.resolu = false;
    e.etat = 'conflit'; e.detail = `conflit au rebase sur ${e.cible} (fichiers : ${fichiers.join(', ')}) : la session ne l'a pas résolu, rebase annulé`; return fin(e, o);
  }
  c.resolu = true; sauver(e);
  o.out(conflitResolu(e, c));
  return null;
}

/** Avance rapide de la cible sur la branche du run : null si faite, sinon la raison, et si la cible a bougé depuis `cible` (un rebase de plus la règle). */
function avancer(e: Etat, br: string, cible: string): { avance: boolean; raison: string } | null {
  if (git(e.repo, 'rev-parse', e.cible) !== cible) return { avance: true, raison: `${e.cible} a avancé pendant la porte` };
  const actuelle = essaiGit(e.repo, 'symbolic-ref', '-q', '--short', 'HEAD').stdout.trim();
  if (actuelle === e.cible) {
    // L723 : git refuse (« Your local changes would be overwritten ») quand l'arbre principal a des changements non commités sur un fichier que le run modifie.
    // fichiersNonCommites (L722) dit un dossier non suivi en « dossier/ » : seul un fichier que le run crée et qui y existe déjà fait refuser git.
    const locales = fichiersNonCommites(e.repo) ?? [], dossiers = locales.filter((f) => f.endsWith('/'));
    const sales = fichiersGit(e.repo, 'diff', '--name-only', cible, br).filter((t) => locales.includes(t) || (dossiers.some((d) => t.startsWith(d)) && existsSync(join(e.repo, t))));
    if (sales.length) return { avance: false, raison: `modifications non commitées dans l'arbre principal (${e.repo}) sur des fichiers que le run modifie aussi : ${nommerFichiers(sales)}. `
      + `Commite-les ou mets-les de côté, puis : cadence run --reponse ${e.id} "intègre"` };
  }
  const m = actuelle === e.cible ? essaiGit(e.repo, 'merge', '-q', '--ff-only', br) : essaiGit(e.repo, 'fetch', '-q', '.', `${br}:${e.cible}`);
  return m.status === 0 ? null : { avance: git(e.repo, 'rev-parse', e.cible) !== cible, raison: `${m.stderr}`.trim() || 'avance rapide impossible' };
}

/** Revue r1 (M1) : « disjoint » ne compare que des chemins ; un test, un module importé, package.json ou v2/budget.json arrivés changent ce que la porte juge.
 * Seuls le plan et le registre des demandes, que la porte ne lit jamais, laissent intégrer sans la rejouer. */
const dePlan = (f: string) => f === '.cadence/raf.yaml' || f.startsWith('docs/plan/') || f.startsWith('.cadence/demandes/');
/** L796 (issue #70) : la cible est passée de `cible` (vue par la porte) à `nouvelle` par des commits disjoints des fichiers du run, sans cadence.yaml (la porte) :
 * rebase sans conflit possible. Un run à commits de régénération (L781) garde le chemin de L723 (ses fichiers générés peuvent en dépendre). */
function rebaserDisjoint(e: Etat, cible: string, nouvelle: string): NonNullable<Etat['cible_avancee']>[number] | null {
  if (regenerations(e).length) return null;
  const run = new Set(fichiersGit(e.worktree, 'diff', '--name-only', '--no-renames', cible, 'HEAD'));
  const leurs = fichiersGit(e.repo, 'diff', '--name-only', '--no-renames', cible, nouvelle);
  if (leurs.includes('cadence.yaml') || leurs.some((f) => run.has(f))) return null;
  const porte = git(e.worktree, 'rev-parse', '--short', 'HEAD');
  if (essaiGit(e.worktree, 'rebase', '-q', nouvelle).status !== 0) { if (rebaseEnCours(e.worktree)) essaiGit(e.worktree, 'rebase', '--abort'); return null; }
  return { sur: nouvelle, commits: Number(git(e.repo, 'rev-list', '--count', `${cible}..${nouvelle}`)), fichiers: leurs, porte, plan_seul: leurs.every(dePlan) };
}
const cibleAvancee = (e: Etat, a: NonNullable<Etat['cible_avancee']>[number]) => `${e.cible} a avancé pendant la porte sur des fichiers que le run ne touche pas `
  + `(${a.commits} commit${a.commits > 1 ? 's' : ''}${a.fichiers.length ? ` : ${nommerFichiers(a.fichiers)}` : ''}) : rebasé, `
  + (a.plan_seul ? `intégré sans rejouer la porte, qui a jugé ${a.porte} : ils ne touchent que le plan ou le registre des demandes, que la porte ne lit pas (L796)`
    : `porte rejouée sur le sha rebasé (L796)`);
const DISJOINTS_MAX = 10; // une cible qui avance sans fin finit par le chemin de L723 (refus après 3 rebases)

/** Après chaque passage de session : question, commits, puis rebase, porte et avance rapide, rejoués tant que la cible avance (L723). */
function suite(e: Etat, o: Opts): Etat {
  const q = question(e, o);
  if (q) return q;
  if (git(e.worktree, 'rev-list', '--count', `${e.base}..HEAD`) === '0') { e.etat = 'sans-commit'; e.detail = 'la session n\'a rien commité'; return fin(e, o); }
  const arretSansCommande = () => {
    const refus = etapesDeCadenceYaml(e.worktree).refus; // L786 (revue r1, M1) : une porte que verify --gate refuserait n'est pas jouée à moitié
    e.etat = 'sans-porte';
    e.detail = `${refus ? `cadence.yaml du run : ${refus}` : 'cadence.yaml du run ne déclare ni orchestrate.test, ni orchestrate.build, ni analyse'} : relance avec --sans-porte pour intégrer quand même`;
    return fin(e, o);
  };
  if (!commandesDeCadenceYaml(e.worktree).length && !o.sansPorte) return arretSansCommande();
  const br = git(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
  let disjoints = 0;
  for (let rebase = 1; ;) {
    let cible = git(e.repo, 'rev-parse', e.cible);
    const arret = rebaser(e, o, cible);
    if (arret) return arret;
    // Porte complète : une fois ; rouge, la même session corrige une fois et la porte est rejouée (C3 : un seul site de porte) ; L781 : un échec de run.regenerate a sa propre correction.
    for (let rouges = 0, rougesRegeneration = 0; ;) {
      const cmds = commandesDuRun(e, o.out); // L764 : relue à chaque essai, au commit qui sera intégré (après le rebase, après la correction)
      if (!cmds.length && !o.sansPorte) return arretSansCommande();
      const r = registreTouche(e.worktree, e.registre, cible); // L701 : sans option, rien au registre ; --registre D-n, aucune entrée neuve
      const vieux = r ? null : perime(e, o.out);
      if (vieux) { e.etat = 'environnement-perime'; e.detail = vieux; return fin(e, o); } // L764 : pas de rouge trompeur, pas de correction demandée à la session
      const g = r ? null : regenererRun(e, o.out); // L781 : avant la porte, qui juge le commit intégré, données générées comprises
      const p = r ? { ok: false, sortie: r } : g && !g.ok ? g : jouerPorte(cmds, e, o.out);
      const c = e.corrections?.at(-1), attendue = c?.verte === undefined ? c : undefined;
      if (p.ok) {
        if (attendue) { attendue.verte = true; sauver(e); o.out(correctionFaite(attendue)); }
        break;
      }
      // L781 (revue r1, m3) : un échec de régénération a sa propre correction, il ne prend pas celle de la porte
      if ((g && !g.ok ? rougesRegeneration++ : rouges++) === 1) { if (attendue) attendue.verte = false; e.etat = 'porte-rouge'; e.detail = p.sortie; return fin(e, o); }
      o.out(`porte rouge : reprise de la session pour corriger :\n${p.sortie}`);
      ouvrirCorrection(e, p.sortie, o.out);
      if (!session(e, `La porte ${quelleSuite(e)} est rouge après ton travail :\n${p.sortie}\nCorrige la cause (sans affaiblir aucun test), commite, ${CONSIGNE_FINI}.`, o, false, SUJET_CORRECTION)) return fin(e, o);
    }
    let refus = avancer(e, br, cible), rejouer = false;
    // L796 : la cible a avancé sur des fichiers disjoints : rebase ; plan ou registre seuls, avance rapide sans porte ; sinon porte rejouée sur le sha rebasé,
    // sans compter parmi les rebases de L723 (un commit disjoint ne rend plus le lot, il coûte une porte)
    while (refus?.avance && disjoints < DISJOINTS_MAX) {
      const a = rebaserDisjoint(e, cible, git(e.repo, 'rev-parse', e.cible));
      if (!a) break;
      disjoints++;
      e.cible_avancee = [...(e.cible_avancee ?? []), a]; sauver(e); o.out(cibleAvancee(e, a));
      if (!a.plan_seul) { rejouer = true; break; }
      cible = a.sur; refus = avancer(e, br, cible);
    }
    if (rejouer) continue;
    if (!refus) break;
    if (!refus.avance || rebase === REBASES_MAX) {
      e.etat = 'refus-integration'; e.detail = refus.avance ? `${e.cible} a encore avancé après ${REBASES_MAX} rebases : ${refus.raison}` : refus.raison; return fin(e, o);
    }
    rebase++;
    o.out(`${e.cible} a avancé pendant la porte : rebase et porte rejouée (${rebase}/${REBASES_MAX})`);
  }
  e.integre = git(e.repo, 'rev-parse', '--short', e.cible); e.etat = 'integre';
  const regenere = regenerations(e);
  // L723 : intégré, mais une fusion écrite par la session est à relire ; L724 : de même pour une correction après porte rouge
  e.detail = [...(e.porte_changee ? [`${e.porte_changee} — à relire : la porte qui a jugé le run est la sienne`] : []), ...(e.analyse_dite ?? []).map((l) => `${l} — à relire`), ...ligneTestsTouches(e),
    ...lignesSensibles(e.sensibles_charge), ...(e.cible_avancee ?? []).map((a) => cibleAvancee(e, a)), ...(e.conflits ?? []).filter((c) => c.resolu).map((c) => conflitResolu(e, c)), ...(e.corrections ?? []).filter((c) => c.verte).map(correctionFaite),
    ...(regenere.length ? [`fichiers générés régénérés par le run avant la porte (run.regenerate, L781) : commit ${regenere.join(', ')}`] : [])].join('\n');
  const registre = registreOuvert(e.worktree);
  noterNouveautes(e);
  retirerRun(e);
  return fin(e, o, registre);
}

/** L796 (3, issue #70) : un `raf start` laissé non commité faisait rendre son lot refus-integration (~50 min). Un plan qui ne diffère de HEAD QUE par le statut
 * du lot (et `started`) est commité par le run, hooks compris, au modèle `plan.commit` du projet ; sinon rien, l'avertissement des fichiers non commités reste. */
function commiterStart(repo: string, lot: string, id: string, out: (l: string) => void): void {
  const conf = cadenceYaml(repo) as { plan?: { path?: string; commit?: string } } | null, plan = conf?.plan?.path ?? '.cadence/raf.yaml';
  if (!(fichiersNonCommites(repo) ?? []).includes(plan)) return;
  const tete = essaiGit(repo, 'show', `HEAD:${plan}`);
  let avant: { lots?: Record<string, unknown>[] }, apres: typeof avant;
  try { avant = parse(tete.stdout); apres = parse(readFileSync(join(repo, plan), 'utf8')); } catch { return; }
  const duLot = (p: typeof avant) => (Array.isArray(p?.lots) ? p.lots.find((l) => l?.id === lot) : undefined), l0 = duLot(avant), l1 = duLot(apres);
  if (tete.status !== 0 || !l0 || !l1 || l0.status === l1.status) return;
  l1.status = l0.status;
  if ('started' in l0) l1.started = l0.started; else delete l1.started;
  if (JSON.stringify(avant) !== JSON.stringify(apres)) return;
  const titre = (conf?.plan?.commit ?? 'plan: {lot} {action}').replaceAll('{lot}', lot).replaceAll('{action}', 'démarré').replaceAll('{vague}', `run ${id}`);
  const r = essaiGit(repo, 'commit', '-q', '-m', titre, '-m', `raf start ${lot} laissé non commité au lancement de cadence run ${id} : commité par le run (L796).`, '--', plan);
  out(r.status === 0 ? `raf start ${lot} laissé non commité : commité par le run (${titre}, ${git(repo, 'rev-parse', '--short', 'HEAD')})`
    : `raf start ${lot} laissé non commité : commit refusé (${`${r.stderr}${r.stdout}`.trim().split('\n').at(-1) || `code ${r.status}`}), le run part sans lui`);
}

/** L794 : run.regenerate déclarée (la consigne dit alors de ne pas régénérer) ; une clé mal formée n'est pas lue ici, la régénération la rendra. */
const aRegenerer = (wt: string) => { try { return commandesDeRegeneration(wt).length > 0; } catch { return false; } };
/** L794 : les entrées Nouveautés qui citent le lot visible, lues au commit du run ; « manquante » ne bloque pas l'intégration, la fin du run le dit. */
function noterNouveautes(e: Etat): void {
  if (!e.lot_visible || !e.lot || !existsSync(e.worktree)) return;
  const entrees = entreesQuiCitent(e.worktree, e.lot);
  e.nouveautes = { entrees, manquante: entrees?.length === 0 };
}

/** Les réglages de session d'un worktree retiré (aussi par --clore, clore.ts). */
export const oublierReglages = (worktree: string) => { libererReglages(worktree); rmSync(`${worktree}.reglages`, { recursive: true, force: true }); };
/** Retire le worktree, la branche et les réglages d'un run intégré : tout son travail est sur la cible. */
function retirerRun(e: Etat): void {
  essaiGit(e.repo, 'worktree', 'remove', '--force', e.worktree);
  essaiGit(e.repo, 'worktree', 'prune');
  essaiGit(e.repo, 'branch', '-D', e.branche);
  oublierReglages(e.worktree);
}

function fin(e: Etat, o: Opts, registre = registreOuvert(e.worktree)): Etat {
  arreterGroupe(e, o.out); // L837 : tout ce que le run a lancé est arrêté, à chaque fin
  if (e.etat !== 'integre' && existsSync(e.worktree)) { e.tete = essaiGit(e.worktree, 'rev-parse', 'HEAD').stdout.trim() || e.tete; noterNouveautes(e); }
  rendre(e, o);
  const duree = Math.round((Date.now() - Date.parse(e.debut)) / 1000);
  const ou = e.integre ? ` (${e.cible} = ${e.integre})` : '', rapport = e.rapport_tour ? ` · ${origineRapport(e)}` : '';
  o.out(`cadence run ${e.id} : ${e.etat}${ou} · ${duree} s · ${e.cout_usd.toFixed(2)} $${rapport}${e.detail ? `\n${e.detail}` : ''}`);
  if (e.passes?.length) o.out(lignePasses(e.passes)); // L726 : quel modèle a joué chaque passe, et pourquoi
  if (e.lot && e.nouveautes) o.out(ligneNouveautes(e.lot, e.nouveautes.entrees)); // L794 : « Nouveautés manquante » pour un lot visible sans entrée
  for (const r of registre) o.out(`registre : ${r}`);
  if (e.etat !== 'integre') o.out(`worktree gardé : ${e.worktree} (état : ${e.fichier})`);
  sauver(e); // L773 : l'état final après les lignes de fin : qui le voit (--liste, le lead) lit un journal --fond complet
  return e;
}

/** L773 (issue #64) : heure à la seconde et pid du créateur (deux processus vivants n'ont pas le même pid) ; un lanceur --fond le choisit pour nommer le journal. */
export const nouvelIdRun = (pid = process.pid, quand = new Date()) => `${quand.toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${pid}`;
export const ID_RUN = /^\d{14}-\d+$/;
/** `modeleRaison` : d'où vient `modele` (--modele, CADENCE_RUN_MODELE) ; sans `modele`, opus « par défaut ». `id` : celui que le lanceur --fond a choisi. */
export function executerRun(a: { id?: string; repo: string; demande: string; pieces?: string[]; taille?: string; complet?: boolean; lot?: string; registre?: string; modele?: string; modeleRaison?: string; exec?: Executeur;
  out: (l: string) => void; sansPorte?: boolean; raf?: string; maintenant?: () => Date; attendre?: ((ms: number) => void) | null; journal?: string }): Etat {
  const choisi = modeleRun(a.modele); // avant le worktree : un modèle inconnu ne crée rien, une entrée --registre absente non plus
  const repo = git(a.repo, 'rev-parse', '--show-toplevel'), cible = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  referencesDuDepot(repo); // L760 : references: mal formée refusée avant le worktree, comme un modèle inconnu
  if (a.registre && a.registre !== 'humaine') entreeCommitee(repo, a.registre);
  const id = a.id ?? nouvelIdRun();
  if (!ID_RUN.test(id)) throw new Error(`cadence run : id de run mal formé : ${id}`);
  if (a.lot) commiterStart(repo, a.lot, id, a.out); // L796 (3) : avant le worktree, qui part du commit
  // L722 : D-1.json modifié à la main pendant un run (13-11) a fait refuser l'intégration ; ce qui n'est pas commité au départ est nommé (lu avant le worktree).
  const sales = fichiersNonCommites(repo) ?? [];
  const runs = dossierRuns(repo), worktree = cheminWorktree(repo, runs, `${basename(repo)}-${id}`); // L705 (C1) : hors du dépôt avec run.worktreeOutside ; état, verrou, journal dans runs
  // L726 : Opus par défaut, Fable à la 3e passe de correction du lot ou après deux revues non conformes (runs précédents du lot, revue du plan au lancement)
  const depart = modeleDeDepart({ modele: choisi, raison: a.modele ? a.modeleRaison ?? '--modele' : 'par défaut' }, a.lot,
    a.lot ? runsDuLot(runs, repo, a.lot, id) : [], a.lot ? revueDuPlan(repo, a.lot, a.raf ?? RAF) : {});
  const modele = depart.modele;
  mkdirSync(runs, { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `cadence/run-${id}`, worktree, 'HEAD');
  copierDeps(repo, worktree);
  const nommees = commandesNommees(worktree, orchestrate(worktree), a.demande, a.lot, a.pieces ?? []); // L792, L840 (docs/analyse.md jointe si citée) : lues au commit du run
  const aig = aiguiller(a.demande, worktree, nommees.pieces, a.complet);
  const visible = lotVisible(worktree, a.lot); // L794 : visible: true ou screen dans le plan du run
  const e: Etat = { id, repo, branche: `cadence/run-${id}`, cible, base: git(worktree, 'rev-parse', 'HEAD'), worktree, fichier: join(runs, `${basename(repo)}-${id}.json`),
    demande: a.demande, pieces: aig.pieces.map((p) => chemin(worktree, p)), taille: a.taille ?? 'fonction', mode: aig.mode, modele, acces_cluster: orchestrate(worktree).prodAccess === true, registre: a.registre, ...(a.lot ? { lot: a.lot } : {}),
    ...(nommees.nommeSpec ? { spec_check: true } : {}), ...(visible ? { lot_visible: true } : {}),
    modele_raison: depart.raison, ...(depart.correctionRevue ? { correction_revue: true } : {}), ...(depart.correctionsAvant ? { corrections_avant: depart.correctionsAvant } : {}),
    ...(depart.revue ? { revue: depart.revue } : {}), ...(a.journal ? { journal: a.journal } : {}), session: crypto.randomUUID(), cout_usd: 0, etat: 'en-cours', detail: '', debut: new Date().toISOString() };
  sauver(e);
  verrouiller(e);
  a.out(`cadence run ${id} : session ${modeleDit(modele, depart.raison)} en mode ${aig.mode} (${aig.raison}) dans ${worktree}${aig.migration ? ` ; cadence.yaml : ${aig.migration}` : ''}`);
  if (sales.length) a.out(`cadence run ${id} : l'arbre principal a des modifications non commitées (hors plan en attente) : ${nommerFichiers(sales)} — le run part de `
    + `${e.base.slice(0, 7)} sans elles ; les commiter sur ${cible} pendant le run est refusé pour un fichier que le run touche (L796), et un fichier que le run change aussi fera échouer l'intégration`);
  // La ligne « Taille » du brief sert au banc (taille déclarée) ; dans un vrai dépôt, elle casserait commitlint : retirée.
  const nouveautes = a.lot && visible ? consigneNouveautes(a.lot, { maintenant: (a.maintenant ?? (() => new Date()))(), regenere: aRegenerer(worktree) }) : '';
  const demande = `${a.demande}\n\n${a.lot ? `Lot du plan : ${a.lot}. Cite-le dans chaque message de commit, selon les conventions de commit du dépôt (par exemple feat(${a.lot}): …).\n\n` : ''}${nommees.texte}${nouveautes}`
    + preparerRegistre(worktree, a.registre, { demande: a.demande, lot: a.lot, run: id }); // L701 : la demande de l'humain seule entre au registre
  const brut = readFileSync(aig.bras.brief, 'utf8');
  const brief = briefRegistre(a.registre)(leverPourCadence(brut, { specCheck: nommees.nommeSpec, analyse: nommees.analyse })).split('\n').filter((l) => !l.startsWith('- Taille fixée par le gardien')).join('\n').replaceAll('{{DEMANDE}}', demande).replaceAll('{{CLONE}}', worktree)
    .replaceAll('{{QUESTION}}', `${worktree}.question.md`).replaceAll('{{BASE}}', e.base).replaceAll('{{TAILLE}}', e.taille);
  const o = { exec: a.exec, out: a.out, sansPorte: a.sansPorte, raf: a.raf, maintenant: a.maintenant, attendre: a.attendre };
  try { return attendreQuota(tenu(e, o, () => (session(e, brief, o, true) ? suite(e, o) : fin(e, o))), o); } finally { rendreVerrou(fichierVerrou(e.fichier)); }
}

/** Reprend un run en attente (question) ou rendu (porte rouge, conflit, sans porte) : la réponse va à la même session. */
export function repondreRun(id: string, repo: string, reponse: string, o: Opts): Etat {
  const f = fichierRun(repo, id);
  if (!existsSync(f)) throw new Error(`cadence run : run inconnu : ${id} (${f})`);
  const coupe = etatVu(lireEtat(f)) === 'interrompu' ? 'Ta session a été interrompue (le processus du run est mort) : reprends là où tu t\'étais arrêté, dans le même dossier. ' : '';
  verrouiller(lireEtat(f)); // D-18 : refusé si un processus vivant joue ou attend ce run ; l'état est relu sous le verrou
  try {
    const e = lireEtat(f);
    if (e.etat === 'integre') throw new Error(`cadence run : ${id} est déjà intégré`);
    // Revue L745 (M2) : un run clos n'a plus sa branche ; la session partirait pour rien et réécrirait son état
    if (e.clos) throw new Error(`cadence run : ${id} est clos (--clore) le ${e.clos.date.slice(0, 10)} : sa branche est retirée, son travail archivé (cadence run --archives), rien à reprendre ; une suite : cadence run "<demande>"`);
    if (e.etat === 'porte-rouge') ouvrirCorrection(e, e.detail, o.out); // L724 : la réponse du lead à une porte rouge est une correction, pas le travail
    e.etat = 'en-cours'; delete e.quota; sauver(e); // L709 : un run interrompu reprend la même session (son id est dans l'état dès le lancement), même worktree
    return attendreQuota(tenu(e, o, () => (session(e, `${coupe}Réponse de Sylvain : ${reponse}`, o, false, sujetEnCours(e)) ? suite(e, o) : fin(e, o))), o);
  } finally { rendreVerrou(fichierVerrou(f)); }
}


/** D-15 : un run en quota attend l'heure de remise à zéro, puis reprend la même session dans le même worktree. Pendant l'attente, la branche est rendue (fin()
 * est passé) : le lead travaille ; le verrou reste à ce processus (rôle « attente », D-18) : un --reponse est refusé. Relue à chaque tranche, un état changé
 * à la main (plus en quota, autre heure) ou un verrou qui n'est plus le sien arrête cette attente. */
function attendreQuota(e: Etat, o: Opts): Etat {
  if (o.attendre === null) return e;
  const maintenant = o.maintenant ?? (() => new Date()), attendre = o.attendre ?? dormir;
  for (let n = 0; e.etat === 'quota' && e.quota?.reprise && n < REPRISES_QUOTA_MAX; n++) {
    const reprise = e.quota.reprise, attendu = () => { const x = lireEtat(e.fichier); return x.etat === 'quota' && x.quota?.reprise === reprise && occupantRun(e.fichier)?.pid === process.pid; }; roleVerrou(fichierVerrou(e.fichier), 'attente');
    for (let reste: number; (reste = Date.parse(reprise) + MARGE_REPRISE_MS - maintenant().getTime()) > 0;) {
      attendre(Math.min(reste, TRANCHE_ATTENTE_MS));
      if (!attendu()) { o.out(`cadence run ${e.id} : repris ailleurs pendant l'attente du quota, cette attente s'arrête`); return lireEtat(e.fichier); }
    }
    o.out(`cadence run ${e.id} : quota revenu : reprise de la session ${e.session}`);
    e.etat = 'en-cours'; delete e.quota; sauver(e); roleVerrou(fichierVerrou(e.fichier), 'session');
    e = tenu(e, o, () => (session(e, REPRISE_QUOTA, o, false, sujetEnCours(e)) ? suite(e, o) : fin(e, o)));
  }
  return e;
}
