// cadence run : une demande, une session (Opus par défaut, L699 : --modele), de bout en bout (plan n°6, 09-11).
// Le produit joue EXACTEMENT un bras mesuré au banc, choisi par l'aiguillage (aiguillage.ts) : brief v2d + hook « lecture obligatoire »
// quand la demande a des références à lire, brief de Claude seul sinon ; mêmes interdictions. Puis : rebase sur la branche de départ, porte complète UNE fois
// (une reprise de la même session si elle est rouge), intégration en avance rapide ; si la cible a avancé entre-temps, rebase et porte rejoués (L723).
// Le plan (raf) et deliver restent ceux de la v1.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { argsClaude, creerExecuteur, libererReglages, lire, OUTILS_INTERDITS, type Executeur } from '../bench/bras.js';
import { aiguiller, BRAS_COMPLET, BRAS_LEGER, chemin, modeleRun } from './aiguillage.js';
import { heureLocale, reconnaitreQuota, type Quota } from './quota.js';
import { causeSession } from '../trace.js';
import { garderRapport, type Message } from '../rapport.js';
import { cheminWorktree, reglagesRun } from '../socle.js';
import { briefRegistre, entreeCommitee, preparerRegistre, registreOuvert, registreTouche } from '../registre.js';
import { fichiersNonCommites, nommerFichiers, PLAN_EN_ATTENTE } from '../../../scripts/arbre-non-commite.mjs'; // L722 : même lecture que src/repo-held.ts
import { debutProcessus, inscrireCreneau, occupantVivant, prendreVerrou, rendreVerrou, roleVerrou } from '../verrou.js';

/** D-15 : le run reprend une minute après l'heure de remise à zéro annoncée, relit son état au plus tard toutes les 10 min (une reprise par --reponse arrête
 * l'attente), et ne reprend pas plus de 5 fois de suite sur un quota (une heure de remise à zéro qui ne remet rien à zéro ne boucle pas). */
const MARGE_REPRISE_MS = 60_000, PORTE_MS = 30 * 60_000 /* une commande de la porte */, TRANCHE_ATTENTE_MS = 10 * 60_000, REPRISES_QUOTA_MAX = 5;
const REPRISE_QUOTA = 'Le quota est revenu : reprends le travail là où tu t\'étais arrêté, dans le même dossier, puis dis « fini ».';
const BASCULE_FABLE = 'La limite Opus est atteinte : tu continues sur Fable. Reprends le travail là où tu t\'étais arrêté, dans le même dossier, puis dis « fini ».';

/** L723 : un conflit au rebase sur la cible, rendu à la session ; `resolu` faux tant qu'elle ne l'a pas résolu (refus, quota, signal), `message` : son dernier mot. */
export interface Conflit { cible: string; sur: string; fichiers: string[]; resolu: boolean; message?: string }
/** L724 : une porte rouge rendue à la session pour correction ; `rouge` : la sortie de la porte, `message` : le dernier mot de la session,
 * `verte` : la porte rejouée après la correction, absente tant qu'elle n'a pas été rejouée. */
export interface Correction { rouge: string; message?: string; verte?: boolean }
export type EtatRun = 'en-cours' | 'interrompu' | 'attente' | 'quota' | 'sans-commit' | 'echec' | 'conflit' | 'porte-rouge' | 'sans-porte' | 'refus-integration' | 'integre';
export interface Etat { id: string; repo: string; branche: string; cible: string; base: string; worktree: string; fichier: string; demande: string; pieces: string[];
  taille: string; mode: 'complet' | 'leger'; modele?: string; acces_cluster: boolean; registre?: string; lot?: string; session: string; cout_usd: number; etat: EtatRun; detail: string; debut: string; integre?: string; quota?: Quota; journal?: string; rapport?: string; messages?: Message[];
  conflits?: Conflit[]; corrections?: Correction[] }
/** `maintenant` et `attendre` : l'horloge et l'attente du quota (D-15), simulées par les tests ; `attendre: null` rend la main sans attendre la remise à zéro. */
interface Opts { exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string; maintenant?: () => Date; attendre?: ((ms: number) => void) | null }

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const essaiGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }), dossierRuns = (repo: string) => join(dirname(repo), '.cadence-run');
const sauver = (e: Etat) => { writeFileSync(e.fichier, JSON.stringify(e, null, 1)); return e; }, lireEtat = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Etat;

// L695 (D-9) : le run tient la branche cible du début à la fin ; le pre-commit de raf (raf hook install) y refuse un commit du lead, qui le ferait
// échouer en avance rapide, et raf add|note|done|review|ux|demande écrivent dans le plan en attente (L722). Même format que src/repo-held.ts, qui le lit.
const RAF = fileURLToPath(new URL('../../../bin/raf.js', import.meta.url));
const fichierTenu = (repo: string) => join(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')), 'cadence', 'tenu', `run-${process.pid}.json`);
// Revue L695 r1 (D-10) : `start` écrit, un fichier laissé par un run tué (Ctrl-C, SIGKILL, PC éteint) ne tient plus la branche quand son pid est repris.
function tenir(e: Etat): void {
  const f = fichierTenu(e.repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ pid: process.pid, start: debutProcessus(process.pid), kind: 'run', label: `cadence run ${e.id}`, branch: e.cible, since: new Date().toISOString() }));
}
/**
 * Joue le run en tenant la branche : une exception (un git qui échoue, l'exécuteur qui lève) finit le run en échec et rend le dépôt comme les autres fins.
 * Un run tué par un signal ne passe pas ici : son fichier reste, mais un porteur mort (pid absent ou repris, `start` à l'appui) ne tient rien.
 */
function tenu(e: Etat, o: Opts, corps: () => Etat): Etat {
  tenir(e); const retirer = inscrireCreneau(e); // L710 : le run vivant prend un créneau de sessions (../verrou.ts)
  try {
    return corps();
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

const orchestrate = (repo: string): { test?: string; build?: string; prodAccess?: boolean } =>
  existsSync(join(repo, 'cadence.yaml')) ? (parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) as { orchestrate?: object } | null)?.orchestrate ?? {} : {};
function commandesDeCadenceYaml(repo: string): string[] {
  const o = orchestrate(repo);
  return [o.test, o.build].filter((c): c is string => typeof c === 'string' && !!c.trim());
}
function jouerPorte(cmds: string[], cwd: string): { ok: boolean; sortie: string } {
  for (const c of cmds) {
    const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', timeout: PORTE_MS, maxBuffer: 64 << 20 });
    if (r.status !== 0) return { ok: false, sortie: `$ ${c}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000)}${r.error ? `\n${r.error.message}` : ''}` };
  }
  return { ok: true, sortie: '' };
}

// L709 (issue #55) : rien de ce qui lie un processus à la session Claude Code lanceuse (pid, socket, auth rafraîchie par l'hôte) ; `neuve` : 1re session, id de l'état.
const LIEN_HOTE = /^CLAUDE_(PID|SSH_\w+|CODE_(CHILD_SESSION|MESSAGING_\w+|SDK_HAS_HOST_AUTH_REFRESH|HOST_SESSION_ID|SESSION_ID))$/;
/** `sujet` : une session qui ne fait pas le travail demandé (L723 : la résolution d'un conflit) ; ses messages ne remplacent pas le rapport du travail. */
function session(e: Etat, prompt: string, o: Opts, neuve = false, sujet?: string): boolean {
  const exec = o.exec ?? creerExecuteur('claude', 4 * 3600_000);
  // L699 : le modèle est celui du lancement, gardé dans l'état (une reprise par --reponse ne le change pas) ; un état d'avant L699 n'en a pas : opus.
  // orchestrate.prodAccess (comme les vagues de la v1) : sans lui, ni kubectl, ni helm, ni KUBECONFIG ; avec lui, la session joue le banc du projet
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LIEN_HOTE.test(k) && k !== 'CADENCE_RUN_JOURNAL')), CADENCE_CLONE: e.worktree, CADENCE_PIECES: JSON.stringify(e.pieces), CADENCE_BANC_RACINE: dossierRuns(e.repo), ...(e.acces_cluster ? {} : { KUBECONFIG: '/dev/null' }) };
  const interdits = e.acces_cluster ? OUTILS_INTERDITS.filter((x) => !/kubectl|helm/.test(x)) : OUTILS_INTERDITS;
  const brut = exec(['-p', prompt, ...(neuve ? ['--session-id', e.session] : e.session ? ['--resume', e.session] : []), ...argsClaude({ ...(e.mode === 'leger' ? BRAS_LEGER : BRAS_COMPLET), modele: e.modele ?? 'opus' }, e.worktree, interdits, reglagesRun(e.worktree))], { cwd: e.worktree, env }); // L705 : coupes du socle (../socle.ts)
  const r = lire(brut), cause = causeSession(brut); if (cause) o.out(cause); // L711 : une session arrêtée par un signal le dit dans le journal, avant la suite habituelle
  e.session = r.session || e.session; e.cout_usd += r.cout;
  // D-15 : une fin de quota n'est pas un échec. La limite Opus seule bascule sur fable dans la même session ; la limite hebdo bloque tous les modèles : on attend.
  const q = reconnaitreQuota(r.resultat || brut.stdout, (o.maintenant ?? (() => new Date()))());
  // Issue #57 : chaque message de la session va au journal et à l'état quelle que soit sa fin (travail fini, échec, délai, signal, quota) : c'est là que le
  // lead lit ce qui a été fait et ce qui reste. Le rapport est le dernier message du tour du prompt, fixé seulement si le travail a fini ; les tours ouverts
  // après lui (notifications de tâche) vont au journal, sans le remplacer.
  garderRapport(e, r.messages, o.out, !q && !r.echec, sujet);
  const mot = r.messages.filter((m) => m.tour === 1).at(-1)?.texte, c = e.corrections?.at(-1);
  if (sujet === SUJET_CORRECTION && mot && c) c.message = mot; // L724 : ce que la correction a fait, gardé avec ce qui était rouge
  if (q?.limite === 'opus' && (e.modele ?? 'opus') === 'opus') {
    o.out('limite Opus atteinte : bascule sur fable, même session');
    e.modele = 'fable'; sauver(e);
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
  + '`GIT_EDITOR=true git rebase --continue`, jusqu\'à la fin du rebase, sans --skip ni --abort. Ne commite rien d\'autre, puis dis « fini ».';

const SUJET_CONFLIT = 'résolution du conflit au rebase';
// L724 : même modèle pour la correction après porte rouge : son « fini » ne remplace pas le rapport du travail ; la porte rouge, ce que la session en
// dit et la porte rejouée ensuite sont AJOUTÉS à l'état (`corrections`) et au journal.
const SUJET_CORRECTION = 'correction après porte rouge';
/** Ouvre une correction ; une correction encore en attente de sa porte (reprise par --reponse) a été suivie d'une porte rouge : elle n'a pas rendu la porte verte. */
function ouvrirCorrection(e: Etat, rouge: string): void {
  const c = e.corrections?.at(-1);
  if (c && c.verte === undefined) c.verte = false;
  e.corrections = [...(e.corrections ?? []), { rouge }]; sauver(e);
}
/** Une session reprise (--reponse, quota) pendant une correction la continue : même sujet, le rapport du travail reste. */
const sujetEnCours = (e: Etat) => (e.corrections?.length && e.corrections.at(-1)?.verte === undefined ? SUJET_CORRECTION : undefined);
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
  if (essaiGit(e.worktree, 'rebase', '-q', cible).status === 0) return null;
  const fichiers = fichiersGit(e.worktree, 'diff', '--name-only', '--diff-filter=U');
  const c: Conflit = { cible: e.cible, sur: cible, fichiers, resolu: false };
  e.conflits = [...(e.conflits ?? []), c]; sauver(e);
  o.out(`conflit au rebase sur ${e.cible} (${fichiers.join(', ')}) : reprise de la session pour le résoudre`);
  const avant = e.messages?.length ?? 0;
  const repondu = session(e, consigneConflit(e, fichiers), o, false, SUJET_CONFLIT), enCours = rebaseEnCours(e.worktree);
  const message = (e.messages ?? []).slice(avant).filter((m) => m.tour === 1).at(-1)?.texte;
  if (message) c.message = message;
  if (enCours) essaiGit(e.worktree, 'rebase', '--abort');
  if (!repondu) return fin(e, o);
  const q = question(e, o);
  if (q) return q;
  if (enCours || essaiGit(e.worktree, 'merge-base', '--is-ancestor', cible, 'HEAD').status !== 0) {
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

/** Après chaque passage de session : question, commits, puis rebase, porte et avance rapide, rejoués tant que la cible avance (L723). */
function suite(e: Etat, o: Opts): Etat {
  const q = question(e, o);
  if (q) return q;
  if (git(e.worktree, 'rev-list', '--count', `${e.base}..HEAD`) === '0') { e.etat = 'sans-commit'; e.detail = 'la session n\'a rien commité'; return fin(e, o); }
  const cmds = commandesDeCadenceYaml(e.repo);
  if (!cmds.length && !o.sansPorte) { e.etat = 'sans-porte'; e.detail = 'cadence.yaml ne déclare ni orchestrate.test ni orchestrate.build : relance avec --sans-porte pour intégrer quand même'; return fin(e, o); }
  const br = git(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
  for (let rebase = 1; ; rebase++) {
    const cible = git(e.repo, 'rev-parse', e.cible), arret = rebaser(e, o, cible);
    if (arret) return arret;
    // Porte complète : une fois ; rouge, la même session corrige une fois et la porte est rejouée (C3 : un seul site de porte).
    for (let essai = 0; ; essai++) {
      const r = registreTouche(e.worktree, e.registre, cible), p = r ? { ok: false, sortie: r } : jouerPorte(cmds, e.worktree); // L701 : sans option, rien au registre ; --registre D-n, aucune entrée neuve
      const c = e.corrections?.at(-1), attendue = c?.verte === undefined ? c : undefined;
      if (p.ok) {
        if (attendue) { attendue.verte = true; sauver(e); o.out(correctionFaite(attendue)); }
        break;
      }
      if (essai === 1) { if (attendue) attendue.verte = false; e.etat = 'porte-rouge'; e.detail = p.sortie; return fin(e, o); }
      o.out(`porte rouge : reprise de la session pour corriger :\n${p.sortie}`);
      ouvrirCorrection(e, p.sortie);
      if (!session(e, `La porte complète est rouge après ton travail :\n${p.sortie}\nCorrige la cause (sans affaiblir aucun test), commite, puis dis « fini ».`, o, false, SUJET_CORRECTION)) return fin(e, o);
    }
    const refus = avancer(e, br, cible);
    if (!refus) break;
    if (!refus.avance || rebase === REBASES_MAX) {
      e.etat = 'refus-integration'; e.detail = refus.avance ? `${e.cible} a encore avancé après ${REBASES_MAX} rebases : ${refus.raison}` : refus.raison; return fin(e, o);
    }
    o.out(`${e.cible} a avancé pendant la porte : rebase et porte rejouée (${rebase + 1}/${REBASES_MAX})`);
  }
  e.integre = git(e.repo, 'rev-parse', '--short', e.cible); e.etat = 'integre';
  // L723 : intégré, mais une fusion écrite par la session est à relire ; L724 : de même pour une correction après porte rouge
  e.detail = [...(e.conflits ?? []).filter((c) => c.resolu).map((c) => conflitResolu(e, c)), ...(e.corrections ?? []).filter((c) => c.verte).map(correctionFaite)].join('\n');
  const registre = registreOuvert(e.worktree);
  essaiGit(e.repo, 'worktree', 'remove', '--force', e.worktree); essaiGit(e.repo, 'branch', '-D', br);
  libererReglages(e.worktree); rmSync(`${e.worktree}.reglages`, { recursive: true, force: true });
  return fin(e, o, registre);
}

function fin(e: Etat, o: Opts, registre = registreOuvert(e.worktree)): Etat {
  sauver(e);
  rendre(e, o);
  const duree = Math.round((Date.now() - Date.parse(e.debut)) / 1000);
  o.out(`cadence run ${e.id} : ${e.etat}${e.integre ? ` (${e.cible} = ${e.integre})` : ''} · ${duree} s · ${e.cout_usd.toFixed(2)} $${e.detail ? `\n${e.detail}` : ''}`);
  for (const r of registre) o.out(`registre : ${r}`);
  if (e.etat !== 'integre') o.out(`worktree gardé : ${e.worktree} (état : ${e.fichier})`);
  return e;
}

export function executerRun(a: { repo: string; demande: string; pieces?: string[]; taille?: string; complet?: boolean; lot?: string; registre?: string; modele?: string; exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string;
  maintenant?: () => Date; attendre?: ((ms: number) => void) | null; journal?: string }): Etat {
  const modele = modeleRun(a.modele); // avant le worktree : un modèle inconnu ne crée rien, une entrée --registre absente non plus
  const repo = git(a.repo, 'rev-parse', '--show-toplevel'), cible = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (a.registre && a.registre !== 'humaine') entreeCommitee(repo, a.registre);
  // L722 : D-1.json modifié à la main pendant un run (13-11) a fait refuser l'intégration ; ce qui n'est pas commité au départ est nommé (lu avant le worktree).
  const sales = fichiersNonCommites(repo) ?? [];
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${process.pid}`;
  const runs = dossierRuns(repo), worktree = cheminWorktree(repo, runs, `${basename(repo)}-${id}`); // L705 (C1) : hors du dépôt avec run.worktreeOutside ; état, verrou, journal dans runs
  mkdirSync(runs, { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `cadence/run-${id}`, worktree, 'HEAD');
  copierDeps(repo, worktree);
  const aig = aiguiller(a.demande, worktree, a.pieces ?? [], a.complet);
  const e: Etat = { id, repo, branche: `cadence/run-${id}`, cible, base: git(worktree, 'rev-parse', 'HEAD'), worktree, fichier: join(runs, `${basename(repo)}-${id}.json`),
    demande: a.demande, pieces: aig.pieces.map((p) => chemin(worktree, p)), taille: a.taille ?? 'fonction', mode: aig.mode, modele, acces_cluster: orchestrate(worktree).prodAccess === true, registre: a.registre, ...(a.lot ? { lot: a.lot } : {}), ...(a.journal ? { journal: a.journal } : {}), session: crypto.randomUUID(), cout_usd: 0, etat: 'en-cours', detail: '', debut: new Date().toISOString() };
  sauver(e);
  verrouiller(e);
  a.out(`cadence run ${id} : session ${modele[0].toUpperCase()}${modele.slice(1)} en mode ${aig.mode} (${aig.raison}) dans ${worktree}`);
  if (sales.length) a.out(`cadence run ${id} : l'arbre principal a des modifications non commitées (hors plan en attente) : ${nommerFichiers(sales)} — le run part de `
    + `${e.base.slice(0, 7)} sans elles ; les commiter sur ${cible} est refusé pendant le run, et un fichier que le run change aussi fera échouer l'intégration`);
  // La ligne « Taille » du brief sert au banc (taille déclarée) ; dans un vrai dépôt, elle casserait commitlint : retirée.
  const demande = `${a.demande}\n\n${a.lot ? `Lot du plan : ${a.lot}. Cite-le dans chaque message de commit, selon les conventions de commit du dépôt (par exemple feat(${a.lot}): …).\n\n` : ''}`
    + preparerRegistre(worktree, a.registre, { demande: a.demande, lot: a.lot, run: id }); // L701 : la demande de l'humain seule entre au registre
  const brief = briefRegistre(a.registre)(readFileSync(aig.bras.brief, 'utf8')).split('\n').filter((l) => !l.startsWith('- Taille fixée par le gardien')).join('\n').replaceAll('{{DEMANDE}}', demande).replaceAll('{{CLONE}}', worktree)
    .replaceAll('{{QUESTION}}', `${worktree}.question.md`).replaceAll('{{BASE}}', e.base).replaceAll('{{TAILLE}}', e.taille);
  const o = { exec: a.exec, out: a.out, sansPorte: a.sansPorte, raf: a.raf, maintenant: a.maintenant, attendre: a.attendre };
  try { return attendreQuota(tenu(e, o, () => (session(e, brief, o, true) ? suite(e, o) : fin(e, o))), o); } finally { rendreVerrou(fichierVerrou(e.fichier)); }
}

/** Reprend un run en attente (question) ou rendu (porte rouge, conflit, sans porte) : la réponse va à la même session. */
export function repondreRun(id: string, repo: string, reponse: string, o: Opts): Etat {
  const racine = git(repo, 'rev-parse', '--show-toplevel');
  const f = join(dossierRuns(racine), `${basename(racine)}-${id}.json`);
  if (!existsSync(f)) throw new Error(`cadence run : run inconnu : ${id} (${f})`);
  const coupe = etatVu(lireEtat(f)) === 'interrompu' ? 'Ta session a été interrompue (le processus du run est mort) : reprends là où tu t\'étais arrêté, dans le même dossier. ' : '';
  verrouiller(lireEtat(f)); // D-18 : refusé si un processus vivant joue ou attend ce run ; l'état est relu sous le verrou
  try {
    const e = lireEtat(f);
    if (e.etat === 'integre') throw new Error(`cadence run : ${id} est déjà intégré`);
    if (e.etat === 'porte-rouge') ouvrirCorrection(e, e.detail); // L724 : la réponse du lead à une porte rouge est une correction, pas le travail
    e.etat = 'en-cours'; delete e.quota; sauver(e); // L709 : un run interrompu reprend la même session (son id est dans l'état dès le lancement), même worktree
    return attendreQuota(tenu(e, o, () => (session(e, `${coupe}Réponse de Sylvain : ${reponse}`, o, false, sujetEnCours(e)) ? suite(e, o) : fin(e, o))), o);
  } finally { rendreVerrou(fichierVerrou(f)); }
}

/** Attente bloquante, sans processus fils (le run est synchrone de bout en bout). */
const dormir = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
