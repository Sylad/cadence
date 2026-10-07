import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Racine du paquet en cours d'exécution (dist/orchestrate/ ou src/orchestrate/ → deux niveaux au-dessus). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Posée par le processus relancé depuis la copie : il tourne déjà sur l'instantané, il n'en refait pas. */
export const SNAPSHOT_ENV = 'CADENCE_SNAPSHOT';
/** Vague déjà réservée (et copiée) par le processus d'origine : le processus relancé la reprend telle quelle. */
export const RESERVED_ENV = 'CADENCE_WAVE_RESERVED';

/** Ce du paquet qui sert à l'exécution d'une vague ; node_modules est lié, jamais copié. */
const COPIED = ['bin', 'dist', 'templates', 'agents', 'skills', 'package.json'];

/** Dossier et sorties du processus relancé : ceux du `io` de l'appelant. */
export interface LineSink {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface SnapshotDeps {
  packageRoot: string;
  /** Relance `orchestrate <argv>` depuis la copie `toolDir` ; rend son code de sortie. */
  reexec: (toolDir: string, argv: string[], env: NodeJS.ProcessEnv, sink: LineSink) => Promise<number>;
}

export const toolDirOf = (waveDir: string) => join(waveDir, 'tool');

/** Instantané du paquet dans `<vague>/tool/` : le code, les gabarits et les agents d'une vague ne bougent plus. */
export function takeSnapshot(waveDir: string, packageRoot: string): string {
  const tool = toolDirOf(waveDir);
  mkdirSync(tool, { recursive: true });
  for (const name of COPIED) {
    const from = join(packageRoot, name);
    if (existsSync(from)) cpSync(from, join(tool, name), { recursive: true });
  }
  const modules = join(packageRoot, 'node_modules');
  if (existsSync(modules)) symlinkSync(modules, join(tool, 'node_modules'), 'dir');
  return tool;
}

export const snapshotExists = (waveDir: string) => existsSync(join(toolDirOf(waveDir), 'bin', 'cadence.js'));

/** Relance réelle : un processus node sur la copie, signaux transmis, code de sortie rendu. */
export function spawnReexec(toolDir: string, argv: string[], env: NodeJS.ProcessEnv, sink: LineSink): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(toolDir, 'bin', 'cadence.js'), 'orchestrate', ...argv], { cwd: sink.cwd, env: { ...env, [SNAPSHOT_ENV]: toolDir }, stdio: ['inherit', 'pipe', 'pipe'] });
    const lines = [createInterface({ input: child.stdout! }).on('line', sink.out), createInterface({ input: child.stderr! }).on('line', sink.err)];
    const drained = Promise.all(lines.map((l) => new Promise<void>((r) => l.once('close', r))));
    const relay = (sig: NodeJS.Signals) => () => child.kill(sig);
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => [s, relay(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      for (const [s, h] of handlers) process.off(s, h);
      await drained;
      // Le fils est mort d'un signal (il se nettoie puis se le renvoie) : on meurt du même, comme sans instantané.
      if (signal) process.kill(process.pid, signal);
      resolve(code ?? 1);
    });
  });
}
