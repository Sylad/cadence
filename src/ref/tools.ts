import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RafError } from '../plan.js';

interface ToolSpec {
  /** Nom affiché ; la commande est cherchée sous chacun des `commands` (ImageMagick 7 : magick, 6 : convert). */
  name: string;
  commands: string[];
  install: string;
}

const POPPLER = 'sudo apt install poppler-utils';

/** Les outils du système dont `cadence ref` dépend, dans l'ordre où l'erreur les nomme. */
const TOOLS: ToolSpec[] = [
  { name: 'pdftoppm', commands: ['pdftoppm'], install: POPPLER },
  { name: 'pdftotext', commands: ['pdftotext'], install: POPPLER },
  { name: 'pdfimages', commands: ['pdfimages'], install: POPPLER },
  { name: 'pdfinfo', commands: ['pdfinfo'], install: POPPLER },
  { name: 'pdftohtml', commands: ['pdftohtml'], install: POPPLER },
  { name: 'magick', commands: ['magick', 'convert'], install: 'sudo apt install imagemagick' },
  { name: 'tesseract', commands: ['tesseract'], install: 'sudo apt install tesseract-ocr' },
];

export type ToolPaths = Record<string, string>;

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(command: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir && executable(join(dir, command))) return join(dir, command);
  }
  return null;
}

/**
 * Chemin absolu de chaque outil, cherché dans le PATH de l'environnement de la commande. Un outil absent est nommé avec sa
 * commande d'installation (une ligne par outil), la commande sort en 2 : rien n'est installé d'office.
 */
export function requireTools(env: NodeJS.ProcessEnv): ToolPaths {
  const path = env.PATH ?? '';
  const found: ToolPaths = {};
  const missing: string[] = [];
  for (const t of TOOLS) {
    const hit = t.commands.map((c) => which(c, path)).find((p) => p !== null);
    if (hit) found[t.name] = hit;
    else missing.push(`  ${t.commands.join(' ou ')} : ${t.install}`);
  }
  if (missing.length > 0) throw new RafError(`ref : outil absent du PATH, à installer (rien n'est installé d'office) :\n${missing.join('\n')}`);
  return found;
}
