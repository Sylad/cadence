import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Accès au disque, injectable : les tests ne touchent jamais au vrai ~/.nvm. */
export interface NodeFs {
  read: (file: string) => string | null;
  list: (dir: string) => string[];
  /** Le fichier existe et son bit d'exécution est posé (lien suivi : un lien cassé n'est pas exécutable). */
  executable: (file: string) => boolean;
}

export const realNodeFs: NodeFs = {
  read: (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null),
  list: (d) => (existsSync(d) ? readdirSync(d) : []),
  executable: (f) => {
    try {
      accessSync(f, constants.X_OK);
      return statSync(f).isFile();
    } catch {
      return false;
    }
  },
};

export type NodeChoice =
  | { kind: 'none' }
  | { kind: 'ok'; /** Version retenue, `v22.22.3`. */ version: string; /** Demandé dans .nvmrc, tel que lu. */ wanted: string; bin: string; /** Versions plus hautes qui correspondaient mais sans node exécutable, de la plus haute à la plus basse (absent si aucune). */ skipped?: string[] }
  | { kind: 'missing'; message: string };

/** Dossier des versions de nvm : `$NVM_DIR/versions/node`, par défaut `~/.nvm/versions/node`. */
export function nvmVersionsDir(env: Record<string, string | undefined>, home = homedir()): string {
  return join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node');
}

const parts = (v: string) => v.split('.').map(Number);
const cmp = (a: string, b: string) => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * Node demandé par le `.nvmrc` à la racine d'un projet, résolu dans les versions installées de nvm : la plus haute
 * dont le numéro commence par celui du fichier (`22`, `v22`, `22.22`, `v22.22.3`) et qui a un node exécutable. Pas de .nvmrc : rien à changer.
 * .nvmrc illisible pour nous (`lts/*`, alias) ou version absente : refus nommant ce qui est demandé et où on a cherché
 * — jamais de repli silencieux sur le node par défaut.
 */
export function resolveNode(repo: string, versionsDir: string, fs: NodeFs = realNodeFs): NodeChoice {
  const raw = fs.read(join(repo, '.nvmrc'));
  if (raw === null) return { kind: 'none' };
  const wanted = raw.trim();
  const m = /^v?(\d+(?:\.\d+){0,2})$/.exec(wanted);
  if (!m) return { kind: 'missing', message: `.nvmrc « ${wanted} » : version non résoluble (seuls 22, v22, 22.22, v22.22.3 sont compris)` };
  const want = m[1];
  const matching = fs
    .list(versionsDir)
    .map((n) => /^v(\d+\.\d+\.\d+)$/.exec(n)?.[1])
    .filter((v): v is string => !!v && (v === want || v.startsWith(`${want}.`)))
    .sort(cmp);
  if (matching.length === 0) return { kind: 'missing', message: `.nvmrc ${wanted} : aucun Node installé correspondant dans ${versionsDir}` };
  // Une version dont le bin n'a pas de node exécutable (install vide ou cassée) donnerait un dossier de liens vide,
  // donc un repli silencieux sur le node par défaut : on l'écarte, et une plus basse valide peut être retenue.
  const found = matching.filter((v) => fs.executable(join(versionsDir, `v${v}`, 'bin', 'node')));
  if (found.length === 0) {
    const names = matching.map((v) => `v${v}`).join(', ');
    return { kind: 'missing', message: `.nvmrc ${wanted} : ${names} trouvée(s) dans ${versionsDir} mais sans node exécutable dans bin (installation vide ou cassée)` };
  }
  const best = found[found.length - 1];
  const skipped = matching.filter((v) => cmp(v, best) > 0).reverse().map((v) => `v${v}`);
  return { kind: 'ok', version: `v${best}`, wanted, bin: join(versionsDir, `v${best}`, 'bin'), ...(skipped.length ? { skipped } : {}) };
}

/** Les seuls binaires d'une version de Node que les sessions voient : le reste de son bin (raf, cadence, claude… installés en global) ne doit pas masquer ceux du PATH. */
export const NODE_LINKED = ['node', 'npm', 'npx', 'corepack'];

/**
 * Dossier de liens `<runDir>/node-bin/<version>/` : un lien vers chacun des `NODE_LINKED` présents dans `bin`. Recréé à
 * chaque appel (départ et reprise), donc idempotent. C'est lui, et non `bin`, qui passe en tête du PATH des sessions.
 */
export function linkNodeBin(runDir: string, version: string, bin: string): string {
  const dir = join(runDir, 'node-bin', version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of NODE_LINKED) if (existsSync(join(bin, name))) symlinkSync(join(bin, name), join(dir, name));
  return dir;
}
