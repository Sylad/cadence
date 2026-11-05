import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { docSyncSet } from './docsync.js';
import { RafError } from './plan.js';
import { isObject, list, readYamlKey } from './yaml-keys.js';

/** Une entrée de la clé `bounds` de cadence.yaml (L626) : les bornes de fichiers que l'écrivain doit tenir, et les tests qui lisent ces fichiers (faute de lien d'import, `vitest related` ne les trouve pas). */
export interface Bound {
  /** Motifs des fichiers bornés (mêmes motifs que `docs.sync`). */
  paths: string[];
  /** Nombre de lignes au plus. */
  lines?: number;
  /** Colonnes au plus, hors lignes de balise (`<img …>`). */
  columns?: number;
  /** Caractères au plus (un accent compte pour un). */
  chars?: number;
  /** Tests qui lisent ces fichiers, joués par la porte dès qu'un lot touche l'un d'eux. */
  tests: string[];
}

const KEYS = ['paths', 'lines', 'columns', 'chars', 'tests'];
const LIMITS = ['lines', 'columns', 'chars'] as const;

/** Un chemin de test relatif au dépôt, sans « .. ». */
const relativePath = (x: string): boolean => !!x.trim() && !isAbsolute(x) && !x.split(/[\\/]/).includes('..');

/** La clé `bounds:` de `file` : liste vide quand le fichier ou la clé manquent ; `RafError` sur une forme refusée. */
export function readBounds(file: string): Bound[] {
  const raw = readYamlKey(file, 'bounds');
  if (raw == null) return [];
  const bad = (what: string) => new RafError(`${file} : bounds${what}`);
  if (!Array.isArray(raw)) throw bad(' : liste attendue (bounds: [{ paths: [README.md], lines: 64 }])');
  return raw.map((entry, i) => {
    if (!isObject(entry)) throw bad(`[${i}] : objet attendu`);
    for (const k of Object.keys(entry)) if (!KEYS.includes(k)) throw bad(`[${i}].${k} inconnu (attendu : ${KEYS.join(', ')})`);
    const paths = list(entry.paths).map((p) => p.trim());
    if (!paths.length || paths.some((p) => !p)) throw bad(`[${i}].paths : au moins un motif de chemin non vide attendu`);
    const tests = list(entry.tests).map((t) => t.trim());
    if (tests.some((t) => !relativePath(t))) throw bad(`[${i}].tests : chemins relatifs au dépôt, sans « .. »`);
    const bound: Bound = { paths, tests };
    for (const k of LIMITS) {
      const v = entry[k];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad(`[${i}].${k} : entier supérieur ou égal à 1 attendu`);
      bound[k] = v;
    }
    return Object.fromEntries(Object.entries(bound).sort(([a], [b]) => KEYS.indexOf(a) - KEYS.indexOf(b))) as unknown as Bound;
  });
}

/** Les dépassements de `text` pour une borne, un message par limite : « f.md : 4 lignes, limite 3 ». */
function measure(file: string, text: string, b: Bound): string[] {
  // Lignes comptées comme le test R10 de readme-accueil : `split('\n')`, la ligne vide après le retour final comprise (un README de 64 lignes `wc -l` en compte 65).
  const lines = text.split('\n');
  const out: string[] = [];
  if (b.lines !== undefined && lines.length > b.lines) out.push(`${file} : ${lines.length} lignes, limite ${b.lines}`);
  if (b.columns !== undefined) {
    const at = lines.findIndex((l) => !l.trim().startsWith('<') && l.length > b.columns!);
    if (at >= 0) out.push(`${file} : ligne ${at + 1} de ${lines[at]!.length} colonnes, limite ${b.columns}`);
  }
  if (b.chars !== undefined && text.length > b.chars) out.push(`${file} : ${text.length} caractères, limite ${b.chars}`);
  return out;
}

/** Les bornes dépassées par `file` (chemin relatif à `root`), vide quand il les tient, n'existe pas ou n'est borné par aucune entrée. */
export function violations(root: string, file: string, bounds: Bound[]): string[] {
  const path = join(root, file);
  const mine = bounds.filter((b) => docSyncSet(b.paths)(file));
  if (!mine.length || !existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return mine.flatMap((b) => measure(file, text, b));
}

/** Le dossier du dépôt d'un fichier écrit : le plus proche dossier parent qui porte un `cadence.yaml`, ou null. */
function projectOf(file: string): string | null {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'cadence.yaml'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Ce que le hook après écriture répond pour `file` (absolu ou relatif à `cwd`) : les dépassements de ses bornes, ligne mesurée et limite, ou null. Ne lève jamais : une config illisible ne gêne pas l'écriture. */
export function writeReport(file: string, cwd: string): string | null {
  try {
    const abs = resolve(cwd, file);
    const root = projectOf(abs);
    if (!root) return null;
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    const found = violations(root, rel, readBounds(join(root, 'cadence.yaml')));
    return found.length ? found.map((f) => `borne dépassée : ${f}`).join('\n') : null;
  } catch {
    return null;
  }
}

/** Phrase des limites d'une borne : « 64 lines, 160 columns ». */
const limitsOf = (b: Bound): string => [b.lines && `${b.lines} lines`, b.columns && `${b.columns} columns`, b.chars && `${b.chars} characters`].filter(Boolean).join(', ');

/** La consigne du brief d'écriture (L626) : toutes les bornes chiffrées du dépôt, une ligne par motif (le fichier qu'un lot touche n'est connu qu'après l'écriture, et le texte d'un lot cite rarement un README), ou '' sans limite chiffrée. */
export function boundsText(bounds: Bound[]): string {
  const lines = bounds.flatMap((b) => (limitsOf(b) ? b.paths.map((p) => `- \`${p}\`: ${limitsOf(b)}`) : []));
  if (!lines.length) return '';
  return `Size bounds of the files of this repository (cadence.yaml \`bounds\`): stay within them as you write, a file over its bound costs a gate pass. A hook measures the file after each write and answers the line and the limit.\n${lines.join('\n')}`;
}

/** Les tests déclarés par les entrées dont un fichier touché correspond aux `paths`, sans doublon, dans l'ordre des entrées. */
export function declaredTests(bounds: Bound[], files: string[]): string[] {
  return [...new Set(bounds.filter((b) => files.some(docSyncSet(b.paths))).flatMap((b) => b.tests))];
}
