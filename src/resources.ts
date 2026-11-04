import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readYamlFile } from './yaml-keys.js';
import { isOpen, RafError, RESOURCE_NAME, RESOURCES_BAD_LIST, type Lot } from './plan.js';

/**
 * Les ressources déclarées (clé `resources:`, L251) et le cadence.yaml qui les déclare, ou celui du dossier parent quand aucun n'en porte.
 * `paths` (L558) : les chemins normalisés (R3) de chaque ressource, vides pour une ressource sans chemin (liste de noms, « banc: {} », « banc: »).
 */
export interface Resources {
  file: string;
  names: string[];
  paths: Map<string, string[]>;
}

/**
 * Une table `resources:` mal formée (R4) : liste mêlée, nom hors RESOURCE_NAME, entrée ou chemin invalide. Distincte de la `RafError` d'un fichier
 * illisible ou d'une liste de noms invalide (L251) : `raf check` la signale même quand aucun lot ouvert ne porte `uses:` (A1), les autres non.
 */
class ResourcesTableError extends RafError {}

const MIXED = 'mêle des noms et des tables : écrire soit une liste de noms, soit une table nom: { paths: [...] }';
const BAD_NAME = 'nom de ressource invalide (lettres minuscules, chiffres, - et _)';
const BAD_PATHS = 'paths doit être une liste de chemins';
const badPath = (p: string) => `chemin invalide « ${p} » (relatif au dépôt, sans « .. », « \\ » ni joker)`;

/**
 * Un chemin de ressource normalisé (R3) : segments « . » retirés, « // » réduit, « / » final retiré. Rend '' pour un chemin vide après
 * normalisation (« . », « ./ », « ././ »), que le lecteur rejette (R4). Ne juge ni « .. », ni « \ », ni les jokers : c'est le rejet de R4, avant.
 */
export const normalizePath = (p: string): string => p.split('/').filter((s) => s !== '' && s !== '.').join('/');

/** Un chemin refusé par R4 : absolu, « .. » en segment, antislash, joker. Le vide (avant ou après normalisation) est jugé par le lecteur. */
const forbidden = (p: string): boolean => p.startsWith('/') || p.split('/').includes('..') || /[\\*?[]/.test(p);

/** Le chemin couvre le fichier de ce nom et tout fichier dessous, segment par segment (R3 : « src/a » ne couvre pas « src/ab.ts »). */
export const coversFile = (path: string, file: string): boolean => file === path || file.startsWith(`${path}/`);

/** Au moins une ressource déclarée porte un chemin : sinon rien n'est déduit d'un diff et aucun diff n'est lu (R1). */
export const hasPaths = (r: Resources): boolean => [...r.paths.values()].some((p) => p.length > 0);

/** Les ressources dont un chemin couvre un des `files` (R5 : un fichier sous deux ressources en tient deux), avec le premier chemin et fichier qui les touchent. */
export function resourcesTouching(r: Resources, files: Iterable<string>): Map<string, { path: string; file: string }> {
  const out = new Map<string, { path: string; file: string }>();
  const list = [...files];
  for (const [name, paths] of r.paths) {
    for (const path of paths) {
      const file = list.find((f) => coversFile(path, f));
      if (file !== undefined) {
        out.set(name, { path, file });
        break;
      }
    }
  }
  return out;
}

/** Les chemins d'une entrée de la table (R3, R4) : validés, normalisés, dédoublonnés dans l'ordre. */
function readPaths(file: string, name: string, entry: unknown): string[] {
  const fail = (cause: string): never => {
    throw new ResourcesTableError(`${file} : resources.${name} : ${cause}`);
  };
  if (entry == null) return [];
  if (typeof entry !== 'object' || Array.isArray(entry)) return fail(BAD_PATHS);
  for (const key of Object.keys(entry)) if (key !== 'paths') fail(`clé inconnue « ${key} » (seule paths est connue)`);
  if (!Object.hasOwn(entry, 'paths')) return [];
  const raw = (entry as { paths: unknown }).paths;
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) return fail(BAD_PATHS);
  const out: string[] = [];
  for (const p of raw as string[]) {
    if (forbidden(p)) fail(badPath(p));
    const n = normalizePath(p);
    if (n === '') fail(badPath(p));
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** La clé `resources:` lue (R1, R2, R4) : liste de noms (L251) ou table « nom: { paths: [...] } » (L558), jamais une liste mêlée. */
function parseResources(file: string, list: unknown): Pick<Resources, 'names' | 'paths'> {
  if (Array.isArray(list)) {
    if (list.some((n) => n != null && typeof n === 'object')) throw new ResourcesTableError(`${file} : resources ${MIXED}`);
    if (!list.every((n) => typeof n === 'string' && RESOURCE_NAME.test(n))) throw new RafError(`${file} : resources ${RESOURCES_BAD_LIST}`);
    const names = [...new Set(list as string[])];
    return { names, paths: new Map(names.map((n) => [n, []])) };
  }
  if (list === null || typeof list !== 'object') throw new RafError(`${file} : resources ${RESOURCES_BAD_LIST}`);
  const paths = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(list)) {
    if (!RESOURCE_NAME.test(name)) throw new ResourcesTableError(`${file} : resources.${name} : ${BAD_NAME}`);
    paths.set(name, readPaths(file, name, entry));
  }
  return { names: [...paths.keys()], paths };
}

/**
 * Clé `resources:` du cadence.yaml le plus proche en remontant depuis le dossier parent de `root` : le premier fichier qui porte la clé
 * (même vide) l'emporte. Aucun ne la porte : liste vide, attribuée au cadence.yaml du parent direct. Un fichier illisible ou une clé
 * qui n'est ni une liste de noms valides ni une table bien formée (R4) est une `RafError` nommant le fichier, jamais une liste vide silencieuse.
 */
export function readResources(root: string): Resources {
  const fallback = join(dirname(root), 'cadence.yaml');
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    const file = join(dir, 'cadence.yaml');
    if (existsSync(file) && statSync(file).isFile()) {
      const raw = readYamlFile(file);
      if (raw != null && typeof raw === 'object' && Object.hasOwn(raw, 'resources')) {
        return { file, ...parseResources(file, (raw as { resources: unknown }).resources ?? []) };
      }
    }
    if (dirname(dir) === dir) return { file: fallback, names: [], paths: new Map() };
  }
}

/**
 * Les ressources déclarées pour le dépôt `repo`, ou aucune (sans chemin) quand le cadence.yaml est illisible ou mal formé : rien n'est journalisé ici,
 * `raf check` et la ligne de tour du projet signalent une table mal formée même sans `uses:` (R4, A1), un fichier illisible dès qu'un lot porte `uses:` (L251).
 */
export function declaredFor(repo: string): Resources {
  try {
    return readResources(repo);
  } catch (e) {
    if (e instanceof RafError) return { file: join(dirname(repo), 'cadence.yaml'), names: [], paths: new Map() };
    throw e;
  }
}

/**
 * Un écart par ressource d'un lot ouvert que le cadence.yaml des dossiers parents ne déclare pas, et un écart pour une table `resources:` mal formée
 * (R4, A1), que des lots portent `uses:` ou non : une ressource tenue par ses chemins n'a pas de `uses:` et personne d'autre ne lirait le fichier.
 * Sans lot ouvert portant `uses:`, un fichier illisible ou une liste de noms invalide donne le contrôle d'avant (L251), quel que soit le dossier parent.
 */
export function resourceIssues(lots: Lot[], root: string): { message: string }[] {
  const using = lots.filter((l) => isOpen(l.status) && l.uses?.length);
  let declared: Resources;
  try {
    declared = readResources(root);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    return e instanceof ResourcesTableError || using.length > 0 ? [{ message: e.message }] : [];
  }
  return using.flatMap((l) => l.uses!.filter((n) => !declared.names.includes(n)).map((n) => ({ message: `${l.id} utilise la ressource « ${n} », non déclarée dans ${declared.file} (resources:)` })));
}
