import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { RafError } from './plan.js';
import { claudeConfigDir, projectLogDir } from './orchestrate/launch.js';

/** Taille (octets) au-delà de laquelle l'index MEMORY.md est signalé quand `memory.indexMaxBytes` n'est pas posé (L442). */
const MEMORY_INDEX_MAX_BYTES = 12_000;

/** L'index de la mémoire de Claude Code du dossier `dir` (celui où la session est lancée, jamais la racine git). */
function memoryIndexPath(env: MemoryEnv, dir: string): string {
  return join(projectLogDir(claudeConfigDir(env), dir), 'memory', 'MEMORY.md');
}

// « - », puis au plus « ** », « [ » et « ⚠ », puis un jour « jj-mm » : le nom du fichier lié ne compte pas.
const DATED = /^- (?:\*\*)?\[?(?:⚠️?\s*)?(?:0[1-9]|[12]\d|3[01])-(?:0[1-9]|1[0-2])(?!\d)/;

/** Les entrées datées d'un index : leur nombre et leur poids en octets (fin de ligne comprise). */
function datedEntries(text: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const line of text.split('\n')) {
    const bare = line.replace(/\r$/, '');
    if (!DATED.test(bare)) continue;
    count++;
    bytes += Buffer.byteLength(bare) + 1;
  }
  return { count, bytes };
}

type MemoryCheck =
  | { kind: 'ok' }
  | { kind: 'unreadable'; cause: string }
  | { kind: 'over'; size: number; max: number; count: number; bytes: number };

/** Mesure l'index : absent ou au plus égal au seuil = `ok` ; une lecture impossible se dit au lieu de lever. Ne modifie rien. */
function checkMemoryIndex(env: MemoryEnv, dir: string, max: number): MemoryCheck {
  let buf: Buffer;
  try {
    buf = readFileSync(memoryIndexPath(env, dir));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'ok' } : { kind: 'unreadable', cause: `${code ?? 'erreur'} : ${(e as Error).message.split('\n')[0]}` };
  }
  if (buf.length <= max) return { kind: 'ok' };
  return { kind: 'over', size: buf.length, max, ...datedEntries(buf.toString('utf8')) };
}

const NO_DATED = "aucune entrée datée à regrouper dans l'index MEMORY.md";

/** Les lignes de la section « Mémoire » de `session close`, précédée d'une ligne vide (aucune quand l'index est sain). */
function closeLines(c: MemoryCheck): string[] {
  if (c.kind === 'ok') return [];
  if (c.kind === 'unreadable') return [`\nMémoire : l'index MEMORY.md est illisible (${c.cause}), sa taille n'est pas contrôlée`];
  return [
    `\nMémoire : l'index MEMORY.md pèse ${c.size} octets (seuil ${c.max})`,
    c.count === 0
      ? `  ${NO_DATED}`
      : `  ${c.count} entrée(s) datée(s) (${c.bytes} octets) à regrouper sous une ligne vers un index secondaire — le skill propose, l'humain décide`,
  ];
}

function tourLines(c: MemoryCheck): string[] {
  if (c.kind === 'ok') return [];
  if (c.kind === 'unreadable') return [`mémoire · MEMORY.md illisible (${c.cause})`];
  const tail = c.count === 0 ? 'aucune entrée datée à regrouper' : `${c.count} entrée(s) datée(s) à regrouper (cadence session close détaille)`;
  return [`mémoire · MEMORY.md ${c.size} octets > seuil ${c.max} · ${tail}`];
}

/**
 * Clé `memory.indexMaxBytes` de cadence.yaml : seuil, en octets, de l'avertissement ; `undefined` quand elle est absente.
 * Une valeur qui n'est pas un entier ≥ 1 est refusée.
 */
function readMemoryIndexMax(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const m = (raw as { memory?: unknown } | null)?.memory;
  if (m == null) return undefined;
  if (typeof m !== 'object' || Array.isArray(m)) throw new RafError(`${file} : memory doit être un objet { indexMaxBytes }`);
  for (const k of Object.keys(m)) if (k !== 'indexMaxBytes') throw new RafError(`${file} : memory.${k} inconnu (attendu : indexMaxBytes)`);
  const v = (m as { indexMaxBytes?: unknown }).indexMaxBytes;
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new RafError(`${file} : memory.indexMaxBytes doit être un entier ≥ 1 (octets), pas ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return v;
}

type MemoryEnv = Record<string, string | undefined>;

/**
 * Pour `session close` : le contexte de la mesure, relu à l'appel (une clé invalide lève alors avant tout rapport). Le seuil vient
 * du `cadence.yaml` que la commande lit.
 */
export function closeMemoryLines(env: MemoryEnv, dir: string, configFile: string): () => string[] {
  return () => closeLines(checkMemoryIndex(env, dir, readMemoryIndexMax(configFile) ?? MEMORY_INDEX_MAX_BYTES));
}

/**
 * Pour `lead tour` : la ligne « mémoire » du dossier parent, avec le seuil de son cadence.yaml. Une clé invalide n'arrête pas le tour : une ligne d'erreur
 * remplace la ligne « mémoire » ; un cadence.yaml illisible a déjà sa ligne d'erreur en tête de tour et n'en ajoute pas ici.
 */
export function tourMemoryLines(env: MemoryEnv, parent: string): string[] {
  try {
    return tourLines(checkMemoryIndex(env, parent, readMemoryIndexMax(join(parent, 'cadence.yaml')) ?? MEMORY_INDEX_MAX_BYTES));
  } catch (e) {
    const message = (e as Error).message;
    return / : memory/.test(message) ? [`cadence.yaml · ✗ erreur : ${message.replace(/^.*cadence\.yaml : /, '')}`] : [];
  }
}
