import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { lotWork } from './audit.js';
import type { Commit } from './git.js';
import { gitRoot } from './git.js';
import type { Lot, Plan } from './plan.js';

/** Un dépôt voisin d'un lot (clé de lot `repos:`) : le chemin tel que le lot le déclare, et la racine git où il se trouve. */
export interface LotRepo {
  rel: string;
  path: string;
}

/**
 * Résout les dépôts voisins d'un lot depuis le dossier du projet (la racine de son dépôt). Chaque chemin doit exister et
 * être dans un dépôt git ; un doublon, ou le dépôt du projet lui-même, n'est compté qu'une fois (le second est ignoré sans bruit).
 * Les chemins qui ne vont pas sont rendus en `problems`, à refuser avant d'agir.
 */
export function resolveLotRepos(base: string, lot: Pick<Lot, 'repos'>): { repos: LotRepo[]; problems: string[]; failures: { rel: string; why: string }[] } {
  const repos: LotRepo[] = [];
  const failures: { rel: string; why: string }[] = [];
  const own = gitRoot(base) ?? resolve(base);
  for (const rel of lot.repos ?? []) {
    const dir = resolve(base, rel);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      failures.push({ rel, why: `dossier introuvable (${dir})` });
      continue;
    }
    const root = gitRoot(dir);
    if (!root) {
      failures.push({ rel, why: `${dir} n'est pas dans un dépôt git` });
      continue;
    }
    if (root === own || repos.some((r) => r.path === root)) continue;
    repos.push({ rel, path: root });
  }
  return { repos, failures, problems: failures.map((f) => `dépôt voisin ${f.rel} : ${f.why}`) };
}

const TYPES = new Set(['feat', 'fix', 'chore', 'docs', 'test', 'tests', 'refactor', 'perf', 'build', 'ci', 'style', 'revert']);

/** Nom que le sujet d'un commit donne à son projet : préfixe `nom:` ou portée `type(nom):`, hors identifiant de lot. */
function subjectProject(subject: string, ids: Set<string>): string | null {
  const m = /^([a-z][\w.-]*)(?:\(([^)]+)\))?!?:/i.exec(subject);
  if (!m) return null;
  const name = (m[2] ?? m[1]).toLowerCase();
  return ids.has(name) || (!m[2] && TYPES.has(name)) ? null : name;
}

/**
 * Commits à relire du lot dans un dépôt voisin, du plus récent au plus ancien : ceux qui citent le lot, selon les références
 * du plan, rattachés à la période du lot (de son démarrage à sa fin) et, dans un dépôt partagé entre projets, au projet :
 * le filtre ne joue que si des commits du lot y portent le nom d'un autre projet (préfixe `nom:` ou portée `type(nom):`) ;
 * il garde alors ceux qui nomment le projet comme un mot. Sans cela le nom du projet, présent partout dans son propre dépôt
 * cible (images, couches), écarterait des commits du lot.
 */
export function repoWork(plan: Plan, repo: LotRepo, lotId: string): Commit[] {
  const lot = plan.lots().find((l) => l.id === lotId);
  const inPeriod = lotWork(plan, repo.path, lotId).filter((c) => (!lot?.started || c.day >= lot.started) && (!lot?.finished || c.day <= lot.finished));
  const project = plan.project.toLowerCase();
  if (!project) return inPeriod;
  const ids = new Set(plan.lots().map((l) => l.id.toLowerCase()));
  const shared = inPeriod.some((c) => {
    const name = subjectProject(c.subject, ids);
    return name !== null && name !== project;
  });
  if (!shared) return inPeriod;
  const word = new RegExp(`(^|[^\\w-])${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
  const named = inPeriod.filter((c) => word.test(`${c.subject}\n${c.body}`.toLowerCase()));
  return named.length > 0 ? named : inPeriod;
}

/** Sha du dernier commit du lot de chaque dépôt voisin (null : aucun), sous le chemin déclaré — ce qu'un verdict de revue enregistre. */
export function repoShas(plan: Plan, repos: LotRepo[], lotId: string): Record<string, string | null> {
  return Object.fromEntries(repos.map((r) => [r.rel, repoWork(plan, r, lotId)[0]?.sha ?? null]));
}

const short = (c: Commit) => `${c.sha.slice(0, 7)} ${c.subject}`;

/**
 * Lignes des commits du lot dans ses dépôts voisins, pour `raf commits` et `raf show` : une section par dépôt, du plus
 * ancien au plus récent comme la liste du projet. Un dépôt introuvable est dit, il ne fait pas échouer la lecture.
 */
export function repoSections(plan: Plan, base: string, lot: Lot, indent = ''): string[] {
  const { repos, failures } = resolveLotRepos(base, lot);
  const lines: string[] = [];
  for (const rel of lot.repos ?? []) {
    const found = repos.find((r) => r.rel === rel);
    if (!found) {
      const failed = failures.find((f) => f.rel === rel);
      if (failed) lines.push(`${indent}dépôt ${rel} : introuvable (${failed.why})`);
      continue;
    }
    const commits = repoWork(plan, found, lot.id).reverse();
    if (commits.length === 0) lines.push(`${indent}dépôt ${rel} : aucun commit du lot`);
    else lines.push(`${indent}dépôt ${rel} :`, ...commits.map((c) => `${indent}  ${short(c)}`));
  }
  return lines;
}
