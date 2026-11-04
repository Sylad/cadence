import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planCommits, workByLot } from './audit.js';
import { linkCommits } from './link.js';
import { planLoader } from './config.js';
import { gitRoot, latestVersionTag } from './git.js';
import type { Plan } from './plan.js';

/** Les lots clos (`done`) dont le travail est postérieur au dernier tag de version (L571) : en service, mais pas publiés. */
export interface Unpublished {
  /** Le dernier tag `v<x.y.z>` atteignable depuis HEAD. */
  tag: string;
  lots: string[];
}

/** Un dépôt qui publie porte un `package.json` avec une `version` : sans lui, un tag ne dit rien d'une publication. */
function publishes(root: string): boolean {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return false;
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof pkg === 'object' && pkg !== null && typeof (pkg as { version?: unknown }).version === 'string';
  } catch {
    return false; // un package.json illisible n'est pas celui d'un dépôt qu'on puisse dire publiant
  }
}

/**
 * Les lots `done` que cite au moins un commit de travail depuis le dernier tag `v<x.y.z>` ; null quand le dépôt ne publie pas
 * (pas de `package.json` avec version, ou aucun tag de version) ou que rien n'est en attente. Les commits d'entretien du plan (« plan : L1 terminé ») ne comptent pas :
 * un lot dont le travail précède le tag n'est pas « non publié » parce que son statut a changé après.
 */
export function unpublished(plan: Plan, root: string): Unpublished | null {
  if (!publishes(root)) return null;
  const tag = latestVersionTag(root);
  if (!tag) return null;
  const lots = plan.lots();
  const done = lots.filter((l) => l.status === 'done');
  if (done.length === 0) return null;
  const linked = linkCommits(lots, planCommits(plan, root, { range: `${tag}..HEAD` }), plan.refs);
  const work = workByLot(plan, root, linked, done.map((l) => l.id));
  const ids = done.filter((l) => (work.get(l.id)?.length ?? 0) > 0).map((l) => l.id);
  return ids.length ? { tag, lots: ids } : null;
}

/** Le champ `unpublished` d'une ligne du tour : absent quand rien n'attend. */
export function unpublishedField(plan: Plan, root: string): { unpublished?: Unpublished } {
  const pending = unpublished(plan, root);
  return pending ? { unpublished: pending } : {};
}

/** Le même calcul depuis un dossier de projet ; un plan illisible ou un dépôt sans git donne null (la ligne est un signal en plus, jamais une condition). */
export function unpublishedAt(dir: string): Unpublished | null {
  try {
    const root = gitRoot(dir) ?? dir;
    return unpublished(planLoader(root)(), root);
  } catch {
    return null;
  }
}

/** La ligne ⚠ : combien de lots, depuis quel tag, et la commande à jouer. */
export function unpublishedLine(u: Unpublished): string {
  const n = u.lots.length;
  return `⚠ ${n} ${n > 1 ? 'lots done' : 'lot done'} depuis le dernier tag ${u.tag} (${u.lots.join(', ')}) — en service, non publié${n > 1 ? 's' : ''} : cadence release patch|minor|major`;
}
