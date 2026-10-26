import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Chemin RÉEL de `path` s'il est prouvé DANS `root` (strictement, sauf `allowRoot`) ; erreur levée sinon, rien de supprimé.
 * La preuve porte sur les chemins réels, pas sur le texte : le dossier parent de la cible est résolu (liens compris)
 * et doit être dans la racine résolue — un lien entre la racine et la cible ne peut donc pas faire sortir.
 * La cible elle-même n'est pas résolue : si c'est un lien, c'est le lien qu'on supprimera, jamais ce qu'il désigne.
 * Rend `null` quand le parent n'existe pas (rien à supprimer), après le même refus textuel.
 */
export function provenInside(path: string, root: string | undefined, allowRoot = false): string | null {
  if (!root) throw new Error(`Suppression refusée : pas de racine temporaire privée définie (${path}).`);
  const refuse = (): Error => new Error(`Suppression refusée : ${path} est hors de la racine temporaire privée ${root}.`);
  const inside = (r: string, p: string): boolean => {
    const rel = relative(r, p);
    return rel !== '' ? !rel.startsWith('..') && !isAbsolute(rel) : allowRoot;
  };
  const abs = resolve(path);
  if (!inside(resolve(root), abs)) throw refuse();
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = realpathSync(root);
    realParent = realpathSync(dirname(abs));
  } catch {
    return null; // la racine ou le parent n'existe pas : il n'y a rien à supprimer
  }
  const real = join(realParent, basename(abs));
  if (!inside(realRoot, real)) throw refuse();
  return real;
}

/** Refuse (erreur levée, rien de supprimé) tout chemin qui n'est pas prouvé DANS `root` (voir provenInside). */
export function assertInside(path: string, root: string | undefined, allowRoot = false): void {
  provenInside(path, root, allowRoot);
}

/**
 * Supprime un arbre prouvé dans `root`, même quand un test y a laissé un dossier sans droits (chmod 000/311) :
 * on rend les droits de haut en bas avant de lire un dossier, puis on supprime. Aucun lien n'est jamais suivi :
 * la cible est un chemin réel (provenInside), la descente ne lit que des dossiers vus par lstat (un lien n'est
 * pas un dossier pour lstat), et rmSync supprime un lien comme un lien, sans descendre dedans.
 */
export function removeTree(path: string, root: string | undefined = process.env.CADENCE_TEST_TMP_ROOT): void {
  const real = provenInside(path, root, true);
  if (real === null) return;
  restoreRights(real);
  rmSync(real, { recursive: true, force: true });
}

function restoreRights(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return; // fichier, ou lien : jamais suivi
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) restoreRights(join(dir, name));
  } catch {
    // Déjà disparu, ou illisible malgré tout : rmSync dit ce qu'il reste à dire.
  }
}

/**
 * Fichier qui fournit « yaml » à un module placé dans `dir` par les node_modules de `dir` et de ses dossiers parents,
 * ou undefined s'il ne s'y trouve pas. Les chemins globaux (NODE_PATH, ~/.node_modules…) sont figés au démarrage du processus
 * et ne dépendent pas de `dir` : on ne les teste pas.
 */
export function yamlResolvedFrom(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const modules = join(d, 'node_modules');
    if (basename(d) !== 'node_modules' && existsSync(join(modules, 'yaml'))) {
      try {
        return createRequire(join(modules, 'x.json')).resolve('yaml');
      } catch {
        // dossier yaml inutilisable : pas un fournisseur
      }
    }
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Premier dossier de `candidates` où la racine privée de la suite peut vivre : il existe, et « yaml » ne s'y résout pas.
 * Node remonte les dossiers parents en cherchant node_modules : un TMPDIR sous un dossier qui a node_modules/yaml fait résoudre « yaml »
 * depuis tout paquet jetable et donne exactement les trois rouges « yaml introuvable » de orchestrate-snapshot vus en session de vague le 26-10
 * (reproduit hors vague, seul mécanisme qui donne cette signature : docs/mesures/orchestrate-snapshot-session-2026-10-26.md). Le TMPDIR
 * sale de ces sessions n'a pas été vu lui-même (supprimé avec la vague) : la garde couvre le mécanisme au départ de la suite, pas un
 * node_modules écrit dans TMPDIR pendant le run ; le test « R2 » de test/orchestrate-snapshot.test.ts nomme alors le fichier fautif.
 * Aucun candidat propre : erreur qui les nomme.
 */
export function pickRootBase(candidates: string[]): string {
  const seen: string[] = [];
  for (const dir of candidates) {
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue; // absent : sauté
    }
    const found = yamlResolvedFrom(dir);
    if (found === undefined) return dir;
    seen.push(`${dir} (« yaml » s'y résout : ${found})`);
  }
  throw new Error(`Aucun dossier temporaire d'où « yaml » ne se résout pas : les tests « yaml introuvable » seraient faussés. Écartés : ${seen.join(' ; ') || 'aucun dossier existant'}.`);
}

/** Préfixe des racines privées de la suite, et fichier qui y note le pid du run qui l'a créée. */
export const ROOT_PREFIX = 'cadence-tests-root-';
export const PID_FILE = '.cadence-tests.pid';

/**
 * Contenu du fichier pid : le pid PUIS le nom de la machine, une ligne chacun. Un /tmp partagé (conteneurs, NFS)
 * montre des racines d'autres machines, dont le pid ne veut rien dire ici : on ne touche qu'aux nôtres.
 */
export function pidFileText(pid: number = process.pid, host: string = hostname()): string {
  return `${pid}\n${host}\n`;
}

/** Le processus `pid` existe-t-il ? EPERM = il existe (à un autre utilisateur) ; ESRCH = mort. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ce qui décide qu'une racine est périmée ; injectable pour les tests. */
export interface StaleCheck {
  /** Le processus existe-t-il ? */
  alive?: (pid: number) => boolean;
  /** Nom de cette machine (défaut os.hostname()) : le fichier pid doit le porter. */
  host?: string;
  /** uid de l'utilisateur courant ; `undefined` (win32, pas de getuid) saute la vérification du propriétaire. */
  uid?: () => number | undefined;
}

/**
 * `dir` est-il une racine d'un run interrompu (Ctrl-C, kill, OOM) que nous pouvons prouver nôtre ? Un vrai dossier
 * (pas un lien) au bon préfixe, appartenant à l'utilisateur courant, portant NOTRE fichier pid (fichier ordinaire,
 * pidFileText) écrit sur CETTE machine, dont le pid désigne un processus mort. Au moindre doute (illisible, absent, autre propriétaire) : non.
 */
export function isStaleRoot(dir: string, check: StaleCheck = {}): boolean {
  const { alive = isProcessAlive, uid = () => process.getuid?.(), host = hostname() } = check;
  if (!basename(dir).startsWith(ROOT_PREFIX)) return false;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return false; // un lien n'est pas un dossier pour lstat
    const me = uid();
    if (me !== undefined && st.uid !== me) return false;
    const pidFile = join(dir, PID_FILE);
    if (!lstatSync(pidFile).isFile()) return false;
    const [pid, from, ...rest] = readFileSync(pidFile, 'utf8').split('\n');
    if (!/^\d+$/.test(pid ?? '') || from !== host || rest.join('') !== '') return false;
    return !alive(Number(pid));
  } catch {
    return false; // pas de fichier pid (ou illisible) : pas une racine que nous pouvons prouver nôtre
  }
}

/** Racines périmées (isStaleRoot) directement dans `realTmp`. */
export function findStaleRoots(realTmp: string, check: StaleCheck = {}): string[] {
  let names: string[];
  try {
    names = readdirSync(realTmp);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => join(realTmp, name))
    .filter((dir) => isStaleRoot(dir, check));
}

/**
 * Supprime les racines périmées de findStaleRoots et rend la liste de celles supprimées. Chaque racine est revérifiée
 * juste avant sa suppression, et n'est autorisée que pour elle-même (removeTree(dir, dir)).
 */
export function removeStaleRoots(realTmp: string, check: StaleCheck = {}): string[] {
  const removed: string[] = [];
  for (const dir of findStaleRoots(realTmp, check)) {
    if (!isStaleRoot(dir, check)) continue;
    removeTree(dir, dir);
    removed.push(dir);
  }
  return removed;
}

/** Ce qui reste dans la racine temporaire privée de la suite : doit être vide en fin de run (hors notre fichier pid). */
export function leftovers(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n !== PID_FILE).sort();
  } catch {
    return [];
  }
}
