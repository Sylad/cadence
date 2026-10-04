import { describeCheck, tryCheck, type DeliverConfig, type DeliverDeps, type VerifyCheck } from './deliver.js';

const POLL = 10_000;

export interface VerifyResult {
  label: string;
  /** Cause de l'échec ; null quand l'effet est celui attendu. */
  reason: string | null;
}

/**
 * Rejoue des vérifications d'effet : UNE passe par défaut ; avec `retryMs`, chacune est réessayée (toutes les
 * 10 s) jusqu'à ce délai. `budgetMs` borne l'ensemble : une commande est tuée, une requête abandonnée.
 * Le code d'une vérification est celui de deliver (tryCheck) : aucune règle n'est dupliquée.
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
  for (const c of checks) {
    const label = describeCheck(c, sha);
    const until = deps.now() + opts.retryMs;
    let reason: string | null;
    for (;;) {
      reason = await tryCheck(c, deps, sha, env, Math.max(1_000, overall - deps.now()));
      const left = until - deps.now();
      if (reason === null || left <= 0) break;
      await deps.sleep(Math.min(POLL, left));
    }
    results.push({ label, reason });
  }
  return results;
}

export const resultLine = (r: VerifyResult) => (r.reason === null ? `✓ ${r.label}` : `✗ ${r.label} — ${r.reason}`);

export function summaryLine(results: VerifyResult[]): string {
  const red = results.filter((r) => r.reason !== null).length;
  return red === 0
    ? `verify : ${results.length}/${results.length} vérifications vertes`
    : `verify : ${red} effet${red > 1 ? 's' : ''} rouge${red > 1 ? 's' : ''} sur ${results.length} vérification${results.length > 1 ? 's' : ''}`;
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

/** `cadence verify` : 0 tout vert, 1 un effet rouge, 2 rien à vérifier. */
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
  const results = await replayChecks(config.verify, deps, ctx.sha, verifyEnv(ctx.sha), { retryMs, budgetMs: 120_000 + retryMs });
  for (const r of results) out(resultLine(r));
  out(summaryLine(results));
  return results.some((r) => r.reason !== null) ? 1 : 0;
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
    const red = results.filter((r) => r.reason !== null);
    return red.length === 0 ? [`✓ ${summaryLine(results)}`] : [...red.map(resultLine), summaryLine(results)];
  } catch (e) {
    return [`✗ verify : ${(e as Error).message}`];
  }
}
