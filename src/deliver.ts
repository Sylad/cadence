import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { onTermination, readProcs, SIGNAL_GRACE_MS, SIGNAL_PENDING_MS, TreeTracker } from './proc.js';
import type { Day } from './dates.js';
import { isPlanOnly } from './audit.js';
import { commitPaths, dirtyPaths, headSha, isAncestor, onRemote, readCommits, repoStatus, resolveCommit } from './git.js';
import { PLAN_ACTIONS, planCommitMessage } from './plan-commit.js';
import { citedRefs } from './link.js';
import { describeArticle, openArticleLots, type ArticleRule } from './articles.js';
import { RafError, type Lot, type Plan } from './plan.js';
import { appendDelivery, appendFailedDelivery, type FailClass, lastDelivery, lockAlive, lockFault, lockPath, readLock, releaseLock, removeStaleLock, writeLock } from './state.js';

export interface VerifyCheck {
  url?: string;
  status?: number;
  contains?: string;
  command?: string;
}

export interface DeliverConfig {
  ci: 'github' | 'none' | { command: string };
  /**
   * Script de livraison du projet : il porte lui-même la CI, le déploiement et ses contrôles métier.
   * cadence garde les préconditions, le verrou, le journal et les lots livrés.
   */
  script?: string;
  /**
   * Un arbre de travail modifié est signalé au lieu d'être refusé : pour un dépôt partagé entre plusieurs
   * sessions dont la livraison part d'un sha poussé, jamais des fichiers locaux.
   */
  allowDirty?: boolean;
  /** Secondes. */
  ciTimeout: number;
  deploy: string[];
  verify: VerifyCheck[];
  /** Secondes pendant lesquelles les vérifications sont réessayées. */
  verifyTimeout: number;
  /** Secondes maximum par commande de déploiement. */
  deployTimeout: number;
}

export interface GhRun {
  name: string;
  status: string;
  conclusion: string;
}

export interface DeliverDeps {
  /**
   * Commande sh à la racine du dépôt, variables ajoutées à l'environnement ; renvoie le code de sortie,
   * TIMED_OUT si elle a dépassé `timeoutMs` (elle est alors tuée, avec tous ses descendants).
   */
  exec: (cmd: string, env: Record<string, string>, timeoutMs: number) => number | Promise<number>;
  /** Dernières lignes de sortie (stdout et stderr) de la dernière commande lancée par `exec`, vides si elle n'a rien écrit ; absent : la raison d'un échec ne les porte pas. */
  lastOutput?: () => string[];
  /** Runs de la CI pour ce sha ; lève une erreur au message utile (stderr de gh). */
  gh: (sha: string) => GhRun[];
  /** Précondition de `ci: github` : message d'erreur si gh est absent ou non authentifié, null sinon. */
  ghReady: () => string | null;
  /** `timeoutMs` : délai de la requête (20 s par défaut). */
  fetch: (url: string, timeoutMs?: number) => Promise<{ status: number; text: string }>;
  sleep: (ms: number) => Promise<void>;
  /** Millisecondes. */
  now: () => number;
}

/**
 * Ce dont une vérification a besoin. Celui de `cadence verify` et de « session start » lance ses commandes
 * en groupe détaché, en parallèle ; celui de deliver, au premier plan, l'une après l'autre.
 */
export type CheckDeps = Pick<DeliverDeps, 'exec' | 'fetch' | 'sleep' | 'now'>;

export interface DeliverCtx {
  root: string;
  /** État commun à tous les worktrees : verrou et journal des livraisons. */
  state: string;
  plan: Plan | null;
  config: DeliverConfig;
  today: Day;
  dryRun: boolean;
  /** Commit à livrer (toute révision git) ; HEAD par défaut. */
  sha?: string;
  /**
   * Livraison au fil de l'eau (L277) : une vague tient le dépôt, des lots y commitent encore. La tête peut avancer pendant le script
   * sans que cadence sache de qui est le commit : on ne devine pas, le journal garde le sha de départ (avec un avertissement) sauf si
   * le script déclare ce qu'il a déployé (CADENCE_DEPLOYED_FILE).
   */
  duringWave?: boolean;
  /** Identifiant de la vague qui tient le dépôt (cité par le commit du plan écrit pour un article, L388). */
  waveId?: string;
  /** Gabarit `plan.commit` du projet (L343) : le message du commit du plan écrit pour un article pendant une vague. */
  planCommit?: string;
  /** Arguments de la ligne de commande, ajoutés au script du projet. */
  args: string[];
  /** Articles d'un dépôt voisin à rafraîchir après une livraison verte (clé `docs.articles`, L144). */
  articles?: ArticleRule[];
  /** Titre public d'un lot (le sien, sinon celui de sa Nouveauté) ; `lot.public` par défaut. */
  publicTitle?: (lot: Lot) => string | undefined;
  out: (line: string) => void;
  err: (line: string) => void;
}

const POLL_CI = 15_000;
const CI_APPEAR = 300_000;
/** Intervalle de réessai d'une vérification : celui de deliver ET de `cadence verify --retry`. */
export const POLL_VERIFY = 10_000;
const CI_OK = new Set(['success', 'skipped', 'neutral']);
const GH_TIMEOUT = 60_000;
export const TIMED_OUT = 124;

/** Sortie gardée d'une commande : de quoi retrouver ses dernières lignes. */
const OUTPUT_KEPT = 8_192;
/** Signaux que cadence écoute (proc.ts) : une racine qu'ils ont tuée laisse présager le même signal vers cadence. */
const TERMINATION_SIGNALS = [constants.signals.SIGHUP, constants.signals.SIGINT, constants.signals.SIGTERM];
/** Les lignes de la sortie ; une ligne réécrite par \r (barre de progression) ne garde que sa dernière image non vide. */
const outputTail = (text: string): string[] =>
  text.split('\n').flatMap((l) => l.split('\r').filter((f) => f.trim() !== '').slice(-1));

const codeText = (code: number) => (code === TIMED_OUT ? 'délai dépassé' : `code ${code}`);

export function parseDeliverConfig(text: string, file: string): DeliverConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const d = (raw as { deliver?: unknown } | null)?.deliver;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new RafError(`${file} : clé deliver absente`);
  const cfg = d as Record<string, unknown>;
  const bad = (what: string) => new RafError(`${file} : deliver.${what}`);

  let script: string | undefined;
  if (cfg.script !== undefined) {
    if (typeof cfg.script !== 'string' || !cfg.script.trim()) throw bad('script : commande non vide attendue');
    if (cfg.ci !== undefined || cfg.deploy !== undefined) throw bad('script remplace ci et deploy : garder l\'un ou les autres');
    script = cfg.script.trim();
  }

  let ci: DeliverConfig['ci'] = 'none';
  if (cfg.ci === 'github' || cfg.ci === 'none') ci = cfg.ci;
  else if (cfg.ci && typeof cfg.ci === 'object' && typeof (cfg.ci as { command?: unknown }).command === 'string') {
    ci = { command: (cfg.ci as { command: string }).command };
    if (!ci.command.trim()) throw bad('ci.command : commande vide');
  } else if (cfg.ci !== undefined) throw bad('ci : attendu github, none ou { command: "…" }');

  if (cfg.allowDirty !== undefined && typeof cfg.allowDirty !== 'boolean') throw bad('allowDirty : true ou false attendu');

  const seconds = (key: string, dflt: number) => {
    const v = cfg[key];
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !(v > 0)) throw bad(`${key} : nombre de secondes positif attendu`);
    return v;
  };

  const deploy = cfg.deploy === undefined ? [] : typeof cfg.deploy === 'string' ? [cfg.deploy] : cfg.deploy;
  if (!Array.isArray(deploy) || !deploy.every((c) => typeof c === 'string' && c.trim())) throw bad('deploy : liste de commandes non vides attendue');

  const verify = cfg.verify ?? [];
  // Avec un script de projet, les contrôles métier sont les siens : ceux de cadence deviennent facultatifs.
  if (!Array.isArray(verify) || (verify.length === 0 && script === undefined)) {
    throw bad('verify : au moins une vérification (une livraison se prouve par son effet)');
  }
  const checks = verify.map((v, i): VerifyCheck => {
    const where = `verify[${i + 1}]`;
    if (!v || typeof v !== 'object') throw bad(`${where} : { url } ou { command } attendu`);
    const { url, status, contains, command } = v as Record<string, unknown>;
    if ((url === undefined) === (command === undefined)) throw bad(`${where} : exactement un de url ou command`);
    if (command !== undefined) {
      if (typeof command !== 'string' || !command.trim()) throw bad(`${where}.command : commande non vide attendue`);
      return { command };
    }
    if (typeof url !== 'string') throw bad(`${where}.url : texte attendu`);
    if (status !== undefined && !Number.isInteger(status)) throw bad(`${where}.status : entier attendu`);
    if (contains !== undefined && typeof contains !== 'string') throw bad(`${where}.contains : texte attendu`);
    return { url, ...(status === undefined ? {} : { status: status as number }), ...(contains === undefined ? {} : { contains }) };
  });

  return {
    ci,
    ...(script === undefined ? {} : { script }),
    ...(cfg.allowDirty ? { allowDirty: true } : {}),
    ciTimeout: seconds('ciTimeout', 1800),
    deploy: deploy as string[],
    verify: checks,
    verifyTimeout: seconds('verifyTimeout', 300),
    deployTimeout: seconds('deployTimeout', 1800),
  };
}

/**
 * Dépendances réelles : sh, gh, fetch, horloge. `read` : le relevé des processus du suivi, `graceMs` : le délai de grâce
 * après Ctrl-C ou raccrochage, `pendingMs` : l'attente d'un signal encore en route après la sortie de la racine
 * (injectables pour les tests : sous charge, une grâce de 2 s se mesure mal).
 */
export function realDeps(
  root: string,
  read: typeof readProcs = readProcs,
  graceMs: number = SIGNAL_GRACE_MS,
  pendingMs: number = SIGNAL_PENDING_MS,
): DeliverDeps {
  const gh = (args: string[]) => {
    try {
      return execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GH_TIMEOUT });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string };
      if (err.code === 'ENOENT') throw new Error('gh introuvable (https://cli.github.com)');
      if (err.code === 'ETIMEDOUT') throw new Error(`gh sans réponse après ${GH_TIMEOUT / 1000} s`);
      throw new Error(String(err.stderr || err.message).trim().split('\n').slice(0, 3).join(' '));
    }
  };
  let output = '';
  return {
    lastOutput: () => outputTail(output),
    exec: (cmd, env, timeoutMs) =>
      new Promise((resolve) => {
        output = '';
        // Écoute posée AVANT spawn : un Ctrl-C reçu pendant la première lecture du suivi (synchrone, dans le
        // constructeur du TreeTracker) serait sinon traité par l'action par défaut, qui tue cadence sans nettoyer
        // l'arbre. Le nettoyage ne tourne qu'au tour de boucle suivant, quand `tree` existe.
        let tree: TreeTracker | null = null;
        // Terminaison en cours : exec ne rend pas la main avant qu'elle ne soit finie — sinon deliver libère
        // le verrou pendant la grâce, alors que des descendants tournent encore.
        let ending: Promise<void> | null = null;
        const forget = onTermination((sig) => {
          if (!tree) return; // commande jamais lancée : rien à nettoyer
          ending = sig === 'SIGTERM' ? Promise.resolve(tree.kill()) : tree.end(graceMs);
          return ending;
        });
        const child = spawn('sh', ['-c', cmd], {
          cwd: root,
          env: { ...process.env, ...env },
          // La sortie passe par cadence (recopiée à l'identique) pour que la raison d'un échec en garde la fin.
          stdio: ['ignore', 'pipe', 'pipe'],
          // PAS de groupe détaché : la commande reste dans le groupe de premier plan et la session de cadence.
          // Ctrl-C et le raccrochage l'atteignent avec cadence, et /dev/tty reste là pour ssh, sudo, pinentry.
        });
        const relay = (from: NodeJS.ReadableStream, to: NodeJS.WriteStream) =>
          from.on('data', (chunk: Buffer) => {
            to.write(chunk);
            output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEPT);
          });
        relay(child.stdout!, process.stdout);
        relay(child.stderr!, process.stderr);
        const pid = child.pid;
        if (pid === undefined) {
          child.once('error', () => {
            forget();
            resolve(127);
          });
          return;
        }
        // L'arbre de la commande est suivi pendant toute son exécution (relevé périodique, pid + heure de
        // démarrage) : un enfant dont le parent meurt reste connu. Au délai, ou si cadence est tué (Ctrl-C,
        // SIGTERM, raccrochage), TOUS les processus suivis encore vivants meurent avant que cadence ne rende la
        // main ou ne meure — sh fait un fork par commande, et un descendant survivant livrerait encore pendant
        // qu'une seconde livraison prend le verrou libéré ou périmé. Ctrl-C et raccrochage : l'arbre a déjà
        // reçu le signal du terminal, un court délai de grâce laisse finir ses trap (et git son index.lock)
        // avant le kill ; SIGTERM (à cadence seul) et le délai : kill immédiat.
        tree = new TreeTracker(
          pid,
          read,
          () =>
            process.stderr.write(
              'deliver : relevé des processus indisponible — le kill n\'est dégradé que tant que le relevé échoue : seule la commande racine sera tuée, ses descendants survivront\n',
            ),
          () =>
            process.stderr.write(
              'deliver : kill replié sur la commande racine faute de relevé des processus — des descendants ont pu survivre\n',
            ),
        );
        const tracker = tree;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          tracker.kill();
        }, Math.max(1_000, timeoutMs));
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          tracker.rootExited(); // son pid peut être repris : plus d'adoption tardive de la racine pendant la grâce
          const result = timedOut ? TIMED_OUT : signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
          const settle = () => {
            tracker.stop();
            forget();
            resolve(result);
          };
          // Un Ctrl-C part au groupe entier : la racine peut mourir et sa sortie être traitée avant que le SIGINT
          // adressé à cadence ne le soit. Retirer l'écoute à cet instant le perdrait (tracker.end jamais joué, un
          // descendant qui ignore SIGINT survivrait, un second Ctrl-C tuerait cadence sans libérer le verrou) : on
          // attend le signal en route, au plus pendantMs, tant que des processus suivis vivent OU que la racine est
          // elle-même morte d'un signal de terminaison (ou sortie 128 + ce signal) — curl tué par le Ctrl-C.
          const terminated = !timedOut && TERMINATION_SIGNALS.includes(result - 128);
          const deadline = Date.now() + pendingMs;
          const next = (): void => {
            if (ending) void ending.then(settle);
            else if ((!terminated && tracker.alive().length === 0) || Date.now() >= deadline) settle();
            else setTimeout(next, 20);
          };
          next();
        });
      }),
    gh: (sha) => JSON.parse(gh(['run', 'list', '--commit', sha, '--json', 'name,status,conclusion'])),
    ghReady: () => {
      try {
        gh(['auth', 'status']);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    fetch: async (url, timeoutMs = 20_000) => {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(Math.max(1_000, Math.min(20_000, timeoutMs))) });
      return { status: res.status, text: await res.text() };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

function substitute(text: string, sha: string): string {
  return text.replaceAll('${SHA}', sha).replaceAll('${SHORT}', sha.slice(0, 7));
}

/** Argument rendu tel quel au script par sh, quels que soient ses espaces, guillemets ou jokers. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function describeCheck(c: VerifyCheck, sha: string): string {
  if (c.command !== undefined) return c.command;
  return `GET ${substitute(c.url!, sha)} → ${c.status ?? 200}${c.contains === undefined ? '' : `, contient « ${substitute(c.contains, sha)} »`}`;
}

/** Livre HEAD. 0 livré, 1 étape en échec, 2 refus avant d'agir. */
export async function deliver(ctx: DeliverCtx, deps: DeliverDeps): Promise<number> {
  const { config, out, err } = ctx;
  const refuse = (msg: string) => {
    err(`deliver : ${msg}`);
    return 2;
  };

  const head0 = headSha(ctx.root);
  const sha = ctx.sha === undefined ? head0 : resolveCommit(ctx.root, ctx.sha);
  if (!sha) return refuse(ctx.sha === undefined ? 'aucun commit à livrer' : `--sha ${ctx.sha} : commit introuvable`);
  if (ctx.args.length && config.script === undefined) {
    return refuse('des arguments ne se passent qu\'à un script de projet (deliver.script dans cadence.yaml)');
  }
  const script = config.script === undefined ? null : [config.script, ...ctx.args.map(shellQuote)].join(' ');
  // --sha livre un commit poussé et ne lit pas l'arbre : un fichier modifié (le plan après raf done) n'y change rien.
  const repo = repoStatus(ctx.root);
  const dirty = ctx.sha === undefined ? repo.dirty : 0;
  if (dirty && !config.allowDirty) return refuse(`${dirty} fichier(s) suivi(s) modifié(s) : commiter et pousser d'abord`);
  if (dirty) err(`deliver : ${dirty} fichier(s) suivi(s) modifié(s) : non livré(s), seul ${sha.slice(0, 7)} l'est (allowDirty)`);
  if (!onRemote(ctx.root, sha)) return refuse(`${sha.slice(0, 7)} non poussé : la CI n'a rien construit (git push)`);
  const lock = readLock(ctx.state);
  if (lock && lockAlive(lock)) {
    return refuse(
      `livraison déjà en cours (${lock.sha.slice(0, 7)}, pid ${lock.pid}, depuis ${lock.started}) — jamais deux à la fois ; ` +
        `si ce processus n'est plus une livraison : rm ${lockPath(ctx.state)}`,
    );
  }
  if (config.ci === 'github' && !ctx.dryRun) {
    const why = deps.ghReady();
    if (why) return refuse(`ci: github exige gh authentifié — ${why}`);
  }

  // Un sha choisi n'est pas forcément sur la branche courante : ne pas lui en prêter une.
  const atHead = sha === head0;
  const branch = atHead ? (repo.branch ?? 'HEAD détachée') : 'sha choisi, antérieur ou étranger à la tête';
  const env = { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: atHead ? (repo.branch ?? '') : '' };
  if (ctx.dryRun) {
    out(`Livraison de ${env.CADENCE_SHORT} (${branch}) — simulation, rien n'est exécuté`);
    if (script !== null) {
      out(`  Script du projet : ${script}`);
      out(`    (CI, déploiement et contrôles métier sont les siens ; délai ${config.deployTimeout} s)`);
    } else {
      out(`  CI : ${typeof config.ci === 'string' ? config.ci : config.ci.command}${config.ci === 'none' ? '' : ` (délai ${config.ciTimeout} s)`}`);
      out('  Déploiement :');
      if (config.deploy.length === 0) out('    (aucune commande)');
      config.deploy.forEach((c, i) => out(`    ${i + 1}. ${c}`));
    }
    if (ctx.articles?.length) out(`  Articles rafraîchis après une livraison verte (lot « Article <projet> à rafraîchir ») : ${ctx.articles.map(describeArticle).join(', ')}`);
    if (config.verify.length) out(`  Vérifications (réessayées pendant ${config.verifyTimeout} s) :`);
    config.verify.forEach((c, i) => out(`    ${i + 1}. ${describeCheck(c, sha)}`));
    out(`  Variables : ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return 0;
  }

  if (lock && removeStaleLock(ctx.state, lock)) {
    err(`deliver : verrou périmé retiré (pid ${lock.pid} mort, ${lock.sha.slice(0, 7)})`);
  }
  let taken: boolean;
  try {
    taken = writeLock(ctx.state, { pid: process.pid, sha, started: new Date(deps.now()).toISOString() });
  } catch (e) {
    // Pas de liens physiques ici (EPERM, EMLINK…) : refus avec la cause, pas une exception qui sort de la commande.
    return refuse(lockFault(lockPath(ctx.state), e));
  }
  if (!taken) return refuse('une autre livraison vient de démarrer');
  try {
    const fail = (msg: string, cls: FailClass, tail: string[] = []) => {
      err(`deliver : ${msg}`);
      // Une livraison rouge s'inscrit au journal des rouges (perf) ; son écriture ne change ni le code ni le message d'échec.
      try {
        appendFailedDelivery(ctx.state, ctx.today, sha, msg, cls, tail);
      } catch (e) {
        err(`deliver : journal des livraisons rouges non écrit : ${(e as Error).message}`);
      }
      return 1;
    };
    out(`Livraison de ${env.CADENCE_SHORT} (${branch})`);

    let declared: string | null = null;
    if (script !== null) {
      out(`→ script du projet : ${script}`);
      // Le script qui déploie un autre commit que CADENCE_SHA y écrit son sha : cadence ne le devine pas.
      const file = join(ctx.state, `deployed-${process.pid}`);
      try {
        writeFileSync(file, '');
        const code = await deps.exec(script, { ...env, CADENCE_DEPLOYED_FILE: file }, config.deployTimeout * 1000);
        // Code 2 : le script a refusé avant d'agir (même convention que deliver) ; tout autre échec est un déploiement qui a cassé.
        if (code !== 0) return fail(`script de livraison en échec (${codeText(code)}) : ${script}`, code === 2 ? 'refus' : 'deploiement', deps.lastOutput?.());
        const text = readFileSync(file, 'utf8').trim();
        if (text !== '') {
          // Un sha seulement : HEAD ou une branche seraient résolus après le script, au commit d'un autre.
          declared = /^[0-9a-f]{7,40}$/i.test(text) ? resolveCommit(ctx.root, text) : null;
          if (declared === null) return fail(`CADENCE_DEPLOYED_FILE : « ${text.split('\n')[0].slice(0, 80)} » n'est pas un sha de commit du dépôt (le script doit y écrire le sha hexadécimal qu'il a déployé, ni HEAD ni une branche, ou rien)`, 'deploiement');
        }
      } catch (e) {
        return fail(`CADENCE_DEPLOYED_FILE illisible : ${(e as Error).message}`, 'deploiement');
      } finally {
        rmSync(file, { force: true });
      }
    } else {
      const ci = await waitCi(ctx, deps, sha, env);
      // Seule une commande de CI a une sortie : pour `ci: github`, lastOutput serait celle d'une commande antérieure.
      if (ci) return fail(ci, 'ci', typeof config.ci === 'object' ? deps.lastOutput?.() : []);

      for (const [i, cmd] of config.deploy.entries()) {
        out(`→ déploiement ${i + 1}/${config.deploy.length} : ${cmd}`);
        const code = await deps.exec(cmd, env, config.deployTimeout * 1000);
        if (code !== 0) return fail(`déploiement en échec (${codeText(code)}) : ${cmd}`, 'deploiement', deps.lastOutput?.());
      }
    }

    const failed = await verifyAll(ctx, deps, sha, env);
    if (failed) return fail(failed.message, 'verification', failed.tail);

    // Ce qui est journalisé : le sha que le script déclare (CADENCE_DEPLOYED_FILE) l'emporte. Sans déclaration, hors vague, un script qui a commité
    // pendant la livraison (horodatage d'une entrée Nouveautés) a livré la nouvelle tête ; pendant une vague on ne devine plus qui a commité
    // (le script, un lot en cours, un commit de plan) : le journal garde le sha de départ et l'avertissement le dit.
    let final = sha;
    let how: 'sha' | 'declared' | 'moved' = 'sha';
    if (declared !== null && declared !== sha) {
      final = declared;
      how = 'declared';
    } else if (declared === null && script !== null) {
      const head = headSha(ctx.root);
      if (ctx.duringWave) {
        if (head !== null && head !== head0) {
          err(`deliver : la tête a avancé pendant la livraison ; sans sha déclaré par le script (CADENCE_DEPLOYED_FILE), le journal garde ${env.CADENCE_SHORT}`);
        }
      } else if (atHead && head !== null && head !== sha && isAncestor(ctx.root, sha, head)) {
        final = head;
        how = 'moved';
      }
    }
    const ids = deliveredIds(ctx, lastDelivery(ctx.state), final);
    const delivered = deliveredLots(ctx, ids, lastDelivery(ctx.state), final);
    appendDelivery(ctx.state, ctx.today, final);
    if (how === 'declared') out(`✓ livré : ${final.slice(0, 7)} (sha déclaré par le script)`);
    else if (how === 'moved') out(`✓ livré : ${final.slice(0, 7)} (tête déplacée par le script depuis ${env.CADENCE_SHORT})`);
    else out(`✓ livré${config.verify.length ? ' et vérifié' : ''} : ${env.CADENCE_SHORT}`);
    if (delivered) out(delivered);
    refreshArticles(ctx, ids, final);
    return 0;
  } finally {
    releaseLock(ctx.state, process.pid);
  }
}

/** Message d'échec, ou null quand la CI est verte. */
async function waitCi(ctx: DeliverCtx, deps: DeliverDeps, sha: string, env: Record<string, string>): Promise<string | null> {
  const { ci, ciTimeout } = ctx.config;
  if (ci === 'none') return null;
  if (typeof ci === 'object') {
    ctx.out(`→ CI : ${ci.command}`);
    const code = await deps.exec(ci.command, env, ciTimeout * 1000);
    return code === 0 ? null : `CI en échec (${codeText(code)}) : ${ci.command}`;
  }
  ctx.out(`→ CI : attente des runs GitHub de ${sha.slice(0, 7)}`);
  const start = deps.now();
  let last = '';
  let failingSince: number | null = null;
  for (;;) {
    let runs: GhRun[] = [];
    let error: string | null = null;
    try {
      runs = deps.gh(sha);
      failingSince = null;
    } catch (e) {
      // Erreur passagère (réseau, quota d'API) : on réessaie ; persistante, on abandonne avec sa cause.
      error = (e as Error).message;
      failingSince ??= deps.now();
    }
    const elapsed = deps.now() - start;
    if (error !== null) {
      if (deps.now() - failingSince! >= CI_APPEAR || elapsed >= ciTimeout * 1000) return `gh run list en échec : ${error}`;
      ctx.err(`  gh run list en échec, nouvel essai : ${error}`);
    } else if (runs.length === 0) {
      if (elapsed >= CI_APPEAR) return `aucun run CI pour ce sha après ${CI_APPEAR / 60_000} min (le commit poussé est-il celui que la CI construit ?)`;
    } else {
      const pending = runs.filter((r) => r.status !== 'completed');
      const summary = `${runs.length} run(s), ${runs.length - pending.length} terminé(s)`;
      if (summary !== last) ctx.out(`  ${summary}`);
      last = summary;
      if (pending.length === 0) {
        const bad = runs.filter((r) => !CI_OK.has(r.conclusion));
        return bad.length ? `CI en échec : ${bad.map((r) => `${r.name} (${r.conclusion})`).join(', ')}` : null;
      }
    }
    if (elapsed >= ciTimeout * 1000) return `CI non terminée après ${ciTimeout} s`;
    await deps.sleep(POLL_CI);
  }
}

/** Un essai d'une vérification : cause de l'échec, ou null. Partagé par deliver et `cadence verify`. */
export async function tryCheck(c: VerifyCheck, deps: CheckDeps, sha: string, env: Record<string, string>, budgetMs: number): Promise<string | null> {
  if (c.command !== undefined) {
    const code = await deps.exec(c.command, env, budgetMs);
    return code === 0 ? null : codeText(code);
  }
  try {
    const res = await deps.fetch(substitute(c.url!, sha), budgetMs);
    const want = c.status ?? 200;
    if (res.status !== want) return `statut ${res.status} (attendu ${want})`;
    if (c.contains !== undefined && !res.text.includes(substitute(c.contains, sha))) return `« ${substitute(c.contains, sha)} » absent de la réponse`;
    return null;
  } catch (e) {
    return `erreur réseau : ${(e as Error).message}`;
  }
}

/**
 * UNE boucle de réessai, pour deliver et pour `cadence verify` : essaie, puis réessaie toutes les POLL_VERIFY
 * tant que `until` n'est pas atteint. `attemptMs()` donne le délai de chaque essai. Rend la dernière cause
 * d'échec, ou null dès que l'effet est celui attendu.
 */
export async function retryCheck(
  c: VerifyCheck,
  deps: CheckDeps,
  sha: string,
  env: Record<string, string>,
  until: number,
  attemptMs: () => number,
): Promise<string | null> {
  for (;;) {
    const reason = await tryCheck(c, deps, sha, env, attemptMs());
    if (reason === null) return null;
    const left = until - deps.now();
    if (left <= 0) return reason;
    // jamais au-delà du délai : une commande tuée « à l'échéance » peut rendre la main un rien avant elle
    await deps.sleep(Math.min(POLL_VERIFY, left));
  }
}

/** Chaque vérification est réessayée jusqu'au délai commun ; message d'échec ou null. */
async function verifyAll(ctx: DeliverCtx, deps: DeliverDeps, sha: string, env: Record<string, string>): Promise<{ message: string; tail: string[] } | null> {
  const deadline = deps.now() + ctx.config.verifyTimeout * 1000;
  for (const [i, c] of ctx.config.verify.entries()) {
    const label = describeCheck(c, sha);
    ctx.out(`→ vérification ${i + 1}/${ctx.config.verify.length} : ${label}`);
    const reason = await retryCheck(c, deps, sha, env, deadline, () => deadline - deps.now());
    if (reason !== null) return { message: `vérification en échec après ${ctx.config.verifyTimeout} s : ${label} — ${reason}`, tail: c.command !== undefined ? (deps.lastOutput?.() ?? []) : [] };
  }
  return null;
}

/**
 * Ligne des lots cités depuis la livraison précédente, ou null (première livraison, rien de cité).
 *
 * Plan en lecture seule : seuls les lots EN COURS sont annoncés. Ses identifiants sont de forme libre, et
 * un message cite volontiers un numéro qui en a la forme (réserve « R1 » d'une revue) ou un lot clos
 * nommé pour le contexte — les annoncer « livrés » ferait fermer à tort. L'état est celui du départ de
 * la livraison : le plan a été lu avant que le script du projet ne ferme lui-même les lots qu'il livre.
 */
/** Lots cités par les commits livrés depuis la livraison précédente ; vide quand elle est inconnue ou hors de l'historique. */
function deliveredIds(ctx: DeliverCtx, prev: string | null, sha: string): string[] {
  if (!ctx.plan || !prev || prev === sha || !isAncestor(ctx.root, prev, sha)) return [];
  const lots = ctx.plan.lots();
  const known = new Set((ctx.plan.readonly ? lots.filter((l) => l.status === 'doing') : lots).map((l) => l.id));
  const ids = new Set<string>();
  for (const c of readCommits(ctx.root, { range: `${prev}..${sha}` })) {
    if (isPlanOnly(c.sha, ctx.plan, ctx.root)) continue; // entretien du plan : ne livre rien, même s'il cite des lots
    for (const r of citedRefs(c, ctx.plan.refs)) if (known.has(r.lot)) ids.add(r.lot);
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function deliveredLots(ctx: DeliverCtx, ids: string[], prev: string | null, sha: string): string | null {
  if (!ctx.plan || !prev || prev === sha) return null;
  if (!isAncestor(ctx.root, prev, sha)) {
    return `livraison précédente (${prev.slice(0, 7)}) hors de l'historique de ${sha.slice(0, 7)} (réécrit ?) : lots livrés non calculés`;
  }
  if (ids.length === 0) return null;
  return `livré : ${ids.join(', ')} — ${ctx.plan.readonly ? "à fermer avec l'outil du projet" : 'raf done'} si l'effet est celui attendu`;
}

/**
 * Livraison verte (L144) : les lots livrés dont le titre est public changent ce que les articles externes racontent, on ouvre
 * donc le lot qui les rafraîchit. Hors vague le plan est écrit mais pas commité ; pendant une vague (L388) il est commité avec les fichiers que produit `plan.onWrite`, avec
 * le gabarit `plan.commit`, pour ne pas laisser le plan modifié dans l'arbre où une session de la vague travaille — sauf si le plan ou ces fichiers l'étaient
 * déjà avant l'écriture (le lead y a des modifications que ce commit emporterait). Une erreur ici ne défait pas une livraison déjà faite.
 */
function refreshArticles(ctx: DeliverCtx, ids: string[], sha: string): void {
  if (!ctx.plan || !ctx.articles?.length || !ids.length) return;
  try {
    // Relu : le script du projet a pu fermer des lots ou commiter le plan depuis le départ de la livraison, save() ne doit pas l'écraser.
    const plan = ctx.plan.reloaded();
    const planFile = relative(ctx.root, plan.path);
    const held = [planFile, ...plan.produced];
    const wasDirty = dirtyPaths(ctx.root, held).length > 0;
    const wanted = new Set(ids);
    const r = openArticleLots({
      plan,
      root: ctx.root,
      rules: ctx.articles,
      delivered: plan.lots().filter((l) => wanted.has(l.id)),
      publicTitle: ctx.publicTitle ?? ((l) => l.public),
      sha,
      today: ctx.today,
    });
    for (const w of r.warnings) ctx.err(`deliver : ${w}`);
    if (r.opened.length || r.noted.length) plan.save();
    const touched = [...r.opened, ...r.noted];
    let state = 'plan modifié, à commiter';
    if (touched.length && ctx.duringWave && wasDirty) {
      state = 'plan déjà modifié avant la livraison, non commité : à commiter avec vos modifications';
    } else if (touched.length && ctx.duringWave) {
      const message = planCommitMessage(ctx.planCommit, { lot: touched.join(', '), action: r.opened.length ? PLAN_ACTIONS.articleOpened : PLAN_ACTIONS.articleNoted, wave: ctx.waveId });
      try {
        state = `plan commité ${commitPaths(ctx.root, [planFile, ...dirtyPaths(ctx.root, plan.produced)], message)}`;
      } catch (e) {
        state = `commit du plan refusé (${(e as Error).message}), plan modifié, à commiter`;
      }
    }
    for (const id of r.opened) ctx.out(`article à rafraîchir : ${id} « ${plan.lot(id).title} » ouvert (${state}) — à jouer dans une vague ordinaire`);
    for (const id of r.noted) ctx.out(`article à rafraîchir : ${id} déjà ouvert, titres livrés ajoutés en note (${state})`);
    for (const m of r.manual) ctx.out(`article à rafraîchir : ${m}`);
  } catch (e) {
    ctx.err(`deliver : article à rafraîchir non ouvert — ${(e as Error).message}`);
  }
}
