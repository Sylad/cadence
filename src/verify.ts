import { describeCheck, retryCheck, type DeliverConfig, type DeliverDeps, type VerifyCheck } from './deliver.js';

export interface VerifyResult {
  label: string;
  /** Cause de l'échec (ou du non-essai) ; null quand l'effet est celui attendu. */
  reason: string | null;
  /** Budget global épuisé avant son tour : ni vert ni rouge — l'effet n'a pas été regardé. */
  unverified?: boolean;
}

/**
 * Rejoue des vérifications d'effet : UNE passe par défaut ; avec `retryMs`, chacune est réessayée (toutes les
 * POLL_VERIFY) jusqu'à ce délai. `budgetMs` borne l'ensemble. Chaque essai reçoit sa PART du budget restant
 * (restant ÷ vérifications à passer) : une lente est tuée à sa part, elle ne mange pas celle des suivantes.
 * Budget épuisé avant son tour, une vérification est « non vérifiée » (jamais rouge).
 * Le code d'une vérification est celui de deliver (tryCheck/retryCheck) : aucune règle n'est dupliquée.
 */
export async function replayChecks(
  checks: VerifyCheck[],
  deps: DeliverDeps,
  sha: string,
  env: Record<string, string>,
  opts: { retryMs: number; budgetMs: number },
): Promise<VerifyResult[]> {
  const overall = deps.now() + opts.budgetMs;
  const results: VerifyResult[] = [];
  for (const [i, c] of checks.entries()) {
    const label = describeCheck(c, sha);
    if (overall - deps.now() <= 0) {
      results.push({ label, reason: 'budget de temps épuisé avant son tour', unverified: true });
      continue;
    }
    const share = () => Math.max(1_000, (overall - deps.now()) / (checks.length - i));
    const until = Math.min(deps.now() + opts.retryMs, overall);
    results.push({ label, reason: await retryCheck(c, deps, sha, env, until, share) });
  }
  return results;
}

export const resultLine = (r: VerifyResult) =>
  r.unverified ? `? ${r.label} — non vérifiée (${r.reason})` : r.reason === null ? `✓ ${r.label}` : `✗ ${r.label} — ${r.reason}`;

/** Rouge = essayée et en échec ; une non vérifiée n'est pas rouge. */
export const isRed = (r: VerifyResult) => r.reason !== null && !r.unverified;

export function summaryLine(results: VerifyResult[]): string {
  const red = results.filter(isRed).length;
  const unverified = results.filter((r) => r.unverified).length;
  const n = results.length;
  const plural = (k: number, w: string) => `${k} ${w}${k > 1 ? 's' : ''}`;
  if (unverified > 0) {
    return `verify : ${unverified} non vérifiée${unverified > 1 ? 's' : ''} sur ${plural(n, 'vérification')} (budget épuisé), ${red} effet${red > 1 ? 's' : ''} rouge${red > 1 ? 's' : ''}`;
  }
  return red === 0
    ? `verify : ${n}/${n} vérifications vertes`
    : `verify : ${red} effet${red > 1 ? 's' : ''} rouge${red > 1 ? 's' : ''} sur ${plural(n, 'vérification')}`;
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

/** `cadence verify` : 0 tout vert, 1 un effet rouge, 2 rien à vérifier, 3 budget épuisé (aucun rouge, mais des non vérifiées). */
export async function verifyCommand(ctx: VerifyCtx, deps: DeliverDeps): Promise<number> {
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
  const retryMs = ctx.retry * 1000;
  const results = await replayChecks(config.verify, deps, ctx.sha, verifyEnv(ctx.sha), { retryMs, budgetMs: 120_000 + retryMs * config.verify.length });
  for (const r of results) out(resultLine(r));
  out(summaryLine(results));
  if (results.some(isRed)) return 1;
  return results.some((r) => r.unverified) ? 3 : 0;
}

/** Délai total des vérifications de « session start » : la reprise ne doit pas attendre un réseau absent. */
export const MORNING_BUDGET_MS = 10_000;

/**
 * Lignes « Effets en production » du rapport de reprise : un seul essai par vérification, borné. Rien à dire
 * (liste vide) pour un projet sans verify ; ne lève jamais — c'est un fait de plus, pas une condition.
 */
export async function effectLines(config: DeliverConfig, sha: string, deps: DeliverDeps): Promise<string[]> {
  if (config.verify.length === 0) return [];
  try {
    const results = await replayChecks(config.verify, deps, sha, verifyEnv(sha), { retryMs: 0, budgetMs: MORNING_BUDGET_MS });
    const shown = results.filter((r) => r.reason !== null);
    return shown.length === 0 ? [`✓ ${summaryLine(results)}`] : [...shown.map(resultLine), summaryLine(results)];
  } catch (e) {
    return [`✗ verify : ${(e as Error).message}`];
  }
}
