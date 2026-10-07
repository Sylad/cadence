import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { gitCommonDir, gitRoot, hooksDir } from '../git.js';

const MARK = '# cadence orchestrate — hook pre-push temporaire (retiré à la fin de la vague)';

const waveLine = (wave: string) => `# wave: ${wave}`;

const hook = (wave: string) => `#!/bin/sh
${MARK}
${waveLine(wave)}
# Une session lancée par l'orchestrateur porte CADENCE_ORCHESTRATED : elle ne pousse jamais.
if [ -n "$CADENCE_ORCHESTRATED" ]; then
  echo "cadence orchestrate : push refusé pendant la vague $CADENCE_ORCHESTRATED (le lead pousse)" >&2
  exit 1
fi
exit 0
`;

const hookPath = (repo: string) => join(hooksDir(repo), 'pre-push');

/**
 * Ligne d'exclusion du hook quand `core.hooksPath` pointe dans l'arbre suivi (maritime-atlas : `.githooks`) :
 * sans elle le hook temporaire serait un fichier non suivi du dépôt. null quand le hook est hors de l'arbre
 * (`.git/hooks`, dossier extérieur) : rien à exclure.
 */
function excludeLine(repo: string): string | null {
  const root = gitRoot(repo);
  if (!root) return null;
  const rel = relative(root, hookPath(repo));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const dotGit = relative(root, gitCommonDir(repo));
  if (rel === dotGit || rel.startsWith(`${dotGit}/`)) return null;
  return `/${rel.split('\\').join('/')}`;
}

const excludeFile = (repo: string) => join(gitCommonDir(repo), 'info', 'exclude');

function addExclude(repo: string): void {
  const line = excludeLine(repo);
  if (!line) return;
  const file = excludeFile(repo);
  mkdirSync(join(gitCommonDir(repo), 'info'), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(line)) return;
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
}

function removeExclude(repo: string): void {
  const line = excludeLine(repo);
  const file = excludeFile(repo);
  if (!line || !existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (!lines.includes(line)) return;
  writeFileSync(file, lines.filter((l) => l !== line).join('\n'));
}

/** Sorties du MCP Playwright écrites dans le dépôt par une session qui ne respecte pas son dossier de sortie (L50). */
const PW_DIR = '.playwright-mcp';
const PW_PATTERN = `/${PW_DIR}/`;
const PW_MARK = '# cadence orchestrate — sorties Playwright MCP exclues le temps de la vague';

/** Exclut `.playwright-mcp/` le temps de la vague ; une exclusion déjà présente n'est ni dupliquée ni retirée ensuite. */
function addPlaywrightExclude(repo: string): void {
  const file = excludeFile(repo);
  mkdirSync(join(gitCommonDir(repo), 'info'), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  if (lines.some((l) => l === PW_PATTERN || l === `${PW_DIR}/` || l === PW_DIR)) return;
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${PW_MARK}\n${PW_PATTERN}\n`);
}

function removePlaywrightExclude(repo: string): void {
  const file = excludeFile(repo);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  const i = lines.indexOf(PW_MARK);
  if (i < 0 || lines[i + 1] !== PW_PATTERN) return;
  lines.splice(i, 2);
  writeFileSync(file, lines.join('\n'));
}

/**
 * Supprime les fichiers NON SUIVIS de `.playwright-mcp/` (jamais un fichier suivi) ; le dossier part quand il est vide.
 * Jamais de lien suivi : racine ou entrée qui est un lien symbolique n'est pas parcourue (l'entrée est retirée elle-même,
 * la racine reste), et une racine ou un ancêtre suivi par git n'est pas parcouru (`ls-files` renvoie alors le chemin lui-même).
 */
export function cleanPlaywrightOutput(repo: string): void {
  const root = gitRoot(repo);
  if (!root) return;
  const dir = join(root, PW_DIR);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--', PW_DIR], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return;
  }
  if (tracked.includes(PW_DIR)) return;
  const keeps = (r: string) => tracked.some((t) => t === r || t.startsWith(`${r}/`) || r.startsWith(`${t}/`));
  const walk = (d: string, rel: string): boolean => {
    let empty = true;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      const full = join(d, e.name);
      if (keeps(r)) {
        // suivi, ou ancêtre d'un suivi : un dossier est parcouru pour ses entrées non suivies, un fichier ou un lien reste
        if (e.isDirectory() && !tracked.includes(r)) walk(full, r);
        empty = false;
      } else if (lstatSync(full).isDirectory()) {
        if (!walk(full, r)) empty = false;
      } else rmSync(full, { force: true }); // fichier ou lien : retiré lui-même, jamais suivi
    }
    if (empty) rmSync(d, { recursive: true, force: true });
    return empty;
  };
  walk(dir, PW_DIR);
}

/**
 * Pose le hook pre-push temporaire. Refus (raison) quand un autre hook pre-push existe : le remplacer
 * modifierait un fichier suivi (husky) ou sauterait une règle du projet. Un hook laissé par une vague
 * interrompue (même marque) est simplement remplacé.
 */
export function installPrePush(repo: string, wave = '?'): { ok: true } | { ok: false; reason: string } {
  const file = hookPath(repo);
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARK)) {
    return { ok: false, reason: `un hook pre-push existe déjà (${file}) : l'orchestrateur ne le remplace pas` };
  }
  mkdirSync(dirname(file), { recursive: true });
  addExclude(repo);
  addPlaywrightExclude(repo);
  writeFileSync(file, hook(wave));
  chmodSync(file, 0o755);
  return { ok: true };
}

/**
 * Retire le hook s'il est le nôtre ; avec `wave`, seulement s'il a été posé par cette vague (jamais celui d'une
 * autre vague vivante, qui garde aussi sa ligne d'exclusion). Hook supprimé ou remplacé par une session : la ligne
 * d'exclusion part quand même, sinon un futur pre-push du projet resterait invisible à git.
 */
export function removePrePush(repo: string, wave?: string): void {
  const file = hookPath(repo);
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(MARK)) {
      if (wave !== undefined && !text.split('\n').includes(waveLine(wave))) return;
      rmSync(file, { force: true });
    }
  }
  removeExclude(repo);
  removePlaywrightExclude(repo);
}

/** Pourrait-on poser le hook ? (préconditions, sans écrire) */
export function canInstallPrePush(repo: string): string | null {
  const file = hookPath(repo);
  return existsSync(file) && !readFileSync(file, 'utf8').includes(MARK) ? `un hook pre-push existe déjà (${file}) : l'orchestrateur ne le remplace pas` : null;
}

/** git sans bloquer la boucle d'événements (un `ls-remote` peut durer 20 s) ; null en cas d'échec ou de délai. */
function out(repo: string, args: string[], timeout = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    // trimEnd seulement : la première colonne d'un `status --porcelain` peut être une espace.
    execFile('git', args, { cwd: repo, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trimEnd()));
  });
}

/** Le hook temporaire (reconnu à sa marque) est-il en place ? */
export function guardPresent(repo: string): boolean {
  const file = hookPath(repo);
  return existsSync(file) && readFileSync(file, 'utf8').includes(MARK);
}

/** Ce qui change quand une session pousse : la référence amont locale et les têtes du dépôt distant. */
export interface Snapshot {
  head: string | null;
  /** `git status --porcelain` des fichiers suivis. */
  tracked: string[];
  untracked: string[];
  upstream: string | null;
  remote: string | null;
  /** Le hook pre-push de la vague est en place (un hook exclu de git n'apparaît plus dans le statut). */
  guard: boolean;
}

export async function snapshot(repo: string, opts: { remote?: boolean } = {}): Promise<Snapshot> {
  const [status, head, upstream, remote] = await Promise.all([
    out(repo, ['status', '--porcelain', '--untracked-files=all']),
    out(repo, ['rev-parse', '--verify', '-q', 'HEAD']),
    out(repo, ['rev-parse', '-q', '--verify', '@{u}']),
    opts.remote === false ? Promise.resolve(null) : out(repo, ['ls-remote', '--heads']),
  ]);
  const lines = (status ?? '').split('\n').filter(Boolean);
  // .cadence/ (état de l'outil) et .playwright-mcp/ (sorties du MCP Playwright, écrites dans le dossier courant, qu'un dépôt déjà initialisé n'ignore pas forcément) ne comptent jamais comme un dépôt sale.
  const keep = (l: string) => !/^.. "?(\.cadence|\.playwright-mcp)\//.test(l);
  return {
    head: head?.trim() || null,
    tracked: lines.filter((l) => !l.startsWith('??') && keep(l)),
    untracked: lines.filter((l) => l.startsWith('??') && keep(l)).map((l) => l.slice(3)),
    upstream,
    guard: guardPresent(repo),
    remote,
  };
}

/** Écart de la référence amont ou du dépôt distant depuis `before` : un push est parti. */
export function pushed(before: Snapshot, after: Snapshot): boolean {
  if (before.upstream !== after.upstream) return true;
  return before.remote !== null && after.remote !== null && before.remote !== after.remote;
}
