import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isAncestor, onRemote, resolveCommit } from './git.js';
import { previousDelivery } from './deliver-blocks.js';
import { announceDelivered, type CheckDeps, type DeliverConfig, type DeliveredCtx } from './deliver.js';
import { RafError } from './plan.js';
import { appendDelivery, lockAlive, readDeliveryLines, readFailedEntries, readLock } from './state.js';
import { replayChecks, resultLine } from './verify.js';
import { isObject, readYamlKey } from './yaml-keys.js';

/**
 * Livraison constatée (L718) : le code d'un sha est déjà en production, déployé sans `cadence deliver` (le script du projet lancé à la main,
 * un pipeline GitOps). `cadence deliver --constat [<sha>]` l'inscrit au journal des livraisons sans rien déployer, pour que le tour et le panneau
 * ne comptent plus ses lots comme « clos non livrés » et qu'une livraison rouge antérieure cesse d'être la dernière.
 */
interface ConstatCtx extends DeliveredCtx {
  /** État commun à tous les worktrees : verrou et journal des livraisons. */
  state: string;
  config: DeliverConfig;
  /** Commande `deliver.deployed` : elle écrit le sha réellement déployé (sa dernière ligne non vide) ; absente sans la clé. */
  deployed?: string;
  /** Le sha constaté tel que donné (toute révision) ; absent : celui que dit `deliver.deployed`. */
  sha?: string;
  dryRun: boolean;
}

export interface ConstatDeps extends CheckDeps {
  /** Lance la commande `deliver.deployed` à la racine du dépôt ; rend sa sortie standard, lève une erreur au message utile si elle échoue. */
  deployed: (cmd: string, timeoutMs: number) => string;
}

/** Délai de la commande `deliver.deployed` et de chaque vérification : un constat lit l'état, il ne l'attend pas. */
const CONSTAT_MS = 120_000;

/** Un refus du constat : le message et le code de sortie (2 avant d'agir, 1 constat non établi). */
class Refus extends Error {
  constructor(message: string, readonly code: 1 | 2 = 2) {
    super(message);
  }
}

/** La clé `deliver.deployed` de cadence.yaml (L718) : une commande non vide, ou absente. */
export function readDeployed(configPath: string): string | undefined {
  const d = readYamlKey(configPath, 'deliver');
  const v = isObject(d) ? d.deployed : undefined;
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new RafError(`${configPath} : deliver.deployed : commande non vide attendue (elle écrit le sha déployé)`);
  return v.trim();
}

export function realConstatDeps(root: string, checks: CheckDeps): ConstatDeps {
  return {
    ...checks,
    deployed: (cmd, timeoutMs) => {
      try {
        return execFileSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { stderr?: string; status?: number | null };
        const why = String(err.stderr ?? '').trim().split('\n').at(-1) || err.message.split('\n')[0];
        throw new Error(err.code === 'ETIMEDOUT' ? `sans réponse après ${timeoutMs / 1000} s` : `code ${err.status ?? '?'} : ${why}`);
      }
    },
  };
}

/** Le sha que dit `deliver.deployed` : la dernière ligne non vide de sa sortie, un sha hexadécimal du dépôt (HEAD ou une branche désigneraient la tête locale, pas ce qui tourne). */
function deployedSha(ctx: ConstatCtx, cmd: string, deps: ConstatDeps): string {
  let stdout: string;
  try {
    stdout = deps.deployed(cmd, CONSTAT_MS);
  } catch (e) {
    throw new Refus(`deliver.deployed en échec (${(e as Error).message}) : ${cmd}`, 1);
  }
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  if (line === '') throw new Refus('deliver.deployed : sortie vide (elle doit écrire le sha déployé)', 1);
  const sha = /^[0-9a-f]{7,40}$/i.test(line) ? resolveCommit(ctx.root, line) : null;
  if (!sha) throw new Refus(`deliver.deployed : « ${line.slice(0, 80)} » n'est pas un sha de commit du dépôt`, 1);
  return sha;
}

/** Le sha constaté, et s'il est confirmé par `deliver.deployed` : la source sans sha donné, un témoin qui doit concorder sinon. */
function observedSha(ctx: ConstatCtx, deps: ConstatDeps): { sha: string; confirmed: boolean } {
  if (ctx.sha === undefined && ctx.deployed === undefined) {
    throw new Refus('donner le sha déployé (cadence deliver --constat <sha>) ou déclarer deliver.deployed dans cadence.yaml (une commande qui l\'écrit)');
  }
  const given = ctx.sha === undefined ? null : resolveCommit(ctx.root, ctx.sha);
  if (ctx.sha !== undefined && !given) throw new Refus(`${ctx.sha} : commit introuvable`);
  if (ctx.deployed === undefined) return { sha: given!, confirmed: false };
  const seen = deployedSha(ctx, ctx.deployed, deps);
  if (given && given !== seen) throw new Refus(`deliver.deployed dit ${seen.slice(0, 7)} déployé, pas ${given.slice(0, 7)} : rien n'est inscrit`, 1);
  return { sha: seen, confirmed: true };
}

/** La dernière livraison est rouge : le journal des rouges est plus récent que le vert (la règle du panneau). Son sha, ou null. */
function lastRed(state: string): string | null {
  const red = readFailedEntries(state).at(-1);
  if (!red) return null;
  try {
    const at = (f: string) => statSync(join(state, f)).mtimeMs;
    if (readDeliveryLines(state).length > 0 && at('deliveries.log') >= at('deliveries-failed.log')) return null;
  } catch {
    // journal vert absent : la rouge est la dernière
  }
  return red.sha;
}

/** Ce qui interdit d'inscrire `sha` : pas poussé, une livraison en cours, ou déjà couvert par la dernière livraison verte (`prev`). */
function guard(ctx: ConstatCtx, sha: string, prev: string | null): void {
  const short = sha.slice(0, 7);
  if (!onRemote(ctx.root, sha)) throw new Refus(`${short} non poussé : un code déployé vient d'un sha poussé (git push), rien n'est inscrit`);
  const lock = readLock(ctx.state);
  if (lock && lockAlive(lock)) throw new Refus(`livraison en cours (${lock.sha.slice(0, 7)}, pid ${lock.pid}) : elle écrira elle-même le journal`);
  if (prev !== null && prev !== sha && isAncestor(ctx.root, sha, prev)) {
    throw new Refus(`${short} est antérieur à la dernière livraison (${prev.slice(0, 7)}) : déjà couvert, rien n'est inscrit`);
  }
}

/** `deliver.verify` rejoué une fois au sha constaté ; refus quand un effet est rouge. */
async function checkEffect(ctx: ConstatCtx, sha: string, deps: ConstatDeps): Promise<void> {
  const env = { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: '' };
  const results = await replayChecks(ctx.config.verify, deps, sha, env, { retryMs: 0, attemptMs: CONSTAT_MS });
  for (const r of results) ctx.out(resultLine(r));
  if (results.some((r) => r.reason !== null)) throw new Refus(`l'effet de ${sha.slice(0, 7)} n'est pas constaté (vérification rouge) : rien n'est inscrit`, 1);
}

const proofsOf = (confirmed: boolean, checks: number): string =>
  [
    'poussé',
    ...(confirmed ? ['confirmé par deliver.deployed'] : []),
    checks === 0 ? 'aucune vérification déclarée (deliver.verify)' : `${checks} vérification${checks > 1 ? 's vertes' : ' verte'}`,
  ].join(', ');

/** `cadence deliver --constat` : 0 inscrit (ou déjà au journal), 1 constat non établi (deliver.deployed en échec ou contraire, vérification rouge), 2 refus avant d'agir. */
export async function constat(ctx: ConstatCtx, deps: ConstatDeps): Promise<number> {
  try {
    const { sha, confirmed } = observedSha(ctx, deps);
    const prev = previousDelivery({ state: ctx.state, block: ctx.block, config: ctx.config });
    guard(ctx, sha, prev);
    const red = lastRed(ctx.state);
    if (prev === sha && red === null) {
      ctx.out(`deliver --constat : ${sha.slice(0, 7)} est déjà la dernière livraison du journal, rien à inscrire`);
      return 0;
    }
    if (ctx.config.verify.length > 0) await checkEffect(ctx, sha, deps);
    record(ctx, { sha, prev, red, proofs: proofsOf(confirmed, ctx.config.verify.length), unproven: !confirmed && ctx.config.verify.length === 0 });
    return 0;
  } catch (e) {
    if (!(e instanceof Refus)) throw e;
    ctx.err(`deliver --constat : ${e.message}`);
    return e.code;
  }
}

/** La ligne verte écrite (ou simulée), puis ce que suit toute livraison verte : lots annoncés et marqués livrés, article à rafraîchir. */
function record(ctx: ConstatCtx, r: { sha: string; prev: string | null; red: string | null; proofs: string; unproven: boolean }): void {
  const what = `${r.sha.slice(0, 7)}${ctx.block === undefined ? '' : ` (bloc ${ctx.block})`}`;
  if (ctx.dryRun) {
    ctx.out(`deliver --constat : ${what} serait inscrit au journal des livraisons, rien n'est déployé — ${r.proofs} (simulation, rien n'est écrit)`);
    return;
  }
  if (r.unproven) ctx.err('deliver --constat : inscrit sur votre parole (ni deliver.deployed ni deliver.verify ne le prouvent)');
  appendDelivery(ctx.state, ctx.today, r.sha, ctx.block);
  ctx.out(`✓ constat : ${what} inscrit au journal des livraisons, rien n'est déployé — ${r.proofs}`);
  if (r.red !== null) ctx.out(`  la livraison rouge de ${r.red.slice(0, 7)} n'est plus la dernière : le panneau dit la livraison verte`);
  announceDelivered({ ...ctx, config: { blocks: ctx.config.blocks } }, r.prev, r.sha);
}
