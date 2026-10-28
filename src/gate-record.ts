import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './orchestrate/worktree.js';
import { RunStore } from './orchestrate/state.js';

/** Contrôles du programme que la porte d'une vague a enregistrés pour un lot (`LotState.checks`, L397). */
export interface RecordedGate {
  wave: string;
  lot: string;
  tree: string;
  runs: { label: 'build' | 'tests'; command: string; code: number; instables?: string[] }[];
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * La porte que le programme a déjà jouée pour `sha` (L397), pour que `verify --gate` la lise au lieu de la rejouer (≈ 5 min par lot prêt).
 * Une vague range l'état de ses lots sous `<dossier de lancement>/.cadence/runs/<vague>` : `launchDirs` sont ceux à regarder (dossier courant, racine du dépôt, son parent), les vagues les plus récentes d'abord.
 * Un enregistrement est repris quand ses contrôles ont tourné AU sha (même commit), que l'arbre de ce commit est celui enregistré, et qu'il couvre chaque étape de `steps`
 * (même étiquette, même commande, code 0 : une étape rouge, absente ou rejouée avec une autre commande ne prouve rien). Sinon `reason` dit pourquoi la porte est rejouée.
 */
export function recordedGate(launchDirs: string[], repo: string, sha: string, steps: { name: string; cmd: string }[]): { found: RecordedGate } | { reason: string } {
  const tree = git(repo, 'rev-parse', `${sha}^{tree}`);
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
        if (l.checks?.head !== sha || realOrSelf(l.repo) !== repoReal) continue;
        const where = `vague ${store.id}, lot ${l.lot}`;
        if (l.checks.tree === undefined) {
          reason = `arbre non enregistré (${where}, enregistrement antérieur à L397)`;
          continue;
        }
        if (l.checks.tree !== tree) {
          reason = `arbre différent de celui contrôlé (${where})`;
          continue;
        }
        const label = (name: string) => (name === 'build' ? 'build' : 'tests');
        const missing = steps.filter((s) => !l.checks!.runs.some((r) => r.label === label(s.name) && r.command === s.cmd && r.code === 0));
        if (missing.length) {
          reason = `l'enregistrement (${where}) ne couvre pas en vert ${missing.map((s) => `${s.name} (${s.cmd})`).join(', ')}`;
          continue;
        }
        return { found: { wave: store.id, lot: l.lot, tree, runs: l.checks.runs } };
      }
    }
  }
  return { reason };
}
