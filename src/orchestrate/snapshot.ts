import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Racine du paquet en cours d'exécution (dist/orchestrate/ ou src/orchestrate/ → deux niveaux au-dessus). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Posée par le processus relancé depuis la copie : il tourne déjà sur l'instantané, il n'en refait pas. */
export const SNAPSHOT_ENV = 'CADENCE_SNAPSHOT';
/** Vague déjà réservée (et copiée) par le processus d'origine : le processus relancé la reprend telle quelle. */
export const RESERVED_ENV = 'CADENCE_WAVE_RESERVED';

/** Environnement sans les variables de relance : le fils les lit, il ne les transmet ni aux sessions ni aux commandes du projet. */
export function withoutLaunchVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [SNAPSHOT_ENV]: _s, [RESERVED_ENV]: _r, ...rest } = env;
  return rest;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Vrai fils : CADENCE_SNAPSHOT désigne CE paquet (la copie qui s'exécute). Une valeur héritée d'une autre vague ne compte pas. */
export const isSnapshotChild = (env: NodeJS.ProcessEnv, root = PACKAGE_ROOT): boolean => !!env[SNAPSHOT_ENV] && real(env[SNAPSHOT_ENV]!) === real(root);

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

/** Refus de prendre l'instantané (avant toute copie) : le message dit quoi faire. */
export class SnapshotRefusal extends Error {}

/**
 * Le `node_modules` où les dépendances du paquet se résolvent réellement : celui du paquet, ou — installation npx ou
 * locale — un dossier parent. On résout `yaml` depuis le paquet et on remonte jusqu'à son `node_modules`.
 */
export function resolveModulesDir(packageRoot: string): string {
  let file: string;
  try {
    file = createRequire(join(packageRoot, 'package.json')).resolve('yaml');
  } catch {
    throw new SnapshotRefusal(`dépendances introuvables : « yaml » ne se résout pas depuis ${packageRoot} (installation incomplète ?) — instantané impossible, aucune vague lancée`);
  }
  const marker = `${sep}node_modules${sep}`;
  const at = file.lastIndexOf(marker);
  if (at < 0) throw new SnapshotRefusal(`dépendances introuvables : « yaml » résolu hors de tout node_modules (${file}) — instantané impossible, aucune vague lancée`);
  return file.slice(0, at + marker.length - 1);
}

/** Instantané du paquet dans `<vague>/tool/` : le code, les gabarits et les agents d'une vague ne bougent plus. */
export function takeSnapshot(waveDir: string, packageRoot: string): string {
  const modules = resolveModulesDir(packageRoot); // avant toute copie
  const tool = toolDirOf(waveDir);
  mkdirSync(tool, { recursive: true });
  for (const name of COPIED) {
    const from = join(packageRoot, name);
    if (existsSync(from)) cpSync(from, join(tool, name), { recursive: true });
  }
  symlinkSync(modules, join(tool, 'node_modules'), 'dir');
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
