import { dirname, resolve } from 'node:path';
import { nextUp } from './audit.js';
import { planLoader } from './config.js';
import { gitRoot } from './git.js';
import { findProjects, readDepth } from './lead.js';
import type { Lot } from './plan.js';
import { decisionPending } from './orchestrate/continue.js';
import { liveWaves } from './orchestrate/registry.js';
import { readResources } from './resources.js';
import { lotFinished, RunStore, type LotState } from './orchestrate/state.js';

/** Un lot prêt dont aucune ressource n'est prise (L252) ; `uses` n'est écrit que si le lot en porte. */
export interface FreeLot {
  id: string;
  title: string;
  uses?: string[];
}

/** Le dépôt d'un projet : sa racine git, ou son chemin absolu hors de git. */
const repoOf = (dir: string): string => gitRoot(dir) ?? resolve(dir);

/**
 * Un lot se reconnaît à son dépôt et à son id, pas au nom du projet : une vague lancée depuis un autre dossier l'enregistre sous `basename(dir)`
 * (le tour d'un dossier parent le nomme par son chemin, `grp/alpha`), et deux projets de même nom de deux dossiers sont deux dépôts.
 */
const lotAt = (repo: string, lot: string): string => `${repo}:${lot}`;

/**
 * Les projets qui partagent les ressources de `dir` : ceux que trouve `findProjects` sous le dossier du cadence.yaml qui déclare ses `resources:`
 * (le plus proche en remontant, voir `readResources`), sur la profondeur `depth:` de ce fichier (un niveau à défaut) : `P/x` et `P/grp/alpha`
 * partagent le banc que déclare `P/cadence.yaml` (`depth: 2`), d'où qu'on les interroge. Sans ressource déclarée, ou avec un cadence.yaml
 * illisible ou une `depth:` invalide (que leur ligne de tour signale), ce sont les projets du dossier parent, sur un niveau.
 */
function sharingProjects(dir: string): string[] {
  try {
    const { file, names } = readResources(repoOf(dir));
    if (names.length) return findProjects(dirname(file), readDepth(dirname(file)));
  } catch {
    // cadence.yaml illisible ou depth: invalide
  }
  return findProjects(dirname(dir));
}

const plansOf = (dir: string): Lot[] => planLoader(repoOf(dir))().lots();

/** Un lot qu'une vague tient : son dépôt et son id suffisent à le reconnaître et à retrouver ses `uses:`. */
type Held = Pick<LotState, 'repo' | 'lot'>;

/**
 * Les ressources prises à cet instant : celles des lots `doing` des projets `dirs` et de ceux qui partagent leurs ressources (`sharingProjects` : lancé depuis l'un d'eux,
 * on voit aussi les autres), celles des lots non finis des vagues vivantes (un lot de vague n'est `doing` dans le plan qu'une fois sa session partie)
 * et celles des lots `held` (le tirage d'une vague qui part). Avec leurs lots (`dépôt:lot`, voir `lotAt`), qui ne sont pas à proposer.
 */
function taken(dirs: string[], home: string, held: Held[]): { resources: Set<string>; running: Set<string> } {
  const resources = new Set<string>();
  const running = new Set<string>();
  for (const dir of new Set([...dirs, ...dirs.flatMap(sharingProjects)])) {
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
    held = [...held, ...live];
  }
  for (const s of held) {
    running.add(lotAt(repoOf(s.repo), s.lot));
    try {
      for (const r of plansOf(s.repo).find((l) => l.id === s.lot)?.uses ?? []) resources.add(r);
    } catch {
      // plan illisible : aucune ressource connue
    }
  }
  return { resources, running };
}

/**
 * Pour chaque dossier de projet de `dirs`, ses lots prêts (comme `nextUp`, hors « à décider » et hors lots d'une vague vivante) dont aucune ressource
 * n'est prise par un lot `doing` d'un des projets (ou de ceux qui partagent leurs ressources, voir `sharingProjects`) ni par une vague vivante de `home` ni par les lots `held` d'une vague qui part. Un lot sans `uses:` n'en tient aucune : il est libre.
 * Les projets sans lot libre n'ont pas d'entrée (clé : le dossier) ; un plan illisible est sauté.
 */
export function readyFree(dirs: string[], home: string, held: Held[] = []): Map<string, FreeLot[]> {
  const { resources, running } = taken(dirs, home, held);
  const out = new Map<string, FreeLot[]>();
  for (const dir of dirs) {
    let ready: Lot[];
    try {
      ready = nextUp(plansOf(dir)).ready;
    } catch {
      continue;
    }
    const repo = repoOf(dir);
    const free = ready
      .filter((l) => !decisionPending(l) && !running.has(lotAt(repo, l.id)) && !(l.uses ?? []).some((r) => resources.has(r)))
      .map((l): FreeLot => ({ id: l.id, title: l.title, ...(l.uses?.length ? { uses: l.uses } : {}) }));
    if (free.length) out.set(dir, free);
  }
  return out;
}

/** Lots listés par projet dans la ligne ; au-delà, « projet +K » (le --json donne tout). */
const FREE_SHOWN = 3;

/** « prêts, ressources libres : projet:L3 titre (banc) · … », au plus FREE_SHOWN lots par projet puis « projet +K », ou null quand aucun lot prêt n'est libre. */
export function freeLine(entries: { project: string; free: FreeLot[] }[], titleMax: number): string | null {
  const items = entries.flatMap((e) => [
    ...e.free.slice(0, FREE_SHOWN).map((l) => `${e.project}:${l.id} ${l.title.length <= titleMax ? l.title : `${l.title.slice(0, titleMax - 1)}…`}${l.uses?.length ? ` (${l.uses.join(', ')})` : ''}`),
    ...(e.free.length > FREE_SHOWN ? [`${e.project} +${e.free.length - FREE_SHOWN}`] : []),
  ]);
  return items.length ? `prêts, ressources libres : ${items.join(' · ')}` : null;
}
