// cadence run : une demande, une session (Opus par défaut, L699 : --modele), de bout en bout (plan n°6, 09-11).
// Le produit joue EXACTEMENT un bras mesuré au banc, choisi par l'aiguillage (aiguillage.ts) : brief v2d + hook « lecture obligatoire »
// quand la demande a des références à lire, brief de Claude seul sinon ; mêmes interdictions. Puis : rebase sur la branche de départ, porte complète UNE fois
// (une reprise de la même session si elle est rouge), intégration en avance rapide. Le plan (raf) et deliver restent ceux de la v1.
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
import { debutProcessus, inscrireCreneau, occupantVivant, prendreVerrou, rendreVerrou, roleVerrou } from '../verrou.js';

/** D-15 : le run reprend une minute après l'heure de remise à zéro annoncée, relit son état au plus tard toutes les 10 min (une reprise par --reponse arrête
 * l'attente), et ne reprend pas plus de 5 fois de suite sur un quota (une heure de remise à zéro qui ne remet rien à zéro ne boucle pas). */
const MARGE_REPRISE_MS = 60_000, PORTE_MS = 30 * 60_000 /* une commande de la porte */, TRANCHE_ATTENTE_MS = 10 * 60_000, REPRISES_QUOTA_MAX = 5;
const REPRISE_QUOTA = 'Le quota est revenu : reprends le travail là où tu t\'étais arrêté, dans le même dossier, puis dis « fini ».';
const BASCULE_FABLE = 'La limite Opus est atteinte : tu continues sur Fable. Reprends le travail là où tu t\'étais arrêté, dans le même dossier, puis dis « fini ».';

export type EtatRun = 'en-cours' | 'interrompu' | 'attente' | 'quota' | 'sans-commit' | 'echec' | 'conflit' | 'porte-rouge' | 'sans-porte' | 'refus-integration' | 'integre';
export interface Etat { id: string; repo: string; branche: string; cible: string; base: string; worktree: string; fichier: string; demande: string; pieces: string[];
  taille: string; mode: 'complet' | 'leger'; modele?: string; acces_cluster: boolean; registre?: string; lot?: string; session: string; cout_usd: number; etat: EtatRun; detail: string; debut: string; integre?: string; quota?: Quota; journal?: string; rapport?: string; messages?: Message[] }
/** `maintenant` et `attendre` : l'horloge et l'attente du quota (D-15), simulées par les tests ; `attendre: null` rend la main sans attendre la remise à zéro. */
interface Opts { exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string; maintenant?: () => Date; attendre?: ((ms: number) => void) | null }

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const essaiGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }), dossierRuns = (repo: string) => join(dirname(repo), '.cadence-run');
const sauver = (e: Etat) => { writeFileSync(e.fichier, JSON.stringify(e, null, 1)); return e; }, lireEtat = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Etat;

// L695 (D-9) : le run tient la branche cible du début à la fin ; le pre-commit de raf (raf hook install) y refuse un commit du lead, qui le ferait
// échouer en avance rapide, et raf add|note|done|review|ux|demande écrivent dans le plan en attente (L722). Même format que src/repo-held.ts, qui le lit.
const PLAN_EN_ATTENTE = join('.cadence', 'plan-en-attente.yaml');
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

/** L722 : les fichiers non commités de l'arbre principal, hors plan en attente (même lecture que uncommittedFiles de src/repo-held.ts) ; [] si git ne répond pas. */
function nonCommites(repo: string): string[] {
  const r = essaiGit(repo, 'status', '--porcelain', '--no-renames', '-z'); // -z : chemins bruts ; un renommage est dit en deux chemins (supprimé, ajouté)
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean).map((e) => e.slice(3)).filter((f) => f !== PLAN_EN_ATTENTE) : [];
}
const nommer = (f: string[]) => (f.length > 10 ? `${f.slice(0, 10).join(', ')} et ${f.length - 10} autre(s)` : f.join(', '));

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
function session(e: Etat, prompt: string, o: Opts, neuve = false): boolean {
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
  garderRapport(e, r.messages, o.out, !q && !r.echec);
  if (q?.limite === 'opus' && (e.modele ?? 'opus') === 'opus') {
    o.out('limite Opus atteinte : bascule sur fable, même session');
    e.modele = 'fable'; sauver(e);
    return session(e, e.session ? BASCULE_FABLE : prompt, o);
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

/** Après chaque passage de session : question, commits, rebase, porte (une reprise), intégration. */
function suite(e: Etat, o: Opts): Etat {
  const q = `${e.worktree}.question.md`;
  if (existsSync(q)) { e.etat = 'attente'; e.detail = readFileSync(q, 'utf8'); rmSync(q); o.out(`question (réponds : cadence run --reponse ${e.id} "…") :\n${e.detail}`); return fin(e, o); }
  if (git(e.worktree, 'rev-list', '--count', `${e.base}..HEAD`) === '0') { e.etat = 'sans-commit'; e.detail = 'la session n\'a rien commité'; return fin(e, o); }
  const cible = git(e.repo, 'rev-parse', e.cible);
  if (essaiGit(e.worktree, 'rebase', '-q', cible).status !== 0) {
    essaiGit(e.worktree, 'rebase', '--abort'); e.etat = 'conflit'; e.detail = `conflit au rebase sur ${e.cible}`; return fin(e, o);
  }
  const cmds = commandesDeCadenceYaml(e.repo);
  if (!cmds.length && !o.sansPorte) { e.etat = 'sans-porte'; e.detail = 'cadence.yaml ne déclare ni orchestrate.test ni orchestrate.build : relance avec --sans-porte pour intégrer quand même'; return fin(e, o); }
  // Porte complète : une fois ; rouge, la même session corrige une fois et la porte est rejouée (C3 : un seul site de porte).
  for (let essai = 0; ; essai++) {
    const r = registreTouche(e.worktree, e.registre, cible), p = r ? { ok: false, sortie: r } : jouerPorte(cmds, e.worktree); // L701 : sans option, rien au registre ; --registre D-n, aucune entrée neuve
    if (p.ok) break;
    if (essai === 1) { e.etat = 'porte-rouge'; e.detail = p.sortie; return fin(e, o); }
    o.out('porte rouge : reprise de la session pour corriger');
    if (!session(e, `La porte complète est rouge après ton travail :\n${p.sortie}\nCorrige la cause (sans affaiblir aucun test), commite, puis dis « fini ».`, o)) return fin(e, o);
  }
  const br = git(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), actuelle = essaiGit(e.repo, 'symbolic-ref', '-q', '--short', 'HEAD').stdout.trim();
  const m = actuelle === e.cible ? essaiGit(e.repo, 'merge', '-q', '--ff-only', br) : essaiGit(e.repo, 'fetch', '-q', '.', `${br}:${e.cible}`);
  if (m.status !== 0) { e.etat = 'refus-integration'; e.detail = `${m.stderr}`.trim() || 'avance rapide impossible'; return fin(e, o); }
  e.integre = git(e.repo, 'rev-parse', '--short', e.cible); e.etat = 'integre'; e.detail = '';
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
  const sales = nonCommites(repo);
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
  if (sales.length) a.out(`cadence run ${id} : l'arbre principal a des modifications non commitées (hors plan en attente) : ${nommer(sales)} — le run part de `
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
    e.etat = 'en-cours'; delete e.quota; sauver(e); // L709 : un run interrompu reprend la même session (son id est dans l'état dès le lancement), même worktree
    return attendreQuota(tenu(e, o, () => (session(e, `${coupe}Réponse de Sylvain : ${reponse}`, o) ? suite(e, o) : fin(e, o))), o);
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
    e = tenu(e, o, () => (session(e, REPRISE_QUOTA, o) ? suite(e, o) : fin(e, o)));
  }
  return e;
}
