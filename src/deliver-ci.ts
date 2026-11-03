import { basename } from 'node:path';
import { isPlanOnly } from './audit.js';
import { isAncestor, readCommits } from './git.js';
import { appendStep, lastDeliveryFor } from './state.js';
import { declaredBlocks } from './deliver-blocks.js';
import type { DeliverCtx, DeliverDeps, GhRun } from './deliver.js';

const POLL_CI = 15_000;
const CI_APPEAR = 300_000;
const CI_OK = new Set(['success', 'skipped', 'neutral']);

/** « HH:MM:SS » UTC d'un instant en millisecondes : l'heure qui ouvre chaque ligne d'étape de la sortie. */
const clockTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
export const stamped = (deps: Pick<DeliverDeps, 'now'>, line: string): string => `${clockTime(deps.now())} ${line}`;

/**
 * Livraison précédente quand la CI du sha n'a pas à être attendue : un seul fichier hors plan dans précédente..sha suffit à
 * l'exiger. Null (CI attendue) sans plan, sans livraison précédente, si elle n'est pas un ancêtre du sha ou l'égale, si elle n'est pas un sha complet (ligne du journal écrite à la main), si la
 * lecture échoue ou rend aucun commit : on ne saute la CI que sur une preuve (au moins un commit, tous plan seul).
 */
export function planOnlySince(ctx: DeliverCtx, sha: string): string | null {
  if (!ctx.plan) return null;
  const prev = lastDeliveryFor(ctx.state, ctx.block, declaredBlocks(ctx.config));
  if (!prev || !/^[0-9a-f]{40,64}$/.test(prev) || prev === sha || !isAncestor(ctx.root, prev, sha)) return null;
  try {
    const commits = readCommits(ctx.root, { range: `${prev}..${sha}` });
    return commits.length > 0 && commits.every((c) => isPlanOnly(c.sha, ctx.plan!, ctx.root)) ? prev : null;
  } catch {
    return null;
  }
}

interface PollState {
  summary: string;
  failingSince: number | null;
}

/** Un tour de `gh run list` : message d'échec, null si tous les runs sont verts, undefined tant qu'il faut attendre. */
function pollOnce(ctx: DeliverCtx, deps: DeliverDeps, sha: string, start: number, state: PollState): string | null | undefined {
  let runs: GhRun[] = [];
  let error: string | null = null;
  try {
    runs = deps.gh(sha);
    state.failingSince = null;
  } catch (e) {
    // Erreur passagère (réseau, quota d'API) : on réessaie ; persistante, on abandonne avec sa cause.
    error = (e as Error).message;
    state.failingSince ??= deps.now();
  }
  const elapsed = deps.now() - start;
  if (error !== null) {
    if (deps.now() - state.failingSince! >= CI_APPEAR || elapsed >= ctx.config.ciTimeout * 1000) return `gh run list en échec : ${error}`;
    ctx.err(`  gh run list en échec, nouvel essai : ${error}`);
    return undefined;
  }
  if (runs.length === 0) {
    return elapsed >= CI_APPEAR ? `aucun run CI pour ce sha après ${CI_APPEAR / 60_000} min (le commit poussé est-il celui que la CI construit ?)` : undefined;
  }
  const pending = runs.filter((r) => r.status !== 'completed');
  const summary = `${runs.length} run(s), ${runs.length - pending.length} terminé(s)`;
  if (summary !== state.summary) ctx.out(`  ${summary}`);
  state.summary = summary;
  if (pending.length > 0) return undefined;
  const bad = runs.filter((r) => !CI_OK.has(r.conclusion));
  return bad.length ? `CI en échec : ${bad.map((r) => `${r.name} (${r.conclusion})`).join(', ')}` : null;
}

/** Message d'échec, ou null quand les runs GitHub du sha sont tous verts. */
export async function pollGithubCi(ctx: DeliverCtx, deps: DeliverDeps, sha: string): Promise<string | null> {
  const { ciTimeout } = ctx.config;
  ctx.out(stamped(deps, `→ CI : attente des runs GitHub de ${sha.slice(0, 7)}`));
  const start = deps.now();
  const state: PollState = { summary: '', failingSince: null };
  for (;;) {
    const verdict = pollOnce(ctx, deps, sha, start, state);
    if (verdict !== undefined) return verdict;
    if (deps.now() - start >= ciTimeout * 1000) return `CI non terminée après ${ciTimeout} s`;
    await deps.sleep(POLL_CI);
  }
}

/**
 * Journal des étapes (L516) : `step(etape, debut, ok)` ajoute une ligne à `deliveries-steps.log`. Une mesure, jamais bloquante :
 * une écriture qui échoue est signalée une seule fois, la livraison continue. `lots` n'est lu qu'à la première écriture.
 */
export function stepJournal(ctx: DeliverCtx, deps: Pick<DeliverDeps, 'now'>, sha: string, lots: () => string[]) {
  let known: string[] | null = null;
  let warned = false;
  return (etape: string, debut: number, ok: boolean): void => {
    try {
      const fin = deps.now();
      appendStep(ctx.state, {
        lots: (known ??= lots()),
        sha,
        projet: ctx.plan?.project || basename(ctx.root),
        etape,
        debut: new Date(debut).toISOString(),
        fin: new Date(fin).toISOString(),
        duree_s: Math.round((fin - debut) / 1000),
        resultat: ok ? 'ok' : 'echec',
      });
    } catch (e) {
      if (!warned) ctx.err(`deliver : journal des étapes non écrit : ${(e as Error).message}`);
      warned = true;
    }
  };
}
