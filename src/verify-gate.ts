import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrateConfig, VerifyConfig } from './config.js';
import { recordedGate } from './gate-record.js';
import { recordVerdict } from './gate-verdict.js';
import { onTermination } from './proc.js';
import { sharedStateDir } from './state.js';
import { activeLock, REPO_LOCK } from './orchestrate/lock.js';
import { failedTests, hasUnnamedFailure, unloadedSuites } from './orchestrate/baseline.js';
import { configuredCap } from './orchestrate/command.js';
import { replayRed, TEST_WORKERS_ENV, testWorkersFrom } from './orchestrate/workers.js';
import { copyDeps, git, gitFailure, ignoredDeps, isCopiedDep, linkIgnored } from './orchestrate/worktree.js';

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
  /** Racine du dépôt vivant : ses dépendances non suivies (node_modules, .venv) sont copiées dans le worktree (`copyDeps`). */
  repo: string;
  sha: string;
  config: OrchestrateConfig;
  /** Clé `verify:` de cadence.yaml (L389) : où jouer la porte (défaut : `{}`, au mieux selon l'état de l'arbre principal). */
  verify?: VerifyConfig;
  out: (line: string) => void;
  /** Dossiers où chercher l'état des vagues (`.cadence/runs`, L397) dont la porte peut être reprise au lieu d'être rejouée (défaut : aucun, la porte est toujours rejouée). */
  launchDirs?: string[];
  /** Le plan du projet, relatif à la racine du dépôt (L444) : les commits qui ne changent que lui au-dessus du sha ne sont pas un autre contenu, la porte du sha dessous vaut, sauf si `orchestrate.gate.readsPlan` déclare qu'un test le lit (L450). */
  planFile?: string;
  /** Délai de chaque commande (défaut : 30 min). */
  timeoutMs?: number;
  /** Environnement des commandes et réglages lus pour la part de la machine (défaut : celui du processus). */
  env?: Record<string, string | undefined>;
  /** L'horloge qui date le verdict noté (défaut : l'heure du système). */
  now?: () => Date;
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
 * Ce qui a changé dans l'arbre principal depuis le début d'une porte en place (L393) : HEAD n'est plus au sha et/ou `git status --porcelain` n'est plus vide ; null si rien n'a bougé.
 * Relu à la fin de la porte, après toutes les étapes, y compris rouges.
 */
function mainTreeMoved(repo: string, sha: string): string | null {
  try {
    const head = git(repo, 'rev-parse', 'HEAD');
    const status = git(repo, 'status', '--porcelain');
    const changes: string[] = [];
    if (head !== sha) changes.push(`HEAD est passé de ${sha.slice(0, 7)} à ${head.slice(0, 7)}`);
    if (status) changes.push(`git status n'est plus vide (${status.split('\n').length} entrée(s))`);
    return changes.length ? changes.join(' ; ') : null;
  } catch (e) {
    return `l'état de l'arbre principal est illisible (${gitFailure(e)})`;
  }
}

/**
 * `cadence verify --gate` (L348) : la porte du projet (`orchestrate.build`, puis `orchestrate.test`, dans l'ordre de la vague : les tests lisent ce que le build produit)
 * rejouée au `sha` (L389) dans l'arbre principal quand il est propre et à ce sha (les outils qui refusent un `node_modules` venu d'un autre arbre y tournent chez eux) ;
 * sinon (arbre non propre ou à un autre commit, ou vague d'orchestration vivante sur le dépôt, L431) dans un worktree jetable, hors du dépôt, dont les dépendances non suivies sont copiées depuis le dépôt vivant (`orchestrate.worktreeDeps`,
 * sinon les `node_modules` de tout niveau et le `.venv` ; les autres dossiers ignorés sont reliés, comme dans les worktrees de vague ; la copie est asynchrone pour que Ctrl-C la coupe). `verify.inPlace` impose l'un (`true`, refus si l'arbre n'est pas propre au sha) ou l'autre (`false`).
 * La première ligne de la sortie dit où la porte a tourné ; en place, HEAD et `git status` sont relus après les étapes et, si l'arbre a bougé (HEAD avancé, status sale), la sortie dit ce qui a changé, que le verdict n'est pas celui du sha et sort en code 2, rouge ou vert ; la ligne « vert » / « rouge » n'est alors pas écrite. Les deux commandes sont rejouées même si la première est rouge : le compte rendu est entier.
 * Chaque commande reçoit `CADENCE_TEST_WORKERS` comme dans la porte d'une vague (L350, L387) : la valeur de l'environnement de l'appelant si c'est un entier positif, sinon cœurs ÷ plafond de sessions (`CADENCE_MAX_SESSIONS`, 2 par défaut) ;
 * sans elle le rejeu `--maxWorkers=$CADENCE_TEST_WORKERS` de `orchestrate.testReplay` sortirait en erreur et ne prouverait rien.
 * La porte déjà jouée par le programme au même sha n'est pas rejouée (L397) : si l'état d'une vague (`ctx.launchDirs`) porte des contrôles enregistrés AU sha, sur un arbre identique, verts et couvrant chaque commande actuelle,
 * leur verdict est repris et la première ligne le dit (vague, lot) ; sinon la porte est rejouée et la ligne qui suit celle du lieu en donne la raison.
 * Le verdict (0 ou 1, pas 2) est noté par sha dans l'état partagé du dépôt (`gate-verdict.ts`, L426) : le hook pre-push refuse un push dont le sha n'a pas de verdict vert.
 * Le worktree est retiré dans tous les cas. 0 vert, 1 rouge (avec les tests en échec), 2 rien à rejouer ou worktree impossible.
 */
export async function verifyGate(ctx: GateCtx): Promise<number> {
  const code = await playGate(ctx);
  // Seuls 0 (vert) et 1 (rouge) sont des verdicts du sha ; 2 (rien à rejouer, verdict non probant) n'en est pas un. Le hook pre-push les lit (L426).
  if (code === 0 || code === 1) {
    try {
      recordVerdict(ctx.repo, ctx.sha, code, (ctx.now ?? (() => new Date()))());
    } catch (e) {
      // Un verdict qu'on ne peut pas noter ne change jamais le code de la porte : le push sera refusé faute de verdict, et la sortie dit pourquoi.
      ctx.out(`verify --gate ${ctx.sha.slice(0, 7)} : verdict non noté (${(e as Error).message}) — le hook pre-push refusera ce sha tant qu'il n'a pas de verdict`);
    }
  }
  return code;
}

async function playGate(ctx: GateCtx): Promise<number> {
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
  let recorded: ReturnType<typeof recordedGate> = { reason: 'aucune porte de vague enregistrée pour ce sha' };
  try {
    // Un test qui lit le plan (orchestrate.gate.readsPlan, L450) voit un autre contenu après un `raf done` : les commits de plan seuls ne sont pas traversés.
    recorded = recordedGate(ctx.launchDirs ?? [], repo, sha, steps, config.gate ? undefined : ctx.planFile);
  } catch (e) {
    recorded = { reason: `état des vagues illisible (${gitFailure(e)})` };
  }
  if ('found' in recorded) {
    const f = recorded.found;
    const where = f.checked === sha ? 'au même sha' : `au sha ${f.checked.slice(0, 7)}, sous les seuls commits de plan de ${short}`;
    out(`verify --gate ${short} : verdict repris de la porte de la vague ${f.wave} (lot ${f.lot} : contrôles du programme ${where}, arbre ${f.tree.slice(0, 7)} identique) — rien rejoué`);
    for (const step of steps) {
      const run = f.runs.find((r) => r.label === (step.name === 'build' ? 'build' : 'tests') && r.command === step.cmd)!;
      out(`✓ ${step.name} (${step.cmd}) — enregistré par la vague${run.instables?.length ? `, ${run.instables.length} test(s) instable(s) sous charge, verts rejoués seuls` : ''}`);
    }
    out(`verify --gate ${short} : vert`);
    return 0;
  }
  const replayReason = `verdict rejoué : ${recorded.reason}${config.gate && ctx.planFile ? ' (orchestrate.gate.readsPlan : un test lit le plan, les commits de plan seuls ne reprennent pas le verdict d\'un sha dessous)' : ''}`;
  const obstacle = mainTreeObstacle(repo, sha);
  const mode = ctx.verify?.inPlace;
  if (mode === true && obstacle) {
    out(`verify --gate : verify.inPlace demande l'arbre principal, mais ${obstacle} — rien n'est joué`);
    return 2;
  }
  // Une vague vivante intègre ses lots (HEAD bouge) et commite son plan : l'arbre principal n'est pas un lieu stable, la porte joue dans une copie (L431) ; `verify.inPlace: true` reste obéi.
  let liveWave: string | null = null;
  try {
    liveWave = activeLock(join(sharedStateDir(repo), REPO_LOCK))?.wave ?? null;
  } catch {
    // verrou illisible : comme s'il n'y avait pas de vague
  }
  const inPlace = mode === true || (mode === undefined && obstacle === null && liveWave === null);
  if (inPlace) {
    out(`verify --gate ${short} : porte jouée dans l'arbre principal ${repo} (propre, au sha)`);
    out(replayReason);
    const group: { pgid?: number } = {};
    const forget = onTermination(() => {
      if (group.pgid !== undefined) killGroup(group.pgid);
    });
    try {
      const { code, summary } = await runSteps(steps, repo, ctx, group, env, short);
      // Une vague intègre ses lots par fast-forward dans cet arbre et y commite son plan : s'il a bougé pendant la porte, les commandes ont lu un mélange de commits.
      const moved = mainTreeMoved(repo, sha);
      if (moved === null) {
        out(summary);
        return code;
      }
      out(`verify --gate ${short} : verdict non probant — ${moved} pendant la porte (un lot a pu être intégré ou le plan d'une vague commité pendant qu'elle tournait, ou une commande a écrit hors des dossiers ignorés) ; les ✓/✗ ci-dessus ne sont pas ceux de ${short} ; la rejouer`);
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
    let missing: string[] = [];
    if (config.worktreeDeps) {
      const present = config.worktreeDeps.filter((n) => existsSync(join(repo, n)));
      copied = await copyDeps(repo, dir, present);
      missing = config.worktreeDeps.filter((n) => !present.includes(n));
    } else {
      // Seules les dépendances sont copiées ; les autres dossiers ignorés (données, .env) restent reliés, comme dans un worktree de vague, sans rien dupliquer dans /tmp.
      copied = await copyDeps(repo, dir, ignoredDeps(repo).filter(isCopiedDep));
      linkIgnored(repo, dir);
    }
    const why = mode === false ? 'verify.inPlace: false' : (obstacle ?? `la vague ${liveWave} est vivante sur ce dépôt : HEAD et le plan y bougent`);
    out(`verify --gate ${short} : porte jouée dans une copie jetable ${dir} (${why}) ; dépendances copiées : ${copied.length ? copied.join(', ') : 'aucune'}`);
    out(replayReason);
    if (missing.length) out(`dépendances déclarées absentes de l'arbre principal, non copiées : ${missing.join(', ')}`);
    const done = await runSteps(steps, dir, ctx, group, env, short);
    out(done.summary);
    return done.code;
  } finally {
    forget();
    cleanup();
  }
}

/** Les étapes de la porte jouées dans `cwd` ; le code de sortie (0 vert, 1 rouge) et la ligne de verdict, écrite par l'appelant une fois sûr qu'elle vaut pour le sha. */
async function runSteps(steps: { name: string; cmd: string }[], cwd: string, ctx: GateCtx, group: { pgid?: number }, env: Record<string, string | undefined>, short: string): Promise<{ code: number; summary: string }> {
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
  return { code: red === 0 ? 0 : 1, summary: red === 0 ? `verify --gate ${short} : vert` : `verify --gate ${short} : rouge (${red} étape${red > 1 ? 's' : ''} sur ${steps.length})` };
}
