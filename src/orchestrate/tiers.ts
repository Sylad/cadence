import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { git, gitFailure, planFileSet, tryGit } from './worktree.js';
import { defaultPlan, planLoader, readPlanConfig } from '../config.js';
import { lotKey, lotRepoPaths, type LotState } from './state.js';
import { isAncestor } from '../git.js';
import { readDeliveryLines, sharedStateDir } from '../state.js';
import { gitCommitsIn } from './table.js';

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

/** Le commit ne touche que des fichiers de `planFiles` (relatifs au dépôt) ? Un commit sans fichier (fusion, vide) ne l'est pas. */
function onlyPlanFiles(repo: string, sha: string, planFiles: ReadonlySet<string>): boolean {
  const files = (tryGit(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha) ?? '').split('\n').filter(Boolean);
  return files.length > 0 && files.every((f) => planFiles.has(f));
}

/**
 * Les fichiers du plan du dépôt tiers : `planFileSet` quand son plan se lit ; sinon (plan absent ou en cours d'écriture, donc illisible) ceux que son cadence.yaml nomme
 * (plan.path ou le plan par défaut, la page Gantt, plan.files). Vide quand son cadence.yaml est illisible : rien n'est alors toléré.
 */
function tierPlanFiles(repo: string): ReadonlySet<string> {
  try {
    return planFileSet(planLoader(repo)(), repo);
  } catch {
    // le plan n'est pas lisible : on retombe sur la configuration seule
  }
  try {
    const config = readPlanConfig(join(repo, 'cadence.yaml'), repo);
    const rel = relative(repo, config?.path ? resolve(repo, config.path) : defaultPlan(repo).path);
    return new Set([rel, join(dirname(rel), 'gantt.html'), ...(config?.settings.files ?? [])]);
  } catch {
    return new Set();
  }
}

/**
 * Première branche principale dont le sha a bougé entre deux relevés, avec ce qu'il faut en dire : les commits ajoutés (sha court et sujet), ou la branche créée,
 * supprimée ou déplacée sans commit nouveau. Seuls comptent les commits dont le sujet cite un lot de la vague (`wave.lots`, L458) : une livraison (bump de tag de deploy.sh), un commit du lead
 * ou d'une autre vague ne citent aucun d'eux et passent. Passe aussi le commit dont tous les lots cités sont des lots livrés (`wave.delivered`, L503 : le bump de tag que deploy.sh
 * commite pendant `deliver --sha` d'un lot prêt) ; il est rendu à `wave.onDelivered` (sha court et sujet) pour que le journal le dise. Passe de même (L593) le commit qui ne touche que les fichiers du plan du dépôt (`wave.planFiles` : plan.path, plan.files de son cadence.yaml), comme le commit de plan du lead ; rendu à `wave.onPlan`. Une branche absente d'un seul côté a bougé (créée ou supprimée pendant la session). Null : rien n'a bougé.
 */
export function tierMoved(repo: string, before: TierRead, after: TierRead, wave: { lots: string[]; delivered?: string[]; onDelivered?: (line: string) => void; planFiles?: ReadonlySet<string>; onPlan?: (line: string) => void }): { branch: string; detail: string } | null {
  for (const branch of [...new Set([...Object.keys(before.mains), ...Object.keys(after.mains)])].sort()) {
    const b = before.mains[branch];
    const a = after.mains[branch];
    if (a === b) continue;
    if (!a) return { branch, detail: `branche supprimée (${b.slice(0, 7)})` };
    // branche créée : seuls comptent les commits que aucune branche principale d'avant ne portait déjà
    const range = b ? [`${b}..${a}`] : [a, '--not', ...Object.values(before.mains)];
    const all = (tryGit(repo, 'log', '--abbrev=7', '--format=%h %s', ...range) ?? '').split('\n').filter(Boolean);
    const { lots, delivered = [], onDelivered, planFiles, onPlan } = wave;
    const lines = all.filter((l) => {
      const subject = l.slice(l.indexOf(' ') + 1);
      const cited = lots.filter((id) => citesLot(subject, [id]));
      if (cited.length > 0 && cited.every((id) => delivered.includes(id))) {
        onDelivered?.(l);
        return false;
      }
      if (cited.length > 0 && planFiles && onlyPlanFiles(repo, l.slice(0, l.indexOf(' ')), planFiles)) {
        onPlan?.(l);
        return false;
      }
      return cited.length > 0;
    });
    if (all.length && !lines.length) continue; // aucun commit ne cite un lot de la vague
    if (!lines.length && !b) return { branch, detail: `branche créée (${a.slice(0, 7)})` };
    if (!lines.length) return { branch, detail: `branche déplacée de ${b.slice(0, 7)} à ${a.slice(0, 7)}` };
    const more = lines.length > SHOWN ? ` | … (${lines.length - SHOWN} de plus)` : '';
    return { branch, detail: lines.slice(0, SHOWN).join(' | ') + more };
  }
  return null;
}

/**
 * Les dépôts tiers de la session qui le sont encore à sa fin (L421) : un lot ajouté (`--add`) pendant la session a pu prendre l'un d'eux, dont la branche principale bouge alors
 * légitimement, comme celle des autres lots de la vague (R14).
 */
export function stillThird(before: Map<string, TierRead>, wave: Pick<LotState, 'project' | 'lot' | 'repo' | 'repos'>[], mine: string): [string, TierRead][] {
  const ofOthers = new Set(wave.filter((x) => lotKey(x.project, x.lot) !== mine).flatMap(lotRepoPaths));
  return [...before].filter(([repo]) => !ofOthers.has(repo));
}

/**
 * Les lots prêts de la vague, autres que `mine`, dont un commit est dans un sha du journal des livraisons de leur dépôt (L503) : `cadence deliver --sha` les a livrés,
 * et le bump de tag que deploy.sh commite alors dans le dépôt voisin cite ces lots sans être un commit du lot en cours. Un lot illisible n'est pas compté.
 */
function deliveredLots(lots: LotState[], mine: string): string[] {
  return lots.flatMap((x) => {
    if (x.status !== 'ready' || lotKey(x.project, x.lot) === mine) return [];
    try {
      const shas = readDeliveryLines(sharedStateDir(x.repo)).map((d) => d.sha);
      return gitCommitsIn(x, x.repo).some((k) => shas.some((s) => isAncestor(x.repo, k, s))) ? [x.lot] : [];
    } catch {
      return [];
    }
  });
}

/** `tierMoved` du dépôt tiers `repo`, sans les commits de livraison d'un lot prêt de la vague (L503) : `log` dit ceux qu'il a laissé passer. */
export function movedOutsideDeliveries(repo: string, before: TierRead, after: TierRead, wave: { lots: LotState[]; mine: string; log: (line: string) => void }): ReturnType<typeof tierMoved> {
  const delivered = deliveredLots(wave.lots, wave.mine);
  const tolerated: string[] = [];
  const plans: string[] = [];
  const moved = tierMoved(repo, before, after, { lots: wave.lots.map((x) => x.lot), delivered, onDelivered: (line) => tolerated.push(line), planFiles: tierPlanFiles(repo), onPlan: (line) => plans.push(line) });
  if (plans.length) wave.log(`commit de plan toléré dans ${basename(repo)} : ${plans.join(' | ')}`);
  if (tolerated.length) wave.log(`commit de livraison (${wave.lots.filter((x) => delivered.includes(x.lot) && tolerated.some((line) => citesLot(line.slice(line.indexOf(' ') + 1), [x.lot]))).map((x) => `${x.project}:${x.lot}`).join(', ')}) toléré dans ${basename(repo)} : ${tolerated.join(' | ')}`);
  return moved;
}
