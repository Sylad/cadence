import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { describeCheck, realDeps, retryCheck, TIMED_OUT, type CheckDeps, type DeliverConfig, type VerifyCheck } from './deliver.js';

/** Groupes des vérifications en cours : cadence leur relaie Ctrl-C, SIGTERM et le raccrochage avant de sortir. */
const groups = new Set<number>();
const RELAYED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // groupe déjà vide
  }
}

function relay(sig: NodeJS.Signals): void {
  for (const pgid of groups) killGroup(pgid, sig);
  groups.clear();
  for (const s of RELAYED) process.removeListener(s, relay);
  process.kill(process.pid, sig); // puis sortie comme sans relais : tué par le même signal
}

function track(pgid: number): void {
  if (groups.size === 0) for (const s of RELAYED) process.on(s, relay);
  groups.add(pgid);
}

function untrack(pgid: number): void {
  groups.delete(pgid);
  if (groups.size === 0) for (const s of RELAYED) process.removeListener(s, relay);
}

/**
 * Une commande de vérification, en groupe de processus détaché (nouvelle session, sans tty) : au délai,
 * TOUT le groupe est tué (aucun enfant orphelin) ; un signal reçu par cadence lui est relayé. Asynchrone :
 * les vérifications tournent en parallèle. Réservé aux vérifications (verify, session start) — jamais
 * aux commandes de deliver, qui gardent le groupe de premier plan et le tty.
 */
function execGroup(root: string, cmd: string, env: Record<string, string>, timeoutMs: number, quiet: boolean): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    const pgid = child.pid;
    if (pgid === undefined) {
      child.once('error', () => resolve(127));
      return;
    }
    track(pgid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(pgid, 'SIGKILL');
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      untrack(pgid);
      if (timedOut) killGroup(pgid, 'SIGKILL'); // sh mort avant ses enfants : le groupe est vidé quand même
      resolve(timedOut ? TIMED_OUT : signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
    });
  });
}

/** Dépendances réelles des vérifications. `quiet` : sortie des commandes non relayée (rapport de session start). */
export function realCheckDeps(root: string, opts: { quiet?: boolean } = {}): CheckDeps {
  const { fetch, sleep, now } = realDeps(root);
  return { fetch, sleep, now, exec: (cmd, env, timeoutMs) => execGroup(root, cmd, env, timeoutMs, !!opts.quiet) };
}

export interface VerifyResult {
  label: string;
  /** Cause de l'échec ; null quand l'effet est celui attendu. */
  reason: string | null;
}

/**
 * Rejoue des vérifications d'effet, TOUTES EN PARALLÈLE : chaque essai reçoit le budget entier
 * (`attemptMs`, tuée au-delà : « délai dépassé »), une vérification lente ne prend rien aux autres.
 * UNE passe par défaut ; avec `retryMs`, chacune est réessayée de son côté (toutes les POLL_VERIFY)
 * jusqu'à ce délai. Durée totale bornée par retryMs + attemptMs. Résultats dans l'ordre des vérifications.
 * Le code d'une vérification est celui de deliver (tryCheck/retryCheck) : aucune règle n'est dupliquée.
 */
export async function replayChecks(
  checks: VerifyCheck[],
  deps: CheckDeps,
  sha: string,
  env: Record<string, string>,
  opts: { retryMs: number; attemptMs: number },
): Promise<VerifyResult[]> {
  const until = deps.now() + opts.retryMs;
  return Promise.all(
    checks.map(async (c) => ({ label: describeCheck(c, sha), reason: await retryCheck(c, deps, sha, env, until, () => opts.attemptMs) })),
  );
}

export const resultLine = (r: VerifyResult) => (r.reason === null ? `✓ ${r.label}` : `✗ ${r.label} — ${r.reason}`);

export function summaryLine(results: VerifyResult[]): string {
  const red = results.filter((r) => r.reason !== null).length;
  const n = results.length;
  return red === 0
    ? `verify : ${n}/${n} vérifications vertes`
    : `verify : ${red} effet${red > 1 ? 's' : ''} rouge${red > 1 ? 's' : ''} sur ${n} vérification${n > 1 ? 's' : ''}`;
}

/** Variables passées aux commandes de vérification, comme à celles de deliver. */
export function verifyEnv(sha: string): Record<string, string> {
  return { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: '' };
}

export interface VerifyCtx {
  config: DeliverConfig;
  /** Sha qui remplace ${SHA} / ${SHORT} : la dernière livraison, à défaut la tête. */
  sha: string;
  /** Secondes de réessai ; 0 = une seule passe. */
  retry: number;
  out: (line: string) => void;
}

/** Délai de chaque essai d'une vérification de `cadence verify`. */
export const VERIFY_ATTEMPT_MS = 120_000;

/** `cadence verify` : 0 tout vert, 1 un effet rouge, 2 rien à vérifier. */
export async function verifyCommand(ctx: VerifyCtx, deps: CheckDeps): Promise<number> {
  const { config, out } = ctx;
  if (config.verify.length === 0) {
    out(
      config.script !== undefined
        ? 'verify : aucune vérification déclarée — ce projet livre par son script (deliver.script) et ses contrôles sont les siens ; ' +
            'déclarer deliver.verify dans cadence.yaml pour les rejouer hors livraison'
        : 'verify : aucune vérification déclarée (deliver.verify)',
    );
    return 2;
  }
  const results = await replayChecks(config.verify, deps, ctx.sha, verifyEnv(ctx.sha), { retryMs: ctx.retry * 1000, attemptMs: VERIFY_ATTEMPT_MS });
  for (const r of results) out(resultLine(r));
  out(summaryLine(results));
  return results.some((r) => r.reason !== null) ? 1 : 0;
}

/**
 * Délai de chaque vérification de « session start », lancées en parallèle : c'est aussi, à la mise à mort
 * près, la durée totale — la reprise ne doit pas attendre un réseau absent.
 */
export const MORNING_BUDGET_MS = 10_000;

/**
 * Lignes « Effets en production » du rapport de reprise : un seul essai par vérification, borné. Rien à dire
 * (liste vide) pour un projet sans verify ; ne lève jamais — c'est un fait de plus, pas une condition.
 */
export async function effectLines(config: DeliverConfig, sha: string, deps: CheckDeps): Promise<string[]> {
  if (config.verify.length === 0) return [];
  try {
    const results = await replayChecks(config.verify, deps, sha, verifyEnv(sha), { retryMs: 0, attemptMs: MORNING_BUDGET_MS });
    const shown = results.filter((r) => r.reason !== null);
    return shown.length === 0 ? [`✓ ${summaryLine(results)}`] : [...shown.map(resultLine), summaryLine(results)];
  } catch (e) {
    return [`✗ verify : ${(e as Error).message}`];
  }
}
