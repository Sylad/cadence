import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';

// L648 : une doc périmée par un correctif. Les identifiants que le diff d'un `fix(` change (déclarations retirées ou ajoutées, options `--x`)
// sont cherchés dans la documentation (README.md, docs/*.md : entre accents graves ; l'aide `HELP` de src/cli.ts : les options) ;
// une ligne qui les cite et que le diff ne touche pas est une doc qui ne suit pas le correctif.

/** Une ligne de documentation qui cite un identifiant. */
interface Citation {
  id: string;
  file: string;
  line: number;
  text: string;
}

const DECLARATION = /\b(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/g;
const MIN_LENGTH = 4;

/** Les identifiants cités par ces lignes de code : noms déclarés (function, const, class, type…) d'au moins 4 caractères et options `--x`. */
function identifiersOf(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(DECLARATION)) if (m[1]!.length >= MIN_LENGTH) ids.add(m[1]!);
    for (const m of l.matchAll(FLAG)) ids.add(m[0]);
  }
  return ids;
}

/** Les identifiants retirés ou ajoutés par un diff : ceux d'un côté seulement (une déclaration déplacée ou dont seul le corps change n'est ni l'un ni l'autre). */
export function changedIdentifiers(removed: string[], added: string[]): string[] {
  const before = identifiersOf(removed);
  const after = identifiersOf(added);
  return [...before, ...after].filter((id) => before.has(id) !== after.has(id)).sort();
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (id: string): RegExp => new RegExp(`(?<![\\w$-])${escape(id)}(?![\\w$-])`);

/** La ligne cite-t-elle l'identifiant ? Une option, n'importe où ; un nom, dans un segment entre accents graves seulement (le mot nu d'une phrase n'est pas une citation). */
function cites(text: string, id: string, optionsOnly: boolean): boolean {
  const re = wordRe(id);
  if (id.startsWith('--')) return re.test(text);
  if (optionsOnly) return false;
  return [...text.matchAll(/`([^`]+)`/g)].some((m) => re.test(m[1]!));
}

/** Les lignes `lines` (numérotées de 1) qui citent un des identifiants et que `touched` ne contient pas. `optionsOnly` : l'aide, où seules les options comptent. */
export function staleCitations(file: string, lines: string[], ids: string[], touched: Set<number>, optionsOnly = false): Citation[] {
  const out: Citation[] = [];
  lines.forEach((text, i) => {
    if (touched.has(i + 1)) return;
    for (const id of ids) if (cites(text, id, optionsOnly)) out.push({ id, file, line: i + 1, text: text.trim() });
  });
  return out;
}

/** Les lignes du fichier que le diff `-U0` ajoute ou remplace (numéros du fichier nouveau). */
export function touchedLines(diff: string): Set<number> {
  const touched = new Set<number>();
  for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) touched.add(start + i);
  }
  return touched;
}

/** Le texte de l'aide : les lignes de la constante `HELP` (template littéral) de src/cli.ts, avec leur numéro de ligne. */
function helpRange(lines: string[]): { from: number; to: number } | null {
  const from = lines.findIndex((l) => /^const HELP = `/.test(l));
  if (from < 0) return null;
  const end = lines.findIndex((l, i) => i > from && /`;\s*$/.test(l));
  return { from, to: end < 0 ? lines.length - 1 : end };
}

const CLI_FILE = 'src/cli.ts';
const sourceFiles = ['src/*.ts', 'src/**/*.ts'];

/** Ce qu'on compare : l'index au commit en cours (`from` absent : le hook) ou l'arbre de travail à la révision `from` (le brief du fix, sur le travail du lot). */
interface View {
  root: string;
  from?: string;
}

const diffOf = ({ root, from }: View, ...paths: string[]): string => git(root, ['-c', 'core.quotepath=off', 'diff', ...(from ? [from] : ['--cached']), '-U0', '--no-color', '--no-renames', '--', ...paths]);

/** Les lignes retirées et ajoutées du code source (src/**.ts) de la vue. */
function sourceChange(view: View): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const l of diffOf(view, ...sourceFiles).split('\n')) {
    if (/^(\+\+\+|---) /.test(l)) continue;
    if (l.startsWith('-')) removed.push(l.slice(1));
    else if (l.startsWith('+')) added.push(l.slice(1));
  }
  return { removed, added };
}

/** Un fichier tel que la vue le contient (l'index, ou l'arbre de travail), ou null. */
function contentOf({ root, from }: View, file: string): string[] | null {
  try {
    return (from ? readFileSync(join(root, file), 'utf8') : git(root, ['show', `:${file}`])).split('\n');
  } catch {
    return null;
  }
}

/** Le commit touche-t-il du code source (src/**.ts) ? */
export function touchesSource(staged: string[]): boolean {
  return staged.some((f) => /^src\/.*\.ts$/.test(f));
}

/** Toutes les citations périmées de la vue : docs trackées et aide, pour les identifiants que son diff de src/ retire ou ajoute. Le commit en préparation par défaut ; avec `from`, le travail depuis cette révision. */
export function staleDocCitations(root: string, from?: string): Citation[] {
  const view: View = { root, from };
  const { removed, added } = sourceChange(view);
  const ids = changedIdentifiers(removed, added);
  if (ids.length === 0) return [];
  const docs = git(root, ['ls-files', '-z', '--', 'README.md', 'docs']).split('\0').filter((f) => f.endsWith('.md'));
  const out: Citation[] = [];
  for (const file of docs) {
    const lines = contentOf(view, file);
    if (lines) out.push(...staleCitations(file, lines, ids, touchedLines(diffOf(view, file))));
  }
  const cli = contentOf(view, CLI_FILE);
  const range = cli && helpRange(cli);
  if (cli && range) {
    const touched = touchedLines(diffOf(view, CLI_FILE));
    const help = cli.slice(range.from, range.to + 1);
    const shift = range.from;
    out.push(...staleCitations(CLI_FILE, help, ids, new Set([...touched].map((n) => n - shift)), true).map((c) => ({ ...c, line: c.line + shift })));
  }
  return out;
}

/** La raison d'un `docs-ok: <raison>` du message (une ligne du corps ou du sujet, raison non vide), ou null. */
export function docsOkReason(message: string): string | null {
  return /^docs-ok\s*:\s*(\S.*)$/im.exec(message)?.[1]?.trim() ?? null;
}

/** Un message de `fix(` : le sujet commence par `fix(`. */
export const isFixCommit = (message: string): boolean => /^fix\(/.test(message);

/** La consigne du brief fix (L648) : les lignes de doc et d'aide qui citent un identifiant que le travail du lot depuis `from` retire ou ajoute, à mettre à jour dans le même commit que le correctif ; '' sans citation. Le correctif n'est pas écrit : la liste est celle du diff du lot, à relire sur le sien. */
export function docsFollowText(root: string, from: string): string {
  const stale = staleDocCitations(root, from);
  if (stale.length === 0) return '';
  const lines = stale.slice(0, 20).map((c) => `- \`${c.file}:${c.line}\` cites \`${c.id}\`: ${c.text.slice(0, 100)}`);
  const more = stale.length > lines.length ? [`- … ${stale.length - lines.length} more`] : [];
  return `Documentation that cites an identifier this lot's diff removes or adds (L648), and that the lot has not touched. A fix that changes one of these identifiers updates the documentation lines that cite it in the same commit (the \`fix(\` commit hook \`hook.docs\` refuses it otherwise; \`docs-ok: <reason>\` in the message when the line stays true). Re-list the lines for the identifiers YOUR diff changes before committing (\`git grep -n <identifier> -- README.md docs\` and the help in \`src/cli.ts\`):\n${[...lines, ...more].join('\n')}`;
}
