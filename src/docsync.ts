import { changedFiles, type Commit } from './git.js';

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

/** Fichiers modifiés par un ensemble de commits, sans doublon. */
export function filesOf(root: string, commits: Commit[]): Set<string> {
  return new Set(commits.flatMap((c) => changedFiles(root, c.sha)));
}

/** Les règles que ces fichiers enfreignent : ils touchent `paths` sans qu'aucun `docs` ne soit parmi eux. */
export function docSyncGaps(rules: DocSyncRule[], files: Set<string>): DocSyncGap[] {
  const gaps: DocSyncGap[] = [];
  for (const rule of rules) {
    if ([...files].some(docSyncSet(rule.docs))) continue;
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
