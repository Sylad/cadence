import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface Commit {
  sha: string;
  day: string;
  subject: string;
  body: string;
}

function git(cwd: string, args: string[]): string {
  // Le journal complet d'un gros dépôt dépasse le Mo par défaut : sans marge, il serait lu comme vide.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024 });
}

export function gitRoot(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

/** Vrai quand `path` (relatif à `root`) est suivi par git : `git mv` échoue (code 128) sur un fichier non suivi. */
export function isTracked(root: string, path: string): boolean {
  try {
    git(root, ['ls-files', '--error-unmatch', '--', path]);
    return true;
  } catch {
    return false;
  }
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Commits reachable from HEAD, newest first. Empty when the repo has no commit yet. */
export function readCommits(cwd: string, opts: { since?: string; range?: string } = {}): Commit[] {
  const args = ['log', `--format=%H${FIELD}%cs${FIELD}%s${FIELD}%b${RECORD}`];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.range) args.push(opts.range);
  let out: string;
  try {
    out = git(cwd, args);
  } catch {
    return [];
  }
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, day, subject, body = ''] = r.split(FIELD);
      return { sha, day, subject, body: body.trim() };
    });
}

/**
 * Dossier où git exécute réellement les hooks : gère worktrees, core.hooksPath
 * (y compris « ~/… ») et Husky v9, dont `.husky/_` est généré — les hooks à la main vont dans `.husky/`.
 */
export function hooksDir(cwd: string): string {
  const dir = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'hooks']).trim());
  return basename(dir) === '_' && basename(dirname(dir)) === '.husky' ? dirname(dir) : dir;
}

/** Fichiers de l'index (ce que le commit en préparation contient), relatifs à la racine du dépôt. */
export function stagedFiles(cwd: string): string[] {
  return git(cwd, ['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
}

/** Ajoute un fichier à l'index. */
export function stage(cwd: string, file: string): void {
  git(cwd, ['add', '--', file]);
}

/** Le fichier de travail est-il identique à sa version de HEAD (ni modification stagée, ni non stagée) ? Faux s'il n'est pas dans HEAD. */
export function matchesHead(cwd: string, file: string): boolean {
  try {
    git(cwd, ['cat-file', '-e', `HEAD:${file}`]);
    git(cwd, ['diff', '--quiet', 'HEAD', '--', file]);
    git(cwd, ['diff', '--quiet', '--cached', 'HEAD', '--', file]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Aligne l'index sur HEAD pour `file` quand le fichier de travail est déjà celui de HEAD : un commit partiel
 * (`git commit <chemins>`) ne recopie dans l'index réel que ces chemins, et y laisse l'ancienne version du fichier
 * stagé par un pre-commit. Sans effet si le fichier a d'autres modifications.
 */
export function syncIndexWithHead(cwd: string, file: string): void {
  const same = (args: string[]) => {
    try {
      git(cwd, ['diff', '--quiet', ...args, '--', file]);
      return true;
    } catch {
      return false;
    }
  };
  if (same(['HEAD']) && !same(['--cached'])) stage(cwd, file);
}

/**
 * Fichiers modifiés par un commit, relatifs à la racine du dépôt (noms accentués ou à espaces compris). `withoutDeleted` écarte ceux que
 * le commit supprime (`--diff-filter=d`) : un fichier supprimé n'est plus du code à tester.
 */
export function changedFiles(cwd: string, sha: string, opts: { withoutDeleted?: boolean } = {}): string[] {
  // -z : noms séparés par NUL, jamais échappés ; quotepath=off en plus pour les sorties qui citeraient quand même.
  return git(cwd, ['-c', 'core.quotepath=off', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', ...(opts.withoutDeleted ? ['--diff-filter=d'] : []), sha]).split('\0').filter(Boolean);
}

/** Contenu d'un fichier à un commit (`<sha>^` pour l'état d'avant) ; null s'il n'existe pas à ce commit. */
export function fileAt(cwd: string, rev: string, file: string): string | null {
  try {
    return git(cwd, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

/** Sha complet de HEAD, null tant que le dépôt n'a aucun commit. */
export function headSha(cwd: string): string | null {
  return tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
}

/** Sha complet du commit que désigne `rev` (sha abrégé, branche, tag), null s'il n'existe pas. */
export function resolveCommit(cwd: string, rev: string): string | null {
  return tryGit(cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
}

export interface RepoStatus {
  /** null en HEAD détachée. */
  branch: string | null;
  /** Fichiers suivis modifiés (index ou arbre de travail). */
  dirty: number;
  untracked: number;
  /** Branche amont, null s'il n'y en a pas. */
  upstream: string | null;
  /** Commits locaux absents de l'amont. */
  ahead: number;
}

export function repoStatus(cwd: string): RepoStatus {
  const lines = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const upstream = tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const ahead = upstream && headSha(cwd) ? Number(tryGit(cwd, ['rev-list', '--count', '@{u}..HEAD']) ?? 0) : 0;
  return {
    branch: tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    dirty: lines.length - untracked,
    untracked,
    upstream,
    ahead,
  };
}

/** Branche amont suivie (« origin/main ») et son sha tel que connu localement (sans réseau), null sans amont. */
export function upstreamHead(cwd: string): { ref: string; sha: string } | null {
  const ref = tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const sha = ref ? tryGit(cwd, ['rev-parse', '--verify', '-q', '@{u}']) : null;
  return ref && sha ? { ref, sha } : null;
}

/**
 * L'amont suivi est-il la branche de production du dépôt distant ? Lu sans réseau : `refs/remotes/<remote>/HEAD`
 * (origin/HEAD, posé par clone ou `git remote set-head`). Absent (dépôt créé par init + push) : repli sur les
 * noms usuels, main puis master.
 */
export function upstreamIsDefaultBranch(cwd: string, upstreamRef: string): boolean {
  // Le remote vient de la config de la branche, pas d'une coupe de `@{u}` au premier « / » : un remote peut contenir un
  // « / » (gh/origin) et un amont local (branche locale suivie) a pour remote « . » — jamais la branche de production.
  const branch = tryGit(cwd, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch) return false;
  const remote = tryGit(cwd, ['config', '--get', `branch.${branch}.remote`]);
  const merge = tryGit(cwd, ['config', '--get', `branch.${branch}.merge`]);
  if (!remote || remote === '.' || !merge) return false;
  const upstreamBranch = merge.replace(/^refs\/heads\//, '');
  if (upstreamRef !== `${remote}/${upstreamBranch}`) return false;
  const head = tryGit(cwd, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`]);
  if (head) return head === upstreamRef;
  return upstreamBranch === 'main' || upstreamBranch === 'master';
}

/** Le commit est-il contenu dans une branche distante connue localement ? */
export function onRemote(cwd: string, sha: string): boolean {
  return (tryGit(cwd, ['branch', '-r', '--contains', sha]) ?? '').length > 0;
}

/** Chemin d'un fichier propre au dépôt local, dans le dossier git (jamais commité, un par worktree). */
export function gitPath(cwd: string, name: string): string {
  return resolve(cwd, git(cwd, ['rev-parse', '--git-path', name]).trim());
}

/** Dossier git commun à tous les worktrees du dépôt. */
export function gitCommonDir(cwd: string): string {
  return resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim());
}

/** `a` est-il un ancêtre de `b` (objets présents) ? */
export function isAncestor(cwd: string, a: string, b: string): boolean {
  return tryGit(cwd, ['merge-base', '--is-ancestor', a, b]) !== null;
}

/**
 * Instant (ms), date d'auteur (conservée par rebase, amend, cherry-pick), du commit qui a ajouté chaque fichier
 * de `dir` SOUS CE NOM (--no-renames : un renommage compte comme un ajout, l'historique antérieur n'est pas suivi),
 * clé = chemin relatif à `dir`.
 * Vide hors d'un dépôt git ; un fichier jamais commité en est absent.
 */
export function addedTimes(dir: string): Map<string, number> {
  const times = new Map<string, number>();
  let out: string;
  try {
    // quotepath=off + -z : noms accentués tels quels, sans guillemets ni échappement octal.
    out = git(dir, ['-c', 'core.quotepath=off', 'log', '-z', '--diff-filter=A', '--no-renames', '--relative', '--name-only', `--format=${RECORD}%aI`, '--', '.']);
  } catch {
    return times;
  }
  // Enregistrement = RECORD date \0 \n nom \0 nom \0 … ; le plus ancien ajout l'emporte.
  for (const record of out.split(RECORD).filter(Boolean)) {
    const [stamp, ...files] = record.split('\0');
    const t = Date.parse(stamp);
    for (const [i, f] of files.entries()) {
      const name = i === 0 ? f.replace(/^\n/, '') : f;
      if (name) times.set(name, Math.min(t, times.get(name) ?? Infinity));
    }
  }
  return times;
}

/** Chemins parmi `paths` (relatifs à la racine) que git voit modifiés, stagés ou non suivis. */
export function dirtyPaths(root: string, paths: string[]): string[] {
  const out = git(root, ['-c', 'core.quotepath=off', 'status', '--porcelain', '-z', '--', ...paths]);
  return out.split('\0').filter(Boolean).map((l) => l.slice(3));
}

/** Commit de `paths` seuls (à chemin explicite : le reste de l'index n'y entre pas). Rend le sha court. Lève l'erreur de git (hook refusé compris). */
export function commitPaths(root: string, paths: string[], message: string): string {
  git(root, ['add', '--', ...paths]);
  try {
    git(root, ['commit', '-q', '-m', message, '--', ...paths]);
  } catch (e) {
    tryGit(root, ['reset', '-q', '--', ...paths]);
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error((err.stderr || err.stdout || err.message).trim().split('\n')[0]);
  }
  return tryGit(root, ['rev-parse', '--short', 'HEAD']) ?? '';
}

/** Remet `paths` comme à HEAD : un fichier suivi retrouve sa version commitée, un fichier que HEAD ne connaît pas est supprimé. */
export function restorePaths(root: string, paths: string[]): void {
  for (const f of paths) {
    if (tryGit(root, ['cat-file', '-e', `HEAD:${f}`]) !== null) git(root, ['checkout', '-q', 'HEAD', '--', f]);
    else rmSync(resolve(root, f), { force: true });
  }
}

/** Un fichier SUIVI est-il modifié (indexé ou non) ? Les fichiers non suivis ne comptent pas : un commit à chemins explicites ne les embarque pas. `except` : chemins qu'on ne compte pas. */
export function hasTrackedChanges(cwd: string, except: string[] = []): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no', '--', '.', ...except.map((f) => `:(exclude)${f}`)]).trim() !== '';
}

/** Le tag existe-t-il (local) ? */
export function tagExists(cwd: string, tag: string): boolean {
  return git(cwd, ['tag', '--list', tag]).trim() !== '';
}

/** Branche courante, ou null sur un HEAD détaché. */
export function currentBranch(cwd: string): string | null {
  const name = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return name === 'HEAD' ? null : name;
}
