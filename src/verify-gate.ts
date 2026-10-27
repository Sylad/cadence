import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrateConfig } from './config.js';
import { onTermination } from './proc.js';
import { failedTests, hasUnnamedFailure, unloadedSuites } from './orchestrate/baseline.js';
import { replayRed } from './orchestrate/workers.js';
import { git, gitFailure, linkDeclared, linkIgnored } from './orchestrate/worktree.js';

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
function sh(cmd: string, cwd: string, timeoutMs: number, group: { pgid?: number }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  out: (line: string) => void;
  /** Délai de chaque commande (défaut : 30 min). */
  timeoutMs?: number;
}

/**
 * `cadence verify --gate` (L348) : la porte du projet (`orchestrate.build`, puis `orchestrate.test`, dans l'ordre de la vague : les tests lisent ce que le build produit)
 * rejouée au `sha` dans un worktree jetable, hors du dépôt, dont les dépendances non suivies sont reliées depuis le dépôt vivant (`orchestrate.worktreeDeps`,
 * sinon les dossiers ignorés de tout niveau, comme les worktrees de vague). Les deux commandes sont rejouées même si la première est rouge : le compte rendu est entier.
 * Le worktree est retiré dans tous les cas. 0 vert, 1 rouge (avec les tests en échec), 2 rien à rejouer ou worktree impossible.
 */
export async function verifyGate(ctx: GateCtx): Promise<number> {
  const { repo, sha, config, out } = ctx;
  const steps = [
    ...(config.build ? [{ name: 'build', cmd: config.build }] : []),
    ...(config.test ? [{ name: 'tests', cmd: config.test }] : []),
  ];
  const short = sha.slice(0, 7);
  if (steps.length === 0) {
    out('verify --gate : ni orchestrate.test ni orchestrate.build déclarés dans cadence.yaml — rien à rejouer');
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cadence-verify-'));
  const links: string[] = [];
  const group: { pgid?: number } = {};
  const cleanup = (): void => {
    if (group.pgid !== undefined) killGroup(group.pgid);
    for (const k of links) if (lstatSync(k, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(k);
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
    if (config.worktreeDeps) {
      const linked = linkDeclared(repo, dir, config.worktreeDeps);
      links.push(...linked.links);
      if (linked.missing.length) out(`dépendances déclarées absentes de l'arbre principal, non liées : ${linked.missing.join(', ')}`);
    } else {
      links.push(...linkIgnored(repo, dir));
    }
    let red = 0;
    for (const step of steps) {
      const r = await sh(step.cmd, dir, ctx.timeoutMs ?? GATE_TIMEOUT_MS, group);
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
      const { red: still, unstable } = replayable ? await replayRed((c) => sh(c, dir, ctx.timeoutMs ?? GATE_TIMEOUT_MS, group), config.testReplay!, names, r.output) : { red: names, unstable: [] as string[] };
      if (replayable && still.length === 0) {
        out(`✓ ${step.name} (${step.cmd}) — ${unstable.length} test(s) rouge(s) sous charge, verts rejoués seuls (instables sous charge) :`);
        for (const n of unstable) out(`  - ${n}`);
        continue;
      }
      red++;
      out(`✗ ${step.name} (${step.cmd}) — code ${r.code}`);
      for (const n of still) out(`  - ${n}`);
      for (const n of unloaded) out(`  - ${n} (ne se charge pas)`);
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
  } finally {
    forget();
    cleanup();
  }
}
