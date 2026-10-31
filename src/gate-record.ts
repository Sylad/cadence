import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, tryGit } from './git.js';
import { git } from './orchestrate/worktree.js';
import { RunStore } from './orchestrate/state.js';

/** Contrôles du programme que la porte d'une vague a enregistrés pour un lot (`LotState.checks`, L397). */
export interface RecordedGate {
  wave: string;
  lot: string;
  tree: string;
  /** Le sha que les contrôles ont tourné (celui demandé, ou le sous lequel ne reposent que des commits de plan, L444). */
  checked: string;
  runs: { label: 'build' | 'tests'; command: string; code: number; instables?: string[] }[];
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const PLAN_HOPS = 50;

/**
 * Les shas dont la porte vaut pour `sha` : `sha` lui-même, puis, tant que le commit ne change que le plan (`planFile`, relatif à la racine du dépôt) et n'a qu'un parent, son parent, de proche en proche
 * (même règle que le hook pre-push, L432 : le commit de revue et celui de `raf done` posés au-dessus d'un lot intégré ne changent pas ce que la porte a contrôlé).
 * Une fusion, un commit racine, un commit qui touche autre chose que le plan ou qui ne touche rien est le dernier de la liste.
 */
function planChain(repo: string, sha: string, planFile: string | undefined): string[] {
  const chain = [sha];
  if (planFile === undefined) return chain;
  for (let hop = 0; hop < PLAN_HOPS; hop++) {
    const at = chain[chain.length - 1]!;
    const parents = (tryGit(repo, ['rev-list', '--parents', '-n1', at]) ?? '').trim().split(/\s+/).slice(1);
    const files = parents.length === 1 ? changedFiles(repo, at) : [];
    if (files.length !== 1 || files[0] !== planFile) break;
    chain.push(parents[0]!);
  }
  return chain;
}

/**
 * La porte que le programme a déjà jouée pour `sha` (L397), pour que `verify --gate` la lise au lieu de la rejouer (≈ 5 min par lot prêt).
 * Une vague range l'état de ses lots sous `<dossier de lancement>/.cadence/runs/<vague>` : `launchDirs` sont ceux à regarder (dossier courant, racine du dépôt, son parent), les vagues les plus récentes d'abord.
 * Un enregistrement est repris quand ses contrôles ont tourné AU sha (même commit), que l'arbre de ce commit est celui enregistré, et qu'il couvre chaque étape de `steps`
 * (même étiquette, même commande, code 0 : une étape rouge, absente ou rejouée avec une autre commande ne prouve rien). `planFile` : les commits qui ne changent que le plan au-dessus de `sha` sont traversés (`planBase`, L444). Sinon `reason` dit pourquoi la porte est rejouée.
 */
export function recordedGate(launchDirs: string[], repo: string, sha: string, steps: { name: string; cmd: string }[], planFile?: string): { found: RecordedGate } | { reason: string } {
  const chain = planChain(repo, sha, planFile);
  const trees = new Map<string, string>();
  const treeOf = (c: string): string => trees.get(c) ?? trees.set(c, git(repo, 'rev-parse', `${c}^{tree}`)).get(c)!;
  const repoReal = realOrSelf(repo);
  let reason = 'aucune porte de vague enregistrée pour ce sha';
  const seen = new Set<string>();
  for (const dir of launchDirs) {
    const base = RunStore.runsDir(dir);
    if (seen.has(realOrSelf(base)) || !existsSync(base)) continue;
    seen.add(realOrSelf(base));
    const stores = readdirSync(base)
      .map((id) => RunStore.find(dir, id))
      .filter((s): s is RunStore => s !== null)
      .map((store) => {
        try {
          return { store, created: store.readWave()?.created ?? '' };
        } catch {
          return { store, created: '' };
        }
      })
      .sort((a, b) => b.created.localeCompare(a.created) || b.store.id.localeCompare(a.store.id));
    for (const { store } of stores) {
      let lots;
      try {
        lots = store.lots();
      } catch {
        continue; // état illisible (écriture en cours) : cette vague ne fournit rien
      }
      for (const l of lots) {
        const checks = l.checks;
        const checked = checks === undefined ? undefined : chain.find((c) => c === checks.head);
        if (checks === undefined || checked === undefined || realOrSelf(l.repo) !== repoReal) continue;
        const tree = treeOf(checked);
        const where = `vague ${store.id}, lot ${l.lot}`;
        if (checks.tree === undefined) {
          reason = `arbre non enregistré (${where}, enregistrement antérieur à L397)`;
          continue;
        }
        if (checks.tree !== tree) {
          reason = `arbre différent de celui contrôlé (${where})`;
          continue;
        }
        const label = (name: string) => (name === 'build' ? 'build' : 'tests');
        const missing = steps.filter((s) => !checks.runs.some((r) => r.label === label(s.name) && r.command === s.cmd && r.code === 0));
        if (missing.length) {
          reason = `l'enregistrement (${where}) ne couvre pas en vert ${missing.map((s) => `${s.name} (${s.cmd})`).join(', ')}`;
          continue;
        }
        return { found: { wave: store.id, lot: l.lot, tree, checked, runs: checks.runs } };
      }
    }
  }
  return { reason };
}
