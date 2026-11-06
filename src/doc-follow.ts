import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';

// L648 : une doc périmée par un correctif. Les identifiants que le diff d'un `fix(` change (déclarations exportées retirées ou ajoutées ;
// options `--x` qui apparaissent ou disparaissent du code de src/, hors aide HELP et hors commentaire : pas celles qu'un commentaire ou un message cite alors que le code les lit déjà)
// sont cherchés dans la documentation (README.md, docs/*.md : entre accents graves ; l'aide `HELP` de src/cli.ts : les options) ;
// une ligne qui les cite et que le diff ne touche pas est une doc qui ne suit pas le correctif.

/** Une ligne de documentation qui cite un identifiant ; `touched` : le diff la touche (elle a suivi). */
interface Citation {
  id: string;
  file: string;
  line: number;
  text: string;
  touched: boolean;
}

const DECLARATION = /\bexport\s+(?:(?:default|declare|abstract|async)\s+)*(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/g;
const MIN_LENGTH = 4;

/** La ligne sans son commentaire : rien d'une ligne `//`, `*` ou `/*`, et la queue `// …` retirée (une option qu'un commentaire cite n'est pas lue par le code). */
const codeOf = (l: string): string => (/^\s*(\/\/|\/?\*)/.test(l) ? '' : l.replace(/\s\/\/.*$/, ''));

/** Les identifiants cités par ces lignes de code : noms déclarés ET exportés (export function, const, class, type…) d'au moins 4 caractères (une variable locale n'est pas un identifiant de la doc) et options `--x` hors commentaire. */
function identifiersOf(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(DECLARATION)) if (m[1]!.length >= MIN_LENGTH) ids.add(m[1]!);
    for (const m of codeOf(l).matchAll(FLAG)) ids.add(m[0]);
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

/** Les lignes `lines` (numérotées de 1) qui citent un des identifiants, marquées `touched` quand le diff les touche. `optionsOnly` : l'aide, où seules les options comptent. */
function citationsOf(file: string, lines: string[], ids: string[], touched: Set<number>, optionsOnly = false): Citation[] {
  const out: Citation[] = [];
  lines.forEach((text, i) => {
    for (const id of ids) if (cites(text, id, optionsOnly)) out.push({ id, file, line: i + 1, text: text.trim(), touched: touched.has(i + 1) });
  });
  return out;
}

/** Les citations que `touched` ne contient pas : la doc qui ne suit pas. */
export const staleCitations = (file: string, lines: string[], ids: string[], touched: Set<number>, optionsOnly = false): Citation[] => citationsOf(file, lines, ids, touched, optionsOnly).filter((c) => !c.touched);

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

/** Un fichier d'un côté de la vue : `before`, la révision `from` (sinon HEAD) ; `after`, l'arbre de travail (sinon l'index). */
function sideContent(view: View, file: string, side: 'before' | 'after'): string[] | null {
  if (side === 'after') return contentOf(view, file);
  try {
    return git(view.root, ['show', `${view.from ?? 'HEAD'}:${file}`]).split('\n');
  } catch {
    return null;
  }
}

/**
 * L'option est-elle présente dans le code de src/ de ce côté de la vue, hors de l'aide `HELP` (la doc qu'on vérifie, pas le code qui lit l'option) ?
 * Une option du diff présente des deux côtés (un commentaire, un message, un argument passé à git qui la citent) n'est ni retirée ni ajoutée.
 */
function optionPresent(view: View, option: string, side: 'before' | 'after'): boolean {
  const rev = view.from ?? 'HEAD';
  const where = side === 'before' ? [rev] : view.from ? [] : ['--cached'];
  let found: string;
  try {
    found = git(view.root, ['grep', '-n', '-I', '-F', '-e', option, ...where, '--', ...sourceFiles]);
  } catch {
    return false; // code 1 : aucune occurrence ; sans HEAD (premier commit) : rien avant
  }
  const cli = sideContent(view, CLI_FILE, side);
  const help = cli && helpRange(cli);
  const prefix = side === 'before' ? `${rev}:` : '';
  const re = wordRe(option);
  return found.split('\n').some((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l.startsWith(prefix) ? l.slice(prefix.length) : l);
    if (!m) return false;
    const inHelp = m[1] === CLI_FILE && help !== null && Number(m[2]) - 1 >= help.from && Number(m[2]) - 1 <= help.to;
    return !inHelp && re.test(m[3]!);
  });
}

/** Les identifiants que la vue retire ou ajoute : déclarations exportées d'un seul côté du diff ; options présentes dans src/ d'un seul côté de la vue. */
function changedIdentifiersOf(view: View): string[] {
  const { removed, added } = sourceChange(view);
  return changedIdentifiers(removed, added).filter((id) => !id.startsWith('--') || optionPresent(view, id, 'before') !== optionPresent(view, id, 'after'));
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

/** Les identifiants que la vue retire ou ajoute et toutes les citations de la doc trackée et de l'aide, touchées ou non. Le commit en préparation par défaut ; avec `from`, le travail depuis cette révision. */
function docCitations(root: string, from?: string): { ids: string[]; citations: Citation[] } {
  const view: View = { root, from };
  const ids = changedIdentifiersOf(view);
  if (ids.length === 0) return { ids, citations: [] };
  const docs = git(root, ['ls-files', '-z', '--', 'README.md', 'docs']).split('\0').filter((f) => f === 'README.md' || /^docs\/[^/]+\.md$/.test(f));
  const citations: Citation[] = [];
  for (const file of docs) {
    const lines = contentOf(view, file);
    if (lines) citations.push(...citationsOf(file, lines, ids, touchedLines(diffOf(view, file))));
  }
  const cli = contentOf(view, CLI_FILE);
  const range = cli && helpRange(cli);
  if (cli && range) {
    const touched = touchedLines(diffOf(view, CLI_FILE));
    const help = cli.slice(range.from, range.to + 1);
    const shift = range.from;
    citations.push(...citationsOf(CLI_FILE, help, ids, new Set([...touched].map((n) => n - shift)), true).map((c) => ({ ...c, line: c.line + shift })));
  }
  return { ids, citations };
}

/** Les citations périmées de la vue : celles que son diff ne touche pas (le hook). */
export const staleDocCitations = (root: string, from?: string): Citation[] => docCitations(root, from).citations.filter((c) => !c.touched);

/** La raison d'un `docs-ok: <raison>` du message (une ligne du corps ou du sujet, raison non vide), ou null. */
export function docsOkReason(message: string): string | null {
  return /^docs-ok\s*:\s*(\S.*)$/im.exec(message)?.[1]?.trim() ?? null;
}

/** Un message de `fix(` : le sujet commence par `fix(`. */
export const isFixCommit = (message: string): boolean => /^fix\(/.test(message);

/**
 * La consigne du brief fix (L648), dès que le travail du lot depuis `from` retire ou ajoute un identifiant : les identifiants, les lignes de doc et d'aide qui les citent
 * (non touchées d'abord, puis celles que le lot a mises à jour : le correctif porte le plus souvent sur ce que le lot vient d'écrire), et l'exigence de relister sur son
 * propre diff ; '' quand le lot ne change aucun identifiant. Le correctif n'est pas écrit : la liste est celle du diff du lot.
 */
export function docsFollowText(root: string, from: string): string {
  const { ids, citations } = docCitations(root, from);
  if (ids.length === 0) return '';
  const sorted = [...citations.filter((c) => !c.touched), ...citations.filter((c) => c.touched)];
  const lines = sorted.slice(0, 20).map((c) => `- \`${c.file}:${c.line}\` cites \`${c.id}\` — ${c.touched ? 'updated by the lot' : 'not touched by the lot'}: ${c.text.slice(0, 100)}`);
  const more = sorted.length > lines.length ? [`- … ${sorted.length - lines.length} more`] : [];
  const list = lines.length ? [...lines, ...more] : ['- (no line of README.md, docs/*.md or the help cites them yet)'];
  return `Identifiers this lot's diff removes or adds (L648): ${ids.map((id) => `\`${id}\``).join(', ')}. A fix that changes one of these identifiers, or any other, updates the documentation lines that cite it in the same commit (the \`fix(\` commit hook \`hook.docs\` refuses it otherwise; \`docs-ok: <reason>\` in the message when the line stays true). The list below is the lot's diff, not yours: re-list the lines for the identifiers YOUR diff changes before committing (\`git grep -n <identifier> -- README.md docs\` and the help in \`src/cli.ts\`). Lines that cite them now:\n${list.join('\n')}`;
}
