import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readOrchestrateConfig } from './config.js';
import { gitRoot, tryGit } from './git.js';
import { redAcceptations } from './orchestrate/accept.js';
import { lotBranch } from './orchestrate/worktree.js';
import { lotKey, RunStore } from './orchestrate/state.js';
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

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Les branches de vague (`cadence/<vague>/…`) où une vague a rendu le lot `lotId` de ce dépôt ; l'état d'une vague illisible n'en donne aucune. */
function handedBackBranches(repo: string, lotId: string): { branch: string; key: string }[] {
  const dirs = new Set<string>();
  for (let d = resolve(repo); !dirs.has(d); d = dirname(d)) dirs.add(d);
  const out: { branch: string; key: string }[] = [];
  for (const dir of dirs) {
    const base = RunStore.runsDir(dir);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      try {
        const lot = RunStore.find(dir, id)?.lots().find((l) => l.lot === lotId && l.status === 'handed-back' && real(l.repo) === real(repo));
        if (lot) out.push({ branch: lotBranch(id, lot.project, lot.lot), key: lotKey(lot.project, lot.lot) });
      } catch {
        // état illisible : cette vague ne dit rien du lot
      }
    }
  }
  return out;
}

/**
 * Un lot rendu par une vague dont les commits de travail ne sont pas sur la branche principale (HEAD du dépôt) n'est pas clos par `raf done` (L647 ; 06-11 : L646 clos
 * alors que son intégration venait d'être refusée, la porte verte ne portait pas son code). Compare par patch (`git cherry`) : un cherry-pick ou un rebase du lead compte.
 * Branche disparue (intégrée puis supprimée) : rien à refuser. `--force` n'en fait qu'un avertissement sur `warn`.
 */
export function refuseHandedBackWithoutCode(root: string, lotId: string, force: boolean, warn: (line: string) => void): void {
  const repo = gitRoot(root) ?? root;
  for (const { branch, key } of handedBackBranches(repo, lotId)) {
    const missing = tryGit(repo, ['cherry', 'HEAD', branch])?.split('\n').filter((l) => l.startsWith('+')).length ?? 0;
    if (!missing) continue;
    const text = `${lotId} : rendu par une vague, ${missing} commit(s) de travail de ${branch} ne sont pas sur la branche principale — clos ainsi, le lot ne porterait pas son code ; l'intégrer (cadence orchestrate --resume --integrate ${key}) ou reprendre ses commits d'abord`;
    if (!force) throw new RafError(`${text} (--force pour passer outre)`);
    warn(`avertissement : ${text}`);
    return;
  }
}
