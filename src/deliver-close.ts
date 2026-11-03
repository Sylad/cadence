import { lotWork } from './audit.js';
import { isDay, type Day } from './dates.js';
import { blocksTouched, readBlocks, type Blocks } from './deliver-blocks.js';
import { changedFiles, gitRoot, isAncestor, resolveCommit } from './git.js';
import { RafError, type Plan, type Status } from './plan.js';
import { readDeliveryLines, sharedStateDir } from './state.js';
import { readYamlFile } from './yaml-keys.js';

/** Les blocs de `deliver.blocks` du cadence.yaml, sans lire le reste de la configuration de livraison ; absent sans la clé. */
function configuredBlocks(configPath: string): Blocks | undefined {
  const raw = (readYamlFile(configPath) as { deliver?: { blocks?: unknown } } | null | undefined)?.deliver?.blocks;
  return readBlocks(raw, (what) => new RafError(`${configPath} : deliver.${what}`));
}

/** Un ensemble de commits du lot et les lignes du journal qui valent pour eux (une ligne d'un autre bloc ne vaut pas). */
interface Group {
  shas: string[];
  valid: (block: string | undefined) => boolean;
}

/** Sans blocs : un groupe. Avec : un groupe par bloc que touche un commit du lot, et un pour ses commits hors blocs (R32, atteints par une ligne sans bloc). */
function groups(root: string, work: string[], blocks: Blocks | undefined): Group[] {
  if (!blocks || Object.keys(blocks).length === 0) return [{ shas: work, valid: () => true }];
  const touched = new Map(work.map((sha) => [sha, blocksTouched(changedFiles(root, sha), blocks)]));
  const outside = work.filter((sha) => touched.get(sha)!.length === 0);
  const perBlock = Object.keys(blocks).map((name): Group => ({ shas: work.filter((sha) => touched.get(sha)!.includes(name)), valid: (b) => b === undefined || b === name }));
  const unblocked: Group = { shas: outside, valid: (b) => b === undefined };
  return [...perBlock, unblocked].filter((g) => g.shas.length > 0);
}

/**
 * La livraison verte qui contient un lot (L469) : la PREMIÈRE ligne de deliveries.log, dans l'ordre du fichier, dont le sha atteint (est égal ou
 * descend de) un commit de travail du lot — un commit « plan seul » ne compte pas. Avec deliver.blocks, la règle s'applique par bloc que le lot
 * touche (la ligne d'un autre bloc ne vaut pas) et la plus ancienne des lignes retenues est rendue. Une ligne sans jour valide, sans sha ou au sha
 * inconnu du dépôt est sautée. Null : aucune ligne ne convient.
 */
function deliveryOf(plan: Plan, root: string, state: string, lotId: string, blocks?: Blocks): { day: Day; sha: string } | null {
  const lines = readDeliveryLines(state).flatMap((l) => {
    const sha = resolveCommit(root, l.sha);
    return isDay(l.day) && sha ? [{ day: l.day, sha, block: l.block }] : [];
  });
  if (lines.length === 0) return null;
  const work = lotWork(plan, root, lotId).map((c) => c.sha);
  const found = groups(root, work, blocks).flatMap((g) => {
    const i = lines.findIndex((l) => g.valid(l.block) && g.shas.some((s) => isAncestor(root, s, l.sha)));
    return i < 0 ? [] : [i];
  });
  if (found.length === 0) return null;
  const line = lines[Math.min(...found)]!;
  return { day: line.day, sha: line.sha };
}

/**
 * `raf done` (flux de la skill deliver : la livraison précède la fermeture, C1 n'a donc pas marqué le lot) : le lot qui vient d'être fermé reçoit
 * `delivered:` de la première livraison qui le contient. Ne lit rien pour une sous-tâche ni pour un plan en lecture seule. À appeler avant
 * `plan.save()`. Rend la ligne à dire (« L1 livré le … »), aucune quand rien n'est marqué ; une lecture qui échoue est dite sur `err`, la fermeture reste faite.
 */
export function markClosedLot(plan: Plan, where: { root: string; configPath: string; err: (line: string) => void }, id: string, status: Status): string[] {
  const { root, configPath, err } = where;
  if (status !== 'done' || id.includes('/') || plan.readonly || !gitRoot(root)) return [];
  const state = sharedStateDir(root);
  if (readDeliveryLines(state).length === 0) return [];
  try {
    const at = deliveryOf(plan, root, state, id, configuredBlocks(configPath));
    if (!at) return [];
    const refused = plan.markDelivered(id, { date: at.day, sha: at.sha });
    if (refused) {
      err(`raf: ${id} non marqué livré : ${refused}`);
      return [];
    }
    return [`${id} livré le ${at.day} (${at.sha.slice(0, 7)})`];
  } catch (e) {
    err(`raf: livraison de ${id} non cherchée : ${(e as Error).message}`);
    return [];
  }
}
