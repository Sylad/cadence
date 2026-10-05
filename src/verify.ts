import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { headSha, repoStatus, upstreamHead } from './git.js';
import { lastDelivery, sharedStateDir } from './state.js';
import { onTermination } from './proc.js';
import { describeCheck, realDeps, retryCheck, TIMED_OUT, type CheckDeps, type DeliverConfig, type VerifyCheck } from './deliver.js';

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // groupe déjà vide
  }
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
    // Ctrl-C, SIGTERM ou raccrochage reçu par cadence : relayé au groupe avant de sortir.
    const forget = onTermination((sig) => killGroup(pgid, sig));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(pgid, 'SIGKILL');
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      forget();
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

/**
 * Sha attendu par les vérifications (${SHA} / ${SHORT}) et note éventuelle pour le compte rendu.
 * - Avec une commande ou un script de livraison : la dernière livraison, à défaut la tête (inchangé).
 * - Sans aucun des deux, la livraison EST le push (Cloudflare Pages construit chaque push, plan compris) :
 *   la tête de la branche amont suivie (état local de la référence, aucun réseau). Des commits locaux non
 *   poussés ne changent pas ce sha mais sont dits dans la note : l'effet vérifié est celui de l'amont.
 * - Sans amont : repli sur la dernière livraison, à défaut la tête.
 */
export function expectedTarget(root: string, config: DeliverConfig, last: string | null): { sha: string; note: string | null } {
  const fallback = last ?? headSha(root) ?? '';
  if (config.script !== undefined || config.deploy.length > 0) return { sha: fallback, note: null };
  const up = upstreamHead(root);
  if (!up) return { sha: fallback, note: null };
  const ahead = repoStatus(root).ahead;
  return { sha: up.sha, note: ahead > 0 ? `${ahead} commit(s) non poussé(s) — l'effet vérifié est celui de ${up.ref}` : null };
}

/** Sha attendu de la reprise et de `cadence verify` sans --sha. */
export const defaultTarget = (root: string, config: DeliverConfig) => expectedTarget(root, config, lastDelivery(sharedStateDir(root)));

export interface VerifyCtx {
  config: DeliverConfig;
  /** Sha qui remplace ${SHA} / ${SHORT} (voir expectedTarget). */
  sha: string;
  /** Ligne d'information (commits non poussés), affichée avant les résultats. */
  note?: string | null;
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
  if (ctx.note) out(ctx.note);
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
export async function effectLines(config: DeliverConfig, sha: string, deps: CheckDeps, note: string | null = null): Promise<string[]> {
  if (config.verify.length === 0) return [];
  const head = note ? [note] : [];
  try {
    const results = await replayChecks(config.verify, deps, sha, verifyEnv(sha), { retryMs: 0, attemptMs: MORNING_BUDGET_MS });
    const shown = results.filter((r) => r.reason !== null);
    return shown.length === 0 ? [...head, `✓ ${summaryLine(results)}`] : [...head, ...shown.map(resultLine), summaryLine(results)];
  } catch (e) {
    return [...head, `✗ verify : ${(e as Error).message}`];
  }
}
