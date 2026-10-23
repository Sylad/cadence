import { nextUp } from './audit.js';
import { planLoader } from './config.js';
import { gitRoot } from './git.js';
import type { Lot } from './plan.js';
import { decisionPending } from './orchestrate/continue.js';
import { liveWaves } from './orchestrate/registry.js';
import { lotFinished, lotKey, RunStore, type LotState } from './orchestrate/state.js';

/** Un lot prêt dont aucune ressource n'est prise (L252) ; `uses` n'est écrit que si le lot en porte. */
export interface FreeLot {
  id: string;
  title: string;
  uses?: string[];
}

const plansOf = (dir: string): Lot[] => planLoader(gitRoot(dir) ?? dir)().lots();

/**
 * Les ressources prises à cet instant : celles des lots `doing` des projets `dirs`, et celles des lots non finis des vagues vivantes
 * (un lot de vague n'est `doing` dans le plan qu'une fois sa session partie). Avec leurs clés `projet:lot`, qui ne sont pas à proposer.
 */
function taken(dirs: string[], home: string): { resources: Set<string>; running: Set<string> } {
  const resources = new Set<string>();
  const running = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const l of nextUp(plansOf(dir)).doing) for (const r of l.uses ?? []) resources.add(r);
    } catch {
      // plan illisible : sa ligne de tour le dit, il ne tient aucune ressource connue
    }
  }
  for (const w of liveWaves(home)) {
    let live: LotState[];
    try {
      live = RunStore.find(w.cwd, w.wave)?.lots().filter((l) => !lotFinished(l)) ?? [];
    } catch {
      continue; // état de vague illisible : la vague ne tient aucune ressource connue
    }
    for (const s of live) {
      running.add(lotKey(s.project, s.lot));
      try {
        for (const r of plansOf(s.repo).find((l) => l.id === s.lot)?.uses ?? []) resources.add(r);
      } catch {
        // plan illisible : aucune ressource connue
      }
    }
  }
  return { resources, running };
}

/**
 * Pour chaque projet de `projects` (dossier et nom tel que les clés de vague le citent), ses lots prêts (comme `nextUp`, hors « à décider » et hors lots d'une vague vivante) dont aucune ressource
 * n'est prise par un lot `doing` d'un des projets ni par une vague vivante de `home`. Un lot sans `uses:` n'en tient aucune : il est libre.
 * Les projets sans lot libre n'ont pas d'entrée (clé : le dossier) ; un plan illisible est sauté.
 */
export function readyFree(projects: { dir: string; name: string }[], home: string): Map<string, FreeLot[]> {
  const { resources, running } = taken(projects.map((p) => p.dir), home);
  const out = new Map<string, FreeLot[]>();
  for (const { dir, name } of projects) {
    let ready: Lot[];
    try {
      ready = nextUp(plansOf(dir)).ready;
    } catch {
      continue;
    }
    const free = ready
      .filter((l) => !decisionPending(l) && !running.has(lotKey(name, l.id)) && !(l.uses ?? []).some((r) => resources.has(r)))
      .map((l): FreeLot => ({ id: l.id, title: l.title, ...(l.uses?.length ? { uses: l.uses } : {}) }));
    if (free.length) out.set(dir, free);
  }
  return out;
}

/** « prêts, ressources libres : projet:L3 titre (banc) · … », ou null quand aucun lot prêt n'est libre. */
export function freeLine(entries: { project: string; free: FreeLot[] }[], titleMax: number): string | null {
  const items = entries.flatMap((e) => e.free.map((l) => `${e.project}:${l.id} ${l.title.length <= titleMax ? l.title : `${l.title.slice(0, titleMax - 1)}…`}${l.uses?.length ? ` (${l.uses.join(', ')})` : ''}`));
  return items.length ? `prêts, ressources libres : ${items.join(' · ')}` : null;
}
