import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readReferencesConfig } from '../config.js';
import { gitRoot } from '../git.js';
import { RafError } from '../plan.js';
import type { Figure, Unresolved } from './figures.js';
import type { PageText } from './pdf.js';

export interface StoredImage {
  page: number;
  /** Fichier extrait, relatif au dossier du document ; null tant que la page n'est pas rendue. */
  file: string | null;
  /** Région en pixels de la page rendue à 200 dpi ; null tant que la page n'est pas rendue. */
  x: number | null;
  y: number | null;
  l: number | null;
  h: number | null;
}

export interface StoredPage extends PageText {
  rendered: boolean;
}

export interface StoredDocument {
  slug: string;
  source: string;
  sha256: string;
  added: string;
  dpi: number;
  sections: string | null;
  tools: Record<string, string>;
  pages: StoredPage[];
  images: StoredImage[];
  figures: Figure[];
  unresolved: Unresolved[];
}

/**
 * Dossier des documents : `references.dir` de cadence.yaml (relatif à son dossier), sinon `$XDG_DATA_HOME/cadence/references`.
 * Un `references.dir` dans un dépôt Git est refusé : les documents de référence peuvent être privés, ils ne se commitent pas.
 */
export function referencesDir(root: string, configPath: string, env: NodeJS.ProcessEnv): string {
  const dir = readReferencesConfig(configPath).dir;
  if (dir === undefined) return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'cadence', 'references');
  const abs = resolve(dirname(configPath), dir);
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (gitRoot(probe)) throw new RafError(`ref : references.dir (${abs}) est dans un dépôt Git : les documents de référence restent hors du dépôt (choisir un dossier ailleurs, ou retirer la clé pour $XDG_DATA_HOME/cadence/references)`);
  return abs;
}

export const documentFile = (docDir: string): string => join(docDir, 'document.json');

export function readDocument(docDir: string): StoredDocument | null {
  const file = documentFile(docDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredDocument;
  } catch (e) {
    throw new RafError(`ref : ${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
}

export function writeDocument(docDir: string, doc: StoredDocument): void {
  mkdirSync(docDir, { recursive: true });
  const tmp = `${documentFile(docDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, documentFile(docDir));
}
