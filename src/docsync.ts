import { resolve } from 'node:path';
import type { ArticleRule } from './articles.js';
import { changedFiles, changedLines, type Commit } from './git.js';

const REFACTOR = /^refactor(\([^)]*\))?:/;
const CORRECTION = /^(fix|test|chore|style)(\([^)]*\))?:/;
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/**
 * Une ligne qui ne change ni commande, ni clé, ni sortie : vide, commentaire (`//`, bloc fermé en fin de ligne ou ouvert, fermeture
 * seule, ligne `* …` de JSDoc) ou import d'une seule ligne et rien après. Une ligne `* …` qui se termine par `;` est la suite d'une expression (multiplication), donc du code.
 */
const INERT_LINE = /^\s*($|\/\/|\/\*(?!.*\*\/)|\/\*.*\*\/\s*$|\*\/\s*$|\*(?!.*;\s*$)(\s.*)?$|import\s[^;]*\sfrom\s+['"][^'"]*['"];?\s*$|import\s*['"][^'"]*['"];?\s*$|\}\s*from\s+['"][^'"]*['"];?\s*$)/;

const BREAKING = (c: Commit) => /^BREAKING[ -]CHANGE:/m.test(c.body);

/** Un commit de correction (fix, test, chore, style) dont le diff ne touche que des tests, des commentaires et des imports. */
function isInertCorrection(root: string, c: Commit): boolean {
  if (!CORRECTION.test(c.subject) || BREAKING(c)) return false;
  for (const [file, lines] of changedLines(root, c.sha)) if (!TEST_FILE.test(file) && !withoutExportToggles(lines).every((l) => INERT_LINE.test(l))) return false;
  return true;
}

/**
 * Écarte les lignes que le commit ne fait que (dé)exporter : la même déclaration retirée avec `export ` et ajoutée sans (ou
 * l'inverse) rend un symbole interne au module, sans commande, clé ni sortie changée (L490 : `export async function refusal` → `async function refusal`).
 */
function withoutExportToggles(lines: string[]): string[] {
  const bare = (l: string) => l.replace(/^(\s*)export\s+(?!default\b)/, '$1');
  const exported = new Set(lines.filter((l) => bare(l) !== l).map(bare));
  const plain = new Set(lines.filter((l) => bare(l) === l));
  const toggled = (l: string) => (bare(l) !== l ? plain.has(bare(l)) : exported.has(l));
  return lines.filter((l) => !toggled(l));
}

/**
 * Commits dont les fichiers comptent pour `docs.sync` (L537, L542) : ceux de type `refactor` (`refactor(L1): …`) sont un nettoyage ou
 * un découpage déclaré sans changement de commande, de clé ni de sortie, donc sans document à écrire. `refactor!` et un refactor
 * dont le corps porte le pied `BREAKING CHANGE:` restent un changement. Les commits de correction qui suivent le plus ancien refactor
 * du lot (imports, tests, commentaires seuls : le diff entier reste sans changement visible) sont écartés de même ; un fix qui touche
 * une autre ligne de code, ou qui précède le refactor, reste un changement.
 */
function docSyncCommits(root: string, commits: Commit[]): Commit[] {
  const isRefactor = (c: Commit) => REFACTOR.test(c.subject) && !BREAKING(c);
  // Les commits d'un lot vont du plus récent au plus ancien : « après le refactor » veut dire avant lui dans la liste.
  const oldestRefactor = commits.map(isRefactor).lastIndexOf(true);
  return commits.filter((c, i) => !isRefactor(c) && !(i < oldestRefactor && isInertCorrection(root, c)));
}

/** Les écarts d'un lot : les fichiers de `paths` viennent des commits qui comptent, mais un document écrit dans un refactor reste écrit. */
export function lotDocSyncGaps(rules: DocSyncRule[], root: string, commits: Commit[]): DocSyncGap[] {
  return docSyncGaps(rules, filesOf(root, docSyncCommits(root, commits)), filesOf(root, commits));
}

/** Une paire de la clé `docs.sync` de cadence.yaml : si des commits touchent `paths`, ils touchent aussi un des `docs`. */
export interface DocSyncRule {
  paths: string[];
  docs: string[];
}

/** Ce que le programme calcule pour un lot : les fichiers touchés d'un côté, les documents attendus de l'autre. */
export interface DocSyncGap {
  rule: DocSyncRule;
  /** Fichiers du lot qui correspondent à `paths` (triés). */
  touched: string[];
}

/** Motif de chemin : `*` reste dans un dossier, `**` le traverse, `?` un caractère, un `/` final prend tout le dossier ; sinon chemin exact. */
export function docSyncMatcher(pattern: string): (file: string) => boolean {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const source = (p.endsWith('/') ? `${p}**` : p)
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${source}$`);
  return (file) => re.test(file);
}

/** Liste de motifs : un fichier en fait partie s'il correspond à un motif et à aucun motif « !… » (exclusion, ex. `!**\/*.test.ts`). */
export function docSyncSet(patterns: string[]): (file: string) => boolean {
  const yes = patterns.filter((p) => !p.startsWith('!')).map(docSyncMatcher);
  const no = patterns.filter((p) => p.startsWith('!')).map((p) => docSyncMatcher(p.slice(1)));
  return (file) => yes.some((m) => m(file)) && !no.some((m) => m(file));
}

/** Fichiers modifiés par un ensemble de commits, sans doublon ; `withoutDeleted` écarte les fichiers que les commits suppriment. */
export function filesOf(root: string, commits: Commit[], opts: { withoutDeleted?: boolean } = {}): Set<string> {
  return new Set(commits.flatMap((c) => changedFiles(root, c.sha, opts)));
}

/** Les règles que ces fichiers enfreignent : ils touchent `paths` sans qu'aucun `docs` ne soit parmi les fichiers `written`. */
function docSyncGaps(rules: DocSyncRule[], files: Set<string>, written: Set<string>): DocSyncGap[] {
  const gaps: DocSyncGap[] = [];
  for (const rule of rules) {
    if ([...written].some(docSyncSet(rule.docs))) continue;
    const inPaths = docSyncSet(rule.paths);
    const touched = [...files].filter(inPaths).sort();
    if (touched.length) gaps.push({ rule, touched });
  }
  return gaps;
}

const SHOWN = 5;

/** `a, b, c, … (+2)` : les premiers fichiers, le reste compté. */
function listFiles(files: string[]): string {
  return files.length <= SHOWN ? files.join(', ') : `${files.slice(0, SHOWN).join(', ')}, … (+${files.length - SHOWN})`;
}

/** La ligne de `raf check` et de `cadence lead tour` pour un lot. */
export function gapMessage(lot: string, gap: DocSyncGap): string {
  return `${lot} : documentation en retard — ${listFiles(gap.touched)} sans toucher ${gap.rule.docs.join(' ou ')} (docs.sync)`;
}

/**
 * Consigne du brief de revue (L143) : la liste calculée par le programme, à passer en constat majeur. Vide sans règle
 * déclarée ; sans écart, une ligne qui dit que le programme a vérifié (le relecteur juge encore le contenu).
 */
export function docSyncBrief(rules: DocSyncRule[], gaps: DocSyncGap[]): string {
  if (!rules.length) return '';
  if (!gaps.length) return 'Documentation (cadence.yaml docs.sync): the program checked that the commits of the lot touch the documents their paths call for. Still read the documents themselves against the change.';
  return [
    'Documentation (cadence.yaml docs.sync): the program computed that the commits of the lot touch code without touching the document that describes it. Report ONE MAJOR finding per line below, quoting the line, unless the change really leaves the document true (say why then):',
    ...gaps.map((g) => `- ${listFiles(g.touched)} changed, but none of ${g.rule.docs.join(', ')} was touched`),
  ].join('\n');
}

/** Dossier du dépôt qui porte un document hors dépôt : `repo` relatif à la racine du projet, ou absolu (résolu tel quel). */
export const articleRepoDir = (root: string, rule: ArticleRule): string => resolve(root, rule.repo);

/**
 * Consigne du bibliothécaire (L306, L308) sur les documents hors dépôt : seulement ceux que la configuration déclare (`docs.articles` du cadence.yaml du projet).
 * Vide sans entrée. Le dépôt du document est ouvert à la session en lecture (--add-dir) ; le bibliothécaire ne l'écrit pas : il propose un lot pour le plan de ce dépôt.
 */
export function articlesBrief(root: string, rules: ArticleRule[]): string {
  if (!rules.length) return '';
  return [
    'Documents outside this repository, declared by the configuration (docs.articles of cadence.yaml): the project is also described by',
    ...rules.map((r) => `- \`${r.file}\` of the repository \`${r.repo}\` (${articleRepoDir(root, r)}, open to this session for reading)`),
    'If the change makes one of them false or leaves it out, do not edit it and do not touch the plan of that repository: write a proposed lot (a title, then the file, the passage and the sentence to change) and put it in the "resume" of your report, starting with « lot proposé ». Read it to be exact; read it only.',
  ].join('\n');
}
