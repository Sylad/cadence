import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { cp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Plan } from '../plan.js';
import { lotSlug } from './state.js';
import { cadenceHome, liveWaves } from './registry.js';

/** Un worktree par lot (L279) : nom du dossier de la vague où ils vivent, hors du dépôt du lead. */
export const WORKTREES_DIR = 'worktrees';

/** Dossiers ignorés de sortie de build : jamais liés dans un worktree, une commande de tests qui y écrit toucherait le build du dépôt vivant. */
const OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.output', '.angular', '.turbo', '.svelte-kit', '.parcel-cache']);

/** Une commande git dans `cwd`, sa sortie sans les blancs de bord ; lève si elle échoue. Commune à l'orchestration (worktrees, intégration, cycle). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Le message d'une commande git qui a échoué : sa sortie d'erreur (sur une ligne), à défaut le message de l'exception. */
export function gitFailure(e: unknown): string {
  const err = (e as { stderr?: unknown }).stderr;
  const text = typeof err === 'string' && err.trim() ? err : e instanceof Error ? e.message : String(e);
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/** Comme `git`, null quand la commande échoue. */
export const tryGit = (cwd: string, ...args: string[]): string | null => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

/** Branche du lot : `cadence/<vague>/<projet>--<lot>` (R14), le même nom à la reprise. Le projet d'une vague lancée à la racine du dépôt s'appelle `.` : git refuse un composant de branche qui commence par un point, il devient `_`. */
export const lotBranch = (wave: string, project: string, lot: string): string => `cadence/${wave}/${lotSlug(project, lot).replace(/^\./, '_')}`;

/**
 * Dossier du worktree du lot : sous le dossier de la vague (R14). Une vague lancée depuis la racine du dépôt a son dossier DANS le dépôt : le worktree
 * irait alors sous son arbre ; avec `repo`, il part sous le dossier des worktrees de cadence (`<CADENCE_HOME>/worktrees/<vague>-<empreinte du dossier>/`), hors du dépôt.
 */
export function lotTreeDir(waveDir: string, project: string, lot: string, repo?: string): string {
  const slug = lotSlug(project, lot);
  if (repo && withinRepo(repo, waveDir)) return join(cadenceHome(), WORKTREES_DIR, `${basename(waveDir)}-${createHash('sha1').update(realOrSelf(waveDir)).digest('hex').slice(0, 8)}`, slug);
  return join(waveDir, WORKTREES_DIR, slug);
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const withinRepo = (repo: string, path: string): boolean => {
  const rel = relative(realOrSelf(repo), realOrSelf(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Ce qu'il faut pour créer, retrouver ou retirer le worktree d'un lot. `lot` : « projet:lot », noté dans la config git de la branche. */
export interface TreeSpec {
  repo: string;
  dir: string;
  branch: string;
  base: string;
  lot?: string;
}

const config = (repo: string, branch: string, key: string): string | null => tryGit(repo, 'config', '--local', '--get', `branch.${branch}.cadence-${key}`) || null;

/** La branche de départ du lot, notée dans la config git de sa branche à la création ; null si la branche n'est pas celle d'un worktree de cadence. */
export const baseBranchOf = (repo: string, branch: string): string | null => config(repo, branch, 'base');

/** La branche existe dans le dépôt (marquée ou non comme worktree de cadence). */
export const branchExists = (repo: string, branch: string): boolean => branchSha(repo, branch) !== null;

const branchSha = (repo: string, branch: string): string | null => tryGit(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`);

/** Les worktrees enregistrés par git : chemin → branche (null en HEAD détaché). */
function registered(repo: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const text = tryGit(repo, 'worktree', 'list', '--porcelain') ?? '';
  for (const block of text.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    out.set(path, /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null);
  }
  return out;
}

/**
 * Un `node_modules` dans un worktree : un vrai dossier dont chaque entrée est un lien vers celle du dépôt vivant, SAUF les liens
 * de workspace (npm, pnpm, yarn : `node_modules/@x/shared -> ../../packages/shared`) qui pointent vers du code du dépôt hors de tout
 * `node_modules`. Lier le dossier d'un bloc les ferait résoudre dans le dépôt vivant, donc exécuter le code du lot au lieu de celui du worktree ;
 * ils sont refaits vers la copie du worktree (absente au sha de départ : pas de lien). Les dossiers de portée `@x` sont parcourus,
 * pas les paquets. Ajoute chaque lien créé à `links`.
 */
export function mirrorNodeModules(repo: string, dir: string, name: string, links: string[]): void {
  const repoReal = realpathSync(repo);
  const workspaceCopy = (live: string): string | null => {
    let real: string;
    try {
      real = realpathSync(live);
    } catch {
      return null; // lien mort dans le dépôt vivant : rien à refaire
    }
    const rel = relative(repoReal, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('node_modules')) return null;
    return join(dir, rel);
  };
  const link = (target: string, at: string): void => {
    symlinkSync(target, at);
    links.push(at);
  };
  const mirror = (liveDir: string, to: string, scope: boolean): void => {
    mkdirSync(to);
    for (const e of readdirSync(liveDir, { withFileTypes: true })) {
      const live = join(liveDir, e.name);
      const at = join(to, e.name);
      if (e.isSymbolicLink()) {
        const copy = workspaceCopy(live);
        if (copy) {
          if (existsSync(copy)) link(copy, at);
          continue;
        }
      } else if (!scope && e.isDirectory() && e.name.startsWith('@')) {
        mirror(live, at, true);
        continue;
      }
      link(live, at);
    }
  };
  mirror(join(repo, name), join(dir, name), false);
}

/**
 * Relie dans le worktree `dir` les dossiers ignorés du dépôt vivant, de tout niveau (node_modules, .venv… ; `dist` et les autres sorties de
 * build exclus) pour que les dépendances s'y trouvent. `--directory` ne descend pas dans un dossier ignoré, donc chaque entrée est le dossier ou
 * fichier ignoré le plus haut ; son parent doit exister dans le worktree (sinon rien où le relier). Rend les liens créés.
 */
export function linkIgnored(repo: string, dir: string): string[] {
  return linkNames(repo, dir, ignoredDeps(repo));
}

/** Les dossiers et fichiers ignorés du dépôt vivant les plus hauts, hors `.cadence` et sorties de build : ce que les worktrees relient et que `verify --gate` copie. */
export function ignoredDeps(repo: string): string[] {
  return git(repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory').split('\n').map((f) => f.replace(/\/$/, '')).filter((f) => f && !f.startsWith('.cadence') && !f.split('/').some((p) => OUTPUT_DIRS.has(p)));
}

/** Les dépendances que `verify --gate` copie quand `orchestrate.worktreeDeps` est absente (L392) : les `node_modules` de tout niveau et le `.venv`. Rien d'autre (données, `.env`) : trop gros, ou secret. */
export const isCopiedDep = (name: string): boolean => ['node_modules', '.venv'].includes(basename(name));

/**
 * Copie dans le worktree `dir` ces dépendances du dépôt vivant (L389), au lieu de les y relier : un outil qui refuse de charger un `node_modules` lié depuis
 * un autre arbre (Astro : « Could not load … ») les trouve chez lui. Asynchrone (L392) : une copie synchrone de plusieurs centaines de Mo figerait la boucle
 * d'événements, et le Ctrl-C reçu pendant ce temps n'aurait aucun effet. Un dossier qui est lui-même un lien est copié par son contenu (copier le lien ne
 * copierait rien). Les liens relatifs du dossier qui restent dans le dépôt (espaces de travail) sont copiés tels quels : ils pointent dans la copie. Ceux qui en
 * sortent (`file:../voisin`, `link:`) pointeraient dans le vide depuis `dir` : ils sont refaits vers leur cible vivante. Rend les chemins copiés ;
 * un chemin dont le parent n'existe pas dans le worktree est passé.
 */
export async function copyDeps(repo: string, dir: string, names: readonly string[]): Promise<string[]> {
  const copied: string[] = [];
  const repoReal = realpathSync(repo);
  for (const name of names) {
    const to = join(dir, name);
    if (existsSync(to) || !existsSync(dirname(to))) continue;
    let from = join(repo, name);
    try {
      from = realpathSync(from);
    } catch {
      continue; // lien mort : rien à copier
    }
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    // Un dossier venu d'hors du dépôt (lien) garde ses liens internes relatifs ; ses liens vers le reste du monde sont refaits vers leur cible vivante.
    const inside = !relative(repoReal, from).startsWith('..');
    await relinkOutside(inside ? repoReal : from, join(repo, name), from, to);
    copied.push(name);
  }
  return copied;
}

/** Dans la copie `to` de `live` (dont le vrai chemin est `real`), refait vers leur cible vivante les liens dont la cible sort de `boundary`. */
async function relinkOutside(boundary: string, live: string, real: string, to: string): Promise<void> {
  for (const e of await readdir(real, { withFileTypes: true })) {
    const realEntry = join(real, e.name);
    const copy = join(to, e.name);
    if (e.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(realEntry);
      } catch {
        continue; // lien mort : recopié tel quel
      }
      if (relative(boundary, target).startsWith('..')) {
        await rm(copy);
        await symlink(target, copy);
      }
    } else if (e.isDirectory()) {
      await relinkOutside(boundary, join(live, e.name), realEntry, copy);
    }
  }
}

function linkNames(repo: string, dir: string, names: readonly string[]): string[] {
  const links: string[] = [];
  for (const name of names) {
    const to = join(dir, name);
    if (existsSync(to) || !existsSync(dirname(to))) continue;
    if (basename(name) === 'node_modules' && lstatSync(join(repo, name)).isDirectory()) {
      mirrorNodeModules(repo, dir, name, links);
      continue;
    }
    symlinkSync(join(repo, name), to);
    links.push(to);
  }
  return links;
}

/**
 * Crée le worktree du lot sur sa branche propre, ou le retrouve (R11) : branche reconnue (la config git de cadence y est) avec son dossier → rejoué tel quel ;
 * dossier disparu → élagué et recréé sur la branche existante. Une branche du même nom qui n'est pas la nôtre est refusée sans y toucher (R5).
 * Un échec ne laisse ni dossier ni branche créés par cet appel.
 */
export function prepareTree(t: TreeSpec): { ok: true; reused: boolean } | { ok: false; cause: string } {
  const exists = branchSha(t.repo, t.branch) !== null;
  if (exists && baseBranchOf(t.repo, t.branch) === null) return { ok: false, cause: `la branche ${t.branch} existe déjà et n'est pas un worktree de cadence` };
  const alive = existsSync(join(t.dir, '.git')) && registered(t.repo).has(t.dir);
  if (exists && alive) {
    try {
      linkIgnored(t.repo, t.dir);
    } catch {
      // liens de confort : le worktree repris reste utilisable
    }
    return { ok: true, reused: true };
  }
  const madeDir = !existsSync(t.dir);
  try {
    tryGit(t.repo, 'worktree', 'prune');
    mkdirSync(dirname(t.dir), { recursive: true });
    if (exists) git(t.repo, 'worktree', 'add', t.dir, t.branch);
    else {
      git(t.repo, 'worktree', 'add', '-b', t.branch, t.dir, t.base);
      git(t.repo, 'config', '--local', `branch.${t.branch}.cadence-base`, t.base);
      git(t.repo, 'config', '--local', `branch.${t.branch}.cadence-created`, String(Date.now()));
      if (t.lot) git(t.repo, 'config', '--local', `branch.${t.branch}.cadence-lot`, t.lot);
    }
    linkIgnored(t.repo, t.dir);
    return { ok: true, reused: exists };
  } catch (e) {
    const cause = gitFailure(e);
    tryGit(t.repo, 'worktree', 'remove', '--force', t.dir);
    if (madeDir && existsSync(t.dir) && lstatSync(t.dir).isDirectory()) rmSync(t.dir, { recursive: true, force: true });
    tryGit(t.repo, 'worktree', 'prune');
    if (!exists) {
      tryGit(t.repo, 'branch', '-D', t.branch);
      tryGit(t.repo, 'config', '--local', '--remove-section', `branch.${t.branch}`);
    }
    return { ok: false, cause };
  }
}

/**
 * Chemin de reprise d'un lot rendu hors intégration (revue non conforme, tests rouges, HEAD déplacé, plan touché, verrou d'acceptation : sa branche et son
 * worktree sont conservés) : la nouvelle vague du même lot retrouve la branche `cadence/<vague>/<projet>--<lot>` LA PLUS RÉCENTE (date de création notée par cadence)
 * d'une vague passée, reconnue, partie de la même branche `base` et qui porte des commits non intégrés. Elle est renommée au nom de la nouvelle vague
 * (git emporte la config de cadence) et son worktree déplacé vers `dir` : le reste de l'orchestration, qui ne connaît que les noms de la vague, la voit
 * comme la sienne. Rend la branche reprise, ou null (rien à reprendre). Jamais la branche d'une vague vivante.
 * Une branche que la reprise ne pourrait pas mener à l'intégration est refusée sans y toucher (`refused` dit pourquoi) : son worktree porte un fichier suivi modifié
 * (R11 : comme `--resume`, la session n'y démarre pas), ou un de ses commits touche un fichier du plan (`planFiles`, relatifs au dépôt : le plan n'est écrit que par le programme). Un `git worktree move` ou `git branch -m` qui échoue est refusé de même, avec la cause de git (le déplacement est défait).
 */
export function recoverTree(repo: string, branch: string, dir: string, base: string, planFiles: ReadonlySet<string> = new Set()): { from: string; unintegrated: number } | { from: string; refused: string } | null {
  const slug = branch.split('/').slice(2).join('/');
  const found = keptTrees(repo)
    .filter((t) => t.branch !== branch && t.branch.split('/').slice(2).join('/') === slug && t.base === base && t.unintegrated > 0)
    .sort((a, b) => b.created - a.created || (a.branch < b.branch ? 1 : -1))[0];
  if (!found || branchSha(repo, branch) !== null) return null;
  tryGit(repo, 'worktree', 'prune');
  const moved = found.dir !== null && existsSync(found.dir);
  const dirty = moved && existsSync(join(found.dir as string, '.git')) ? trackedDirty(found.dir as string) : [];
  if (dirty.length) return { from: found.branch, refused: `son worktree porte des fichiers suivis modifiés (${dirty.join(', ')})` };
  const touched = (tryGit(repo, 'log', '--name-only', '--format=', `refs/heads/${found.branch}`, '--not', `refs/heads/${base}`) ?? '').split('\n').find((f) => planFiles.has(f));
  if (touched) return { from: found.branch, refused: `un de ses commits modifie le plan (${touched})` };
  try {
    if (moved) {
      mkdirSync(dirname(dir), { recursive: true });
      git(repo, 'worktree', 'move', found.dir as string, dir);
    }
    git(repo, 'branch', '-m', found.branch, branch);
  } catch (e) {
    if (moved && existsSync(dir) && !existsSync(found.dir as string)) tryGit(repo, 'worktree', 'move', dir, found.dir as string);
    return { from: found.branch, refused: `déplacement ou renommage de la branche refusé par git (${gitFailure(e)}), rien n'a bougé` };
  }
  return { from: found.branch, unintegrated: found.unintegrated };
}

/** Les fichiers du plan qu'une session ne doit pas toucher, relatifs au dépôt : le fichier de plan, la page Gantt et ce qui est généré avec (`plan.files`, les fichiers de `plan.onWrite`). */
export function planFileSet(plan: Plan, repo: string): Set<string> {
  const rel = relative(repo, plan.path);
  return new Set([rel, join(dirname(rel), 'gantt.html'), ...plan.files, ...plan.produced]);
}

/** Les commits de la branche du lot déjà dans la branche du dépôt ? */
export function integrated(repo: string, branch: string, base: string): boolean {
  return tryGit(repo, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`) !== null;
}

/** Nombre de commits de la branche du lot qui ne sont pas dans la branche du dépôt. */
export function unintegratedCommits(repo: string, branch: string, base: string): number {
  return Number(tryGit(repo, 'rev-list', '--count', `refs/heads/${branch}`, '--not', `refs/heads/${base}`) ?? 0);
}

/** Fichiers suivis modifiés d'un arbre (`git status --porcelain`, sans les fichiers non suivis). */
export function trackedDirty(dir: string): string[] {
  let out = '';
  try {
    // pas de trim : la première colonne d'un `status --porcelain` peut être une espace
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // arbre illisible : rien de modifié connu
  }
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
}

/**
 * Fichiers non suivis et non ignorés d'un arbre (L279, correctif de revue) : `git worktree remove --force` les supprimerait. Les liens que cadence a posés
 * (dépendances ignorées reliées au dépôt) sont des liens symboliques : ils ne comptent pas.
 */
export function untrackedFiles(dir: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // arbre illisible : rien de connu
  }
  return out
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((f) => {
      try {
        return !lstatSync(join(dir, f)).isSymbolicLink();
      } catch {
        return true;
      }
    });
}

export type Removal = { ok: true; abandoned: number } | { ok: false; unintegrated: number; dirty?: string[]; untracked?: string[] };

/**
 * Retire le worktree et la branche d'un lot (R12). Sans `abandon`, seul un lot dont tous les commits sont dans la branche du dépôt, à l'arbre propre (ni fichier suivi modifié, ni fichier non suivi non ignoré),
 * est retiré ; la branche part alors par une suppression gardée par son sha (jamais `-D`). Avec `abandon` (commande explicite du lead, R20),
 * les commits non intégrés sont abandonnés. Les liens vers le dépôt vivant ne sont pas suivis : seul le lien est supprimé.
 */
export function removeTree(t: TreeSpec, opts: { abandon?: boolean } = {}): Removal {
  const sha = branchSha(t.repo, t.branch);
  const unintegrated = sha ? unintegratedCommits(t.repo, t.branch, t.base) : 0;
  if (!opts.abandon) {
    if (unintegrated > 0) return { ok: false, unintegrated };
    const dirty = existsSync(join(t.dir, '.git')) ? trackedDirty(t.dir) : [];
    if (dirty.length) return { ok: false, unintegrated: 0, dirty };
    const untracked = existsSync(join(t.dir, '.git')) ? untrackedFiles(t.dir) : [];
    if (untracked.length) return { ok: false, unintegrated: 0, untracked };
  }
  if (existsSync(t.dir)) {
    try {
      git(t.repo, 'worktree', 'remove', '--force', t.dir);
    } catch {
      rmSync(t.dir, { recursive: true, force: true });
    }
  }
  tryGit(t.repo, 'worktree', 'prune');
  if (sha) {
    if (opts.abandon && unintegrated > 0) git(t.repo, 'branch', '-D', t.branch);
    else git(t.repo, 'update-ref', '-d', `refs/heads/${t.branch}`, sha);
    tryGit(t.repo, 'config', '--local', '--remove-section', `branch.${t.branch}`);
  }
  return { ok: true, abandoned: opts.abandon ? unintegrated : 0 };
}

export interface KeptTree {
  /** « projet:lot », tel que noté à la création. */
  lot: string;
  wave: string;
  branch: string;
  base: string;
  /** Chemin du worktree ; null quand git n'en connaît plus (la branche seule reste). */
  dir: string | null;
  dirExists: boolean;
  /** Instant de création (ms). */
  created: number;
  unintegrated: number;
  /** Vrai quand une vague vivante (registre des vagues) joue encore ce lot : le worktree n'est pas « conservé » mais en service. */
  active: boolean;
}

/**
 * Les worktrees de lot que le dépôt garde (R19) : toute branche `cadence/*` reconnue (la config git de cadence y est). Rien n'est stocké ailleurs :
 * un worktree retiré a perdu sa branche, un worktree conservé reste listé tant que personne ne le retire (R20).
 */
export function keptTrees(repo: string, opts: { includeActive?: boolean } = {}): KeptTree[] {
  const live = new Set(liveWaves(cadenceHome()).map((w) => w.wave));
  const trees = registered(repo);
  const dirOf = new Map([...trees].filter(([, b]) => b).map(([p, b]) => [b as string, p]));
  const branches = (tryGit(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cadence/') ?? '').split('\n').filter(Boolean);
  const out: KeptTree[] = [];
  for (const branch of branches) {
    const base = baseBranchOf(repo, branch);
    if (!base) continue;
    const dir = dirOf.get(branch) ?? null;
    out.push({
      lot: config(repo, branch, 'lot') ?? branch,
      wave: branch.split('/')[1] ?? '?',
      branch,
      base,
      dir,
      dirExists: dir !== null && existsSync(dir),
      created: Number(config(repo, branch, 'created') ?? 0),
      unintegrated: unintegratedCommits(repo, branch, base),
      active: live.has(branch.split('/')[1] ?? ''),
    });
  }
  return opts.includeActive ? out : out.filter((t) => !t.active); // le worktree d'une vague vivante n'est pas « conservé » : il sert

}

/**
 * Le plan vu depuis un worktree (R21) : le même plan, avec le chemin du fichier correspondant sous `root` — pour les lectures d'historique
 * (lotWork, isPlanOnly, coveredTasks, unreviewedWork) qui rapportent le fichier de plan à la racine qu'on leur passe. Ne sert jamais à écrire.
 */
export function planSeenFrom(plan: Plan, repo: string, root: string): Plan {
  const under = (p: string): string => {
    const rel = relative(repo, p);
    return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? p : join(root, rel);
  };
  return Object.create(plan, { path: { value: under(plan.path) }, configFile: { get: () => (plan.configFile === null ? null : under(plan.configFile)) } }) as Plan;
}

/** Âge lisible d'un worktree conservé : minutes, heures, puis jours. */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} j`;
}

export const KEPT_TITLE = 'worktrees de lot conservés (cadence orchestrate --remove-worktree <projet>:<lot> pour les retirer) :';

/** Une ligne par worktree conservé (R19) : dépôt, lot, âge, commits non intégrés, chemin. */
export const keptLine = (repoName: string, t: KeptTree, now = Date.now()): string => `  ${repoName} · ${t.lot} · ${ageText(now - t.created)} · ${t.unintegrated} commit(s) non intégré(s) · ${t.dir ?? `(worktree absent, branche ${t.branch})`}`;

/**
 * Les lignes qui disent les worktrees de lot conservés (R19) : un titre puis une ligne par worktree ; aucune ligne quand il n'y en a pas. Source commune de
 * `cadence orchestrate --status`, du tableau de fin de vague et de `cadence lead tour`.
 */
export function keptLines(repos: string[], now = Date.now()): string[] {
  const rows = [...new Set(repos)].flatMap((repo) => keptTrees(repo).map((t) => keptLine(basename(repo), t, now)));
  return rows.length ? [KEPT_TITLE, ...rows] : [];
}
