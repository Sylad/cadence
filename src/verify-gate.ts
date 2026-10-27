import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { OrchestrateConfig, VerifyConfig } from './config.js';
import { onTermination } from './proc.js';
import { failedTests, hasUnnamedFailure, unloadedSuites } from './orchestrate/baseline.js';
import { configuredCap } from './orchestrate/command.js';
import { replayRed, TEST_WORKERS_ENV, testWorkersFrom } from './orchestrate/workers.js';
import { copyDeps, git, gitFailure, ignoredDeps, linkIgnored } from './orchestrate/worktree.js';

/** Délai de chaque commande de la porte : celui du rejeu de la ligne de base de la vague. */
const GATE_TIMEOUT_MS = 30 * 60_000;

/** Lignes de la fin de la sortie montrées quand aucun test n'est identifiable dans une sortie rouge. */
const TAIL_LINES = 10;

interface Ran {
  code: number;
  output: string;
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // groupe déjà vide
  }
}

/**
 * Une commande `sh -c` dans `cwd`, sortie standard et d'erreur réunies ; au délai, tout son groupe de processus est tué.
 * `group` reçoit le groupe en cours : le nettoyage d'un signal reçu par cadence le tue avant de retirer le worktree.
 */
function sh(cmd: string, cwd: string, timeoutMs: number, group: { pgid?: number }, env: Record<string, string | undefined>): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pgid = child.pid;
    if (pgid === undefined) {
      child.once('error', (e) => resolve({ code: 127, output: e.message }));
      return;
    }
    group.pgid = pgid;
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d: Buffer) => (output += d.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(pgid);
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      killGroup(pgid); // ce que la commande a laissé en arrière-plan ne survit pas à elle
      group.pgid = undefined;
      resolve({ code: timedOut ? 124 : (code ?? 1), output: timedOut ? `${output}\ndélai dépassé (${Math.round(timeoutMs / 60_000)} min)` : output });
    });
  });
}

export interface GateCtx {
  /** Racine du dépôt vivant : ses dépendances non suivies sont reliées dans le worktree. */
  repo: string;
  sha: string;
  config: OrchestrateConfig;
  /** Clé `verify:` de cadence.yaml (L389) : où jouer la porte (défaut : `{}`, au mieux selon l'état de l'arbre principal). */
  verify?: VerifyConfig;
  out: (line: string) => void;
  /** Délai de chaque commande (défaut : 30 min). */
  timeoutMs?: number;
  /** Environnement des commandes et réglages lus pour la part de la machine (défaut : celui du processus). */
  env?: Record<string, string | undefined>;
  /** Cœurs de la machine (défaut : ceux du système) ; sert au calcul de CADENCE_TEST_WORKERS. */
  cores?: number;
}

/** Pourquoi l'arbre principal ne peut pas porter la porte au sha : non propre ou à un autre commit ; null s'il le peut. */
function mainTreeObstacle(repo: string, sha: string): string | null {
  try {
    const head = git(repo, 'rev-parse', 'HEAD');
    if (head !== sha) return `l'arbre principal est à ${head.slice(0, 7)}, pas au sha demandé`;
    if (git(repo, 'status', '--porcelain')) return 'l\'arbre principal a des modifications non validées ou des fichiers non suivis';
    return null;
  } catch (e) {
    return `l'état de l'arbre principal est illisible (${gitFailure(e)})`;
  }
}

/**
 * `cadence verify --gate` (L348) : la porte du projet (`orchestrate.build`, puis `orchestrate.test`, dans l'ordre de la vague : les tests lisent ce que le build produit)
 * rejouée au `sha` (L389) dans l'arbre principal quand il est propre et à ce sha (les outils qui refusent un `node_modules` venu d'un autre arbre y tournent chez eux) ;
 * sinon dans un worktree jetable, hors du dépôt, dont les dépendances non suivies sont copiées depuis le dépôt vivant (`orchestrate.worktreeDeps`,
 * sinon les `node_modules` de tout niveau ; les autres dossiers ignorés sont reliés, comme dans les worktrees de vague). `verify.inPlace` impose l'un (`true`, refus si l'arbre n'est pas propre au sha) ou l'autre (`false`).
 * La première ligne de la sortie dit où la porte a tourné ; en place, l'arbre est relu à la fin et, s'il a bougé, le verdict est dit non probant (code 2). Les deux commandes sont rejouées même si la première est rouge : le compte rendu est entier.
 * Chaque commande reçoit `CADENCE_TEST_WORKERS` comme dans la porte d'une vague (L350, L387) : la valeur de l'environnement de l'appelant si c'est un entier positif, sinon cœurs ÷ plafond de sessions (`CADENCE_MAX_SESSIONS`, 2 par défaut) ;
 * sans elle le rejeu `--maxWorkers=$CADENCE_TEST_WORKERS` de `orchestrate.testReplay` sortirait en erreur et ne prouverait rien.
 * Le worktree est retiré dans tous les cas. 0 vert, 1 rouge (avec les tests en échec), 2 rien à rejouer ou worktree impossible.
 */
export async function verifyGate(ctx: GateCtx): Promise<number> {
  const { repo, sha, config, out } = ctx;
  const steps = [
    ...(config.build ? [{ name: 'build', cmd: config.build }] : []),
    ...(config.test ? [{ name: 'tests', cmd: config.test }] : []),
  ];
  const short = sha.slice(0, 7);
  const base = ctx.env ?? process.env;
  const env = { ...base, [TEST_WORKERS_ENV]: String(testWorkersFrom(base, ctx.cores ?? availableParallelism(), configuredCap(base))) };
  if (steps.length === 0) {
    out('verify --gate : ni orchestrate.test ni orchestrate.build déclarés dans cadence.yaml — rien à rejouer');
    return 2;
  }
  const obstacle = mainTreeObstacle(repo, sha);
  const mode = ctx.verify?.inPlace;
  if (mode === true && obstacle) {
    out(`verify --gate : verify.inPlace demande l'arbre principal, mais ${obstacle} — rien n'est joué`);
    return 2;
  }
  const inPlace = mode === true || (mode === undefined && obstacle === null);
  if (inPlace) {
    out(`verify --gate ${short} : porte jouée dans l'arbre principal ${repo} (propre, au sha)`);
    const group: { pgid?: number } = {};
    const forget = onTermination(() => {
      if (group.pgid !== undefined) killGroup(group.pgid);
    });
    try {
      const code = await runSteps(steps, repo, ctx, group, env, short);
      // Une vague intègre ses lots par fast-forward dans cet arbre : s'il a bougé pendant la porte, les commandes ont lu un mélange de commits.
      const moved = mainTreeObstacle(repo, sha);
      if (moved === null) return code;
      out(`verify --gate ${short} : verdict non probant — ${moved} à la fin de la porte (un lot a pu être intégré pendant qu'elle tournait, ou une commande a écrit hors des dossiers ignorés) ; la rejouer`);
      return 2;
    } finally {
      forget();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'cadence-verify-'));
  const group: { pgid?: number } = {};
  const cleanup = (): void => {
    if (group.pgid !== undefined) killGroup(group.pgid);
    try {
      git(repo, 'worktree', 'remove', '--force', dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      git(repo, 'worktree', 'prune');
    } catch {
      // rien à élaguer
    }
  };
  // Ctrl-C, SIGTERM ou raccrochage reçu par cadence : la commande est tuée et le worktree retiré avant de mourir du signal.
  const forget = onTermination(cleanup);
  try {
    try {
      git(repo, 'worktree', 'add', '--detach', '-f', dir, sha);
    } catch (e) {
      out(`verify --gate : worktree de ${short} impossible — ${gitFailure(e)}`);
      return 2;
    }
    let copied: string[];
    if (config.worktreeDeps) {
      const present = config.worktreeDeps.filter((n) => lstatSync(join(repo, n), { throwIfNoEntry: false }));
      copied = copyDeps(repo, dir, present);
      const missing = config.worktreeDeps.filter((n) => !present.includes(n));
      if (missing.length) out(`dépendances déclarées absentes de l'arbre principal, non copiées : ${missing.join(', ')}`);
    } else {
      const deps = ignoredDeps(repo);
      // Seuls les node_modules sont copiés : le reste (.venv, données, .env) reste relié, comme dans un worktree de vague, sans rien dupliquer dans /tmp.
      copied = copyDeps(repo, dir, deps.filter((n) => basename(n) === 'node_modules'));
      linkIgnored(repo, dir);
    }
    const why = mode === false ? 'verify.inPlace: false' : obstacle;
    out(`verify --gate ${short} : porte jouée dans une copie jetable ${dir} (${why}) ; dépendances copiées : ${copied.length ? copied.join(', ') : 'aucune'}`);
    return await runSteps(steps, dir, ctx, group, env, short);
  } finally {
    forget();
    cleanup();
  }
}

/** Les étapes de la porte jouées dans `cwd` ; le compte rendu et le code de sortie (0 vert, 1 rouge). */
async function runSteps(steps: { name: string; cmd: string }[], cwd: string, ctx: GateCtx, group: { pgid?: number }, env: Record<string, string | undefined>, short: string): Promise<number> {
  const { config, out } = ctx;
  let red = 0;
  for (const step of steps) {
    const r = await sh(step.cmd, cwd, ctx.timeoutMs ?? GATE_TIMEOUT_MS, group, env);
    if (r.code === 0) {
      out(`✓ ${step.name} (${step.cmd})`);
      continue;
    }
    const tests = step.name === 'tests';
    const names = tests ? failedTests(r.output) : [];
    const unloaded = tests ? unloadedSuites(r.output) : [];
    // `orchestrate.testReplay` comme la porte d'une vague (L354, L387) : un rouge nommé est rejoué seul avant d'être compté ; vert au rejeu, il est instable sous charge.
    // Un échec que la sortie ne rattache à aucun test, ou un fichier qui ne se charge pas, n'est jamais rejoué.
    const replayable = tests && config.testReplay && names.length > 0 && unloaded.length === 0 && !hasUnnamedFailure(r.output);
    const replays: number[] = [];
    const { red: still, unstable } = replayable
      ? await replayRed(async (c) => {
          const p = await sh(c, cwd, ctx.timeoutMs ?? GATE_TIMEOUT_MS, group, env);
          replays.push(p.code);
          return p;
        }, config.testReplay!, names, r.output)
      : { red: names, unstable: [] as string[] };
    if (replayable && still.length === 0) {
      out(`✓ ${step.name} (${step.cmd}) — ${unstable.length} test(s) rouge(s) sous charge, verts rejoués seuls (instables sous charge) :`);
      for (const n of unstable) out(`  - ${n}`);
      continue;
    }
    red++;
    out(`✗ ${step.name} (${step.cmd}) — code ${r.code}`);
    for (const n of still) out(`  - ${n}`);
    for (const n of unloaded) out(`  - ${n} (ne se charge pas)`);
    // Un rejeu a eu lieu : dire lequel, pour qu'un rejeu en échec pour une autre raison qu'un vrai rouge (commande cassée, aucun test exécuté) ne passe pas pour une confirmation du rouge.
    if (replays.length) out(`  rejeu seul (orchestrate.testReplay) : ${replays.length} rejeu(x), dernier code ${replays[replays.length - 1]} — ${names.length - still.length} test(s) confirmé(s) vert(s) sur ${names.length} ; un rejeu en échec ou sans test exécuté ne prouve rien`);
    if (unstable.length) {
      out(`  ${unstable.length} autre(s) test(s) rouge(s) sous charge, verts rejoués seuls (instables sous charge) :`);
      for (const n of unstable) out(`    - ${n}`);
    }
    if (still.length + unloaded.length === 0 || hasUnnamedFailure(r.output, true)) {
      if (still.length + unloaded.length) out('  (au moins un échec que la sortie ne rattache à aucun test)');
      if (r.output.trim()) for (const l of r.output.trimEnd().split('\n').slice(-TAIL_LINES)) out(`  | ${l}`);
    }
  }
  out(red === 0 ? `verify --gate ${short} : vert` : `verify --gate ${short} : rouge (${red} étape${red > 1 ? 's' : ''} sur ${steps.length})`);
  return red === 0 ? 0 : 1;
}
