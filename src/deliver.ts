import { execFileSync, spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import type { Day } from './dates.js';
import { headSha, onRemote, readCommits, repoStatus } from './git.js';
import { extractRefs, RafError, type Plan } from './plan.js';
import { appendDelivery, lastDelivery, pidAlive, readLock, removeLock, writeLock } from './state.js';

export interface VerifyCheck {
  url?: string;
  status?: number;
  contains?: string;
  command?: string;
}

export interface DeliverConfig {
  ci: 'github' | 'none' | { command: string };
  /** Secondes. */
  ciTimeout: number;
  deploy: string[];
  verify: VerifyCheck[];
  /** Secondes pendant lesquelles les vérifications sont réessayées. */
  verifyTimeout: number;
}

export interface GhRun {
  name: string;
  status: string;
  conclusion: string;
}

export interface DeliverDeps {
  /** Commande sh à la racine du dépôt, variables ajoutées à l'environnement ; renvoie le code de sortie. */
  exec: (cmd: string, env: Record<string, string>) => number;
  gh: (sha: string) => GhRun[];
  fetch: (url: string) => Promise<{ status: number; text: string }>;
  sleep: (ms: number) => Promise<void>;
  /** Millisecondes. */
  now: () => number;
}

export interface DeliverCtx {
  root: string;
  state: string;
  plan: Plan | null;
  config: DeliverConfig;
  today: Day;
  dryRun: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

const POLL_CI = 15_000;
const CI_APPEAR = 300_000;
const POLL_VERIFY = 10_000;
const CI_OK = new Set(['success', 'skipped', 'neutral']);

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

  let ci: DeliverConfig['ci'] = 'none';
  if (cfg.ci === 'github' || cfg.ci === 'none') ci = cfg.ci;
  else if (cfg.ci && typeof cfg.ci === 'object' && typeof (cfg.ci as { command?: unknown }).command === 'string') {
    ci = { command: (cfg.ci as { command: string }).command };
  } else if (cfg.ci !== undefined) throw bad('ci : attendu github, none ou { command: "…" }');

  const seconds = (key: string, dflt: number) => {
    const v = cfg[key];
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !(v > 0)) throw bad(`${key} : nombre de secondes positif attendu`);
    return v;
  };

  const deploy = cfg.deploy === undefined ? [] : typeof cfg.deploy === 'string' ? [cfg.deploy] : cfg.deploy;
  if (!Array.isArray(deploy) || !deploy.every((c) => typeof c === 'string')) throw bad('deploy : liste de commandes attendue');

  const verify = cfg.verify ?? [];
  if (!Array.isArray(verify) || verify.length === 0) {
    throw bad('verify : au moins une vérification (une livraison se prouve par son effet)');
  }
  const checks = verify.map((v, i): VerifyCheck => {
    const where = `verify[${i + 1}]`;
    if (!v || typeof v !== 'object') throw bad(`${where} : { url } ou { command } attendu`);
    const { url, status, contains, command } = v as Record<string, unknown>;
    if ((url === undefined) === (command === undefined)) throw bad(`${where} : exactement un de url ou command`);
    if (command !== undefined) {
      if (typeof command !== 'string') throw bad(`${where}.command : texte attendu`);
      return { command };
    }
    if (typeof url !== 'string') throw bad(`${where}.url : texte attendu`);
    if (status !== undefined && !Number.isInteger(status)) throw bad(`${where}.status : entier attendu`);
    if (contains !== undefined && typeof contains !== 'string') throw bad(`${where}.contains : texte attendu`);
    return { url, ...(status === undefined ? {} : { status: status as number }), ...(contains === undefined ? {} : { contains }) };
  });

  return { ci, ciTimeout: seconds('ciTimeout', 1800), deploy: deploy as string[], verify: checks, verifyTimeout: seconds('verifyTimeout', 300) };
}

/** Dépendances réelles : sh, gh, fetch, horloge. */
export function realDeps(root: string): DeliverDeps {
  return {
    exec: (cmd, env) => spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] }).status ?? 1,
    gh: (sha) =>
      JSON.parse(
        execFileSync('gh', ['run', 'list', '--commit', sha, '--json', 'name,status,conclusion'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ),
    fetch: async (url) => {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      return { status: res.status, text: await res.text() };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

function substitute(text: string, sha: string): string {
  return text.replaceAll('${SHA}', sha).replaceAll('${SHORT}', sha.slice(0, 7));
}

function describeCheck(c: VerifyCheck, sha: string): string {
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

  const sha = headSha(ctx.root);
  if (!sha) return refuse('aucun commit à livrer');
  const repo = repoStatus(ctx.root);
  if (repo.dirty) return refuse(`${repo.dirty} fichier(s) suivi(s) modifié(s) : commiter et pousser d'abord`);
  if (!onRemote(ctx.root, sha)) return refuse(`${sha.slice(0, 7)} non poussé : la CI n'a rien construit (git push)`);
  const lock = readLock(ctx.state);
  if (lock && pidAlive(lock.pid)) {
    return refuse(`livraison déjà en cours (${lock.sha.slice(0, 7)}, pid ${lock.pid}, depuis ${lock.started}) — jamais deux à la fois`);
  }

  const env = { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: repo.branch };
  if (ctx.dryRun) {
    out(`Livraison de ${env.CADENCE_SHORT} (${repo.branch}) — simulation, rien n'est exécuté`);
    out(`  CI : ${typeof config.ci === 'string' ? config.ci : config.ci.command}${config.ci === 'none' ? '' : ` (délai ${config.ciTimeout} s)`}`);
    out('  Déploiement :');
    if (config.deploy.length === 0) out('    (aucune commande)');
    config.deploy.forEach((c, i) => out(`    ${i + 1}. ${c}`));
    out(`  Vérifications (réessayées pendant ${config.verifyTimeout} s) :`);
    config.verify.forEach((c, i) => out(`    ${i + 1}. ${describeCheck(c, sha)}`));
    out(`  Variables : ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return 0;
  }

  if (lock) {
    err(`deliver : verrou périmé retiré (pid ${lock.pid} mort, ${lock.sha.slice(0, 7)})`);
    removeLock(ctx.state);
  }
  if (!writeLock(ctx.state, { pid: process.pid, sha, started: new Date(deps.now()).toISOString() })) {
    return refuse('une autre livraison vient de démarrer');
  }
  try {
    const fail = (msg: string) => {
      err(`deliver : ${msg}`);
      return 1;
    };
    out(`Livraison de ${env.CADENCE_SHORT} (${repo.branch})`);

    const ci = await waitCi(ctx, deps, sha, env);
    if (ci) return fail(ci);

    for (const [i, cmd] of config.deploy.entries()) {
      out(`→ déploiement ${i + 1}/${config.deploy.length} : ${cmd}`);
      const code = deps.exec(cmd, env);
      if (code !== 0) return fail(`déploiement en échec (code ${code}) : ${cmd}`);
    }

    const failed = await verifyAll(ctx, deps, sha, env);
    if (failed) return fail(failed);

    const lots = deliveredLots(ctx, lastDelivery(ctx.state), sha);
    appendDelivery(ctx.state, ctx.today, sha);
    out(`✓ livré et vérifié : ${env.CADENCE_SHORT}`);
    if (lots.length) out(`livré : ${lots.join(', ')} — raf done si l'effet est celui attendu`);
    return 0;
  } finally {
    removeLock(ctx.state);
  }
}

/** Message d'échec, ou null quand la CI est verte. */
async function waitCi(ctx: DeliverCtx, deps: DeliverDeps, sha: string, env: Record<string, string>): Promise<string | null> {
  const { ci, ciTimeout } = ctx.config;
  if (ci === 'none') return null;
  if (typeof ci === 'object') {
    ctx.out(`→ CI : ${ci.command}`);
    const code = deps.exec(ci.command, env);
    return code === 0 ? null : `CI en échec (code ${code}) : ${ci.command}`;
  }
  ctx.out(`→ CI : attente des runs GitHub de ${sha.slice(0, 7)}`);
  const start = deps.now();
  let last = '';
  for (;;) {
    let runs: GhRun[];
    try {
      runs = deps.gh(sha);
    } catch (e) {
      return `gh run list impossible : ${(e as Error).message.split('\n')[0]}`;
    }
    const elapsed = deps.now() - start;
    if (runs.length === 0) {
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

async function tryCheck(c: VerifyCheck, deps: DeliverDeps, sha: string, env: Record<string, string>): Promise<string | null> {
  if (c.command !== undefined) {
    const code = deps.exec(c.command, env);
    return code === 0 ? null : `code ${code}`;
  }
  try {
    const res = await deps.fetch(substitute(c.url!, sha));
    const want = c.status ?? 200;
    if (res.status !== want) return `statut ${res.status} (attendu ${want})`;
    if (c.contains !== undefined && !res.text.includes(substitute(c.contains, sha))) return `« ${substitute(c.contains, sha)} » absent de la réponse`;
    return null;
  } catch (e) {
    return `erreur réseau : ${(e as Error).message}`;
  }
}

/** Chaque vérification est réessayée jusqu'au délai commun ; message d'échec ou null. */
async function verifyAll(ctx: DeliverCtx, deps: DeliverDeps, sha: string, env: Record<string, string>): Promise<string | null> {
  const deadline = deps.now() + ctx.config.verifyTimeout * 1000;
  for (const [i, c] of ctx.config.verify.entries()) {
    const label = describeCheck(c, sha);
    ctx.out(`→ vérification ${i + 1}/${ctx.config.verify.length} : ${label}`);
    for (;;) {
      const reason = await tryCheck(c, deps, sha, env);
      if (reason === null) break;
      if (deps.now() >= deadline) return `vérification en échec après ${ctx.config.verifyTimeout} s : ${label} — ${reason}`;
      await deps.sleep(POLL_VERIFY);
    }
  }
  return null;
}

/** Lots cités par les commits entre la livraison précédente et `sha` (rien à la première livraison). */
function deliveredLots(ctx: DeliverCtx, prev: string | null, sha: string): string[] {
  if (!ctx.plan || !prev || prev === sha) return [];
  const ids = new Set<string>();
  for (const c of readCommits(ctx.root, { range: `${prev}..${sha}` })) {
    for (const r of extractRefs(`${c.subject}\n${c.body}`, ctx.plan.prefix)) ids.add(r.lot);
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
