import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git, gitFailure, tryGit } from './worktree.js';

/** Voie prévue pour un travail qui doit toucher un dépôt tiers (L456) : une branche à part, jamais la branche principale. */
export const wipBranch = (project: string, lot: string): string => `wip/${project}-${lot}`;

/** Ce qu'un relevé d'un dépôt tiers garde : sa branche courante (null en HEAD détaché ou sans commit) et le sha de chaque branche principale locale. */
export interface TierRead {
  branch: string | null;
  mains: Record<string, string>;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Les dépôts tiers d'un lot (L456) : les enfants directs du dossier parent du dépôt du lot (le parent du chemin du dépôt, pas celui d'un worktree) dont `.git`
 * est un dossier. Ni le dépôt du lot, ni le dossier parent, ni `excluded` (voisins déclarés, dépôts des autres lots de la vague) ; un worktree lié (`.git` fichier)
 * est ignoré, et un dépôt atteint par deux chemins (lien symbolique) n'est rendu qu'une fois, sous son chemin réel.
 */
export function tierRepos(lotRepo: string, excluded: string[]): string[] {
  const parent = dirname(resolve(lotRepo));
  const skip = new Set([lotRepo, parent, ...excluded].map(real));
  let names: string[];
  try {
    names = readdirSync(parent).sort();
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const name of names) {
    const root = real(join(parent, name));
    if (skip.has(root) || found.has(root)) continue;
    try {
      if (!lstatSync(join(root, '.git')).isDirectory()) continue;
    } catch {
      continue; // pas un dépôt git (dossier ordinaire, fichier)
    }
    found.add(root);
  }
  return [...found];
}

/**
 * Relevé d'un dépôt tiers, sans réseau : une seule lecture des références locales. Branches principales : celle que désigne `origin/HEAD` (posé par clone), `main` et
 * `master`, parmi les branches locales qui existent. Lève quand git échoue (dépôt illisible).
 */
export function readTier(repo: string): TierRead {
  // %(HEAD) en dernier : la sortie est rognée, un « espace » de tête d'une première ligne serait perdu.
  const out = git(repo, 'for-each-ref', '--format=%(refname)\t%(objectname)\t%(symref)\t%(HEAD)', 'refs/heads', 'refs/remotes/origin/HEAD');
  const heads = new Map<string, string>();
  let branch: string | null = null;
  let declared: string | null = null;
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha, symref = '', current = ''] = line.split('\t');
    if (ref === 'refs/remotes/origin/HEAD') {
      if (symref.startsWith('refs/remotes/origin/')) declared = symref.slice('refs/remotes/origin/'.length);
      continue;
    }
    const name = ref.slice('refs/heads/'.length);
    heads.set(name, sha);
    if (current === '*') branch = name;
  }
  const mains: Record<string, string> = {};
  for (const name of new Set([declared, 'main', 'master'])) {
    const sha = name ? heads.get(name) : undefined;
    if (name && sha) mains[name] = sha;
  }
  return { branch, mains };
}

/** Relève chaque dépôt ; un dépôt illisible est dit au journal et laissé de côté. */
export function takeTiers(repos: string[], log: (line: string) => void): Map<string, TierRead> {
  const reads = new Map<string, TierRead>();
  for (const repo of repos) {
    try {
      reads.set(repo, readTier(repo));
    } catch (e) {
      log(`dépôt tiers ${basename(repo)} ignoré : lecture impossible (${gitFailure(e)})`);
    }
  }
  return reads;
}

/** Plus de commits que cela dans le constat : le reste est compté. */
const SHOWN = 5;

/** Le sujet d'un commit cite-t-il l'un de ces lots ? Identifiant entier : « L1 » n'est ni dans « L10 » ni dans « L1.2 », mais l'est dans « feat(L1): » ou « demo:L1 ». */
export function citesLot(subject: string, lots: string[]): boolean {
  return lots.some((id) => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`).test(subject));
}

/**
 * Première branche principale dont le sha a bougé entre deux relevés, avec ce qu'il faut en dire : les commits ajoutés (sha court et sujet), ou la branche créée,
 * supprimée ou déplacée sans commit nouveau. Seuls comptent les commits dont le sujet cite un lot de la vague (`lots`, L458) : une livraison (bump de tag de deploy.sh), un commit du lead
 * ou d'une autre vague ne citent aucun d'eux et passent. Une branche absente d'un seul côté a bougé (créée ou supprimée pendant la session). Null : rien n'a bougé.
 */
export function tierMoved(repo: string, before: TierRead, after: TierRead, lots: string[]): { branch: string; detail: string } | null {
  for (const branch of [...new Set([...Object.keys(before.mains), ...Object.keys(after.mains)])].sort()) {
    const b = before.mains[branch];
    const a = after.mains[branch];
    if (a === b) continue;
    if (!a) return { branch, detail: `branche supprimée (${b.slice(0, 7)})` };
    // branche créée : seuls comptent les commits que aucune branche principale d'avant ne portait déjà
    const range = b ? [`${b}..${a}`] : [a, '--not', ...Object.values(before.mains)];
    const all = (tryGit(repo, 'log', '--abbrev=7', '--format=%h %s', ...range) ?? '').split('\n').filter(Boolean);
    const lines = all.filter((l) => citesLot(l.slice(l.indexOf(' ') + 1), lots));
    if (all.length && !lines.length) continue; // aucun commit ne cite un lot de la vague
    if (!lines.length && !b) return { branch, detail: `branche créée (${a.slice(0, 7)})` };
    if (!lines.length) return { branch, detail: `branche déplacée de ${b.slice(0, 7)} à ${a.slice(0, 7)}` };
    const more = lines.length > SHOWN ? ` | … (${lines.length - SHOWN} de plus)` : '';
    return { branch, detail: lines.slice(0, SHOWN).join(' | ') + more };
  }
  return null;
}
