import { readOrchestrateConfig } from './config.js';
import { gitRoot } from './git.js';
import { redAcceptations } from './orchestrate/accept.js';
import { RafError } from './plan.js';

/**
 * Un lot clos avec une acceptation à vert: false bloque les vagues suivantes du dépôt (verrou des tests d'acceptation, L366) :
 * `raf done` le refuse, ou avec `--force` n'en fait qu'un avertissement sur `warn`.
 */
export function refuseRedAcceptation(root: string, configPath: string, lotId: string, force: boolean, warn: (line: string) => void): void {
  const repo = gitRoot(root) ?? root;
  let dir: string | null = null;
  try {
    dir = readOrchestrateConfig(configPath).spec.dir;
  } catch {
    // un cadence.yaml illisible ne doit pas empêcher de clore un lot : `cadence check` en parle
  }
  const red = dir === null ? undefined : redAcceptations(repo, dir).find((a) => a.lot === lotId);
  if (!red) return;
  const text = `${lotId} : ${red.path} est à vert: false — clos ainsi, le lot bloquerait les vagues suivantes du dépôt (verrou des tests d'acceptation) ; cadence spec green ${lotId} lance la commande d'acceptation et pose vert: true`;
  if (!force) throw new RafError(`${text} (--force pour passer outre)`);
  warn(`avertissement : ${text}`);
}
