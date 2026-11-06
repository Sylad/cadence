import { isDay } from '../dates.js';
import { RafError } from '../plan.js';
import { addNotAlone } from './ajout.js';
import type { Args } from './command-args.js';
import type { OrchestrateIo } from './command.js';
import { parseUntil, readsPriority } from './continue.js';
import { priorityOf } from './draw.js';
import { checkFollowFlags } from './follow.js';
import { RunStore } from './state.js';
import { resumeCommand } from './table.js';

/** Vrai quand l'option est donnée : une liste non vide, un drapeau levé, une valeur (`--status` sans vague vaut `true`). */
const on = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false);
const anyOf = (...v: unknown[]): boolean => v.some(on);

/** Les refus de combinaison d'options de `cadence orchestrate`, avant d'agir, sans verrou ni écriture ; pose `args.untilAt`. */
export function checkCombinations(args: Args, io: OrchestrateIo, launch: string): void {
  checkDrawFlags(args, io, launch);
  checkFollowFlags(args);
  checkControlFlags(args);
  checkResumeFlags(args, launch);
  checkAloneFlags(args);
}

/** Ce qui règle le tirage : `--until`, `--priority`, la clé `priority:` du dossier (lue ici : illisible, refus avant d'agir, lots donnés ou non). */
function checkDrawFlags(args: Args, io: OrchestrateIo, launch: string): void {
  if (args.add.length && addNotAlone(args)) throw new RafError('--add ne se combine avec aucune autre action (seuls --wave, qui désigne la vague qui reçoit les lots, --goal et --budget projet:lot=+N peuvent l’accompagner)');
  if (args.priority !== undefined && !args.continue) throw new RafError("--priority s'utilise avec --continue");
  // L498 : --until borne aussi une vague lancée sur la file approuvée.
  if (args.until !== undefined && !args.continue && !args.queue) throw new RafError("--until s'utilise avec --continue ou --queue");
  if (args.until !== undefined) args.untilAt = parseUntil(args.until, io.now()); // heure invalide ou passée : refus avant d'agir
  if (readsPriority(args)) priorityOf(args, launch);
}

/** `--drop` / `--stop-after-current` (L79) pilotent une vague VIVANTE : ni avec `--status` (rien à piloter), ni `--stop-after-current` avec `--resume` (il le contredit) ; `--waits` et `--since` vont seuls. */
function checkControlFlags(args: Args): void {
  if (args.status !== undefined && anyOf(args.drop, args.stopAfterCurrent)) throw new RafError('--status ne se combine pas avec --drop / --stop-after-current');
  if (args.resume !== undefined && args.stopAfterCurrent) throw new RafError("--resume ne se combine pas avec --stop-after-current (il reprend la vague, il ne l'arrête pas)");
  if (args.since !== undefined && !args.waits && !args.follow) throw new RafError("--since s'utilise avec --waits ou --follow");
  if (args.since !== undefined && args.waits && !isDay(args.since)) throw new RafError(`--since ${args.since} : un horodatage ou un numéro de ligne ne s'utilise qu'avec --follow (--waits : AAAA-MM-JJ)`);
  if (args.waits && anyOf(args.lots, args.status, args.resume, args.watch, args.drop, args.stopAfterCurrent, args.continue, args.dryRun)) throw new RafError('--waits ne se combine avec aucune autre action');
}

/**
 * L228 : la reprise n'a pas de simulation — elle relève le budget, réécrit wave.json et relance les sessions. Refusée ici, avant le réexec de l'instantané (une vague ancienne ne connaît pas ce refus).
 * L309 : la reprise rejoue les lots de la vague ; des lots à lancer seraient ignorés en silence (`--continue`, lui, tire la suite du plan après la reprise : L147).
 * L279 : `--integrate` rejoue une intégration rendue, donc une vague arrêtée.
 */
function checkResumeFlags(args: Args, launch: string): void {
  if (args.resume !== undefined && args.lots.length) {
    // Un id de vague qui ressemble à un lot (`--resume suite2`) est lu comme un lot à lancer : le refus donne la forme qui le désigne comme vague.
    const asWave = args.lots.find((l) => l.project === undefined && l.model === undefined && RunStore.find(launch, l.lot));
    const hint = asWave ? `« ${asWave.lot} » est une vague de ce dossier : ${resumeCommand(asWave.lot)}` : `pour désigner la vague : ${resumeCommand('<vague>')}`;
    throw new RafError(`--resume ne se combine pas avec des lots à lancer (il reprend les lots de la vague ; --answer, --drop, --integrate, --replay et --budget projet:lot=+N nomment ceux qu'ils visent) ; ${hint}`);
  }
  if (args.resume !== undefined && args.dryRun) throw new RafError("--resume ne se combine pas avec --dry-run (la reprise écrit l'état de la vague et relance les sessions, elle ne se simule pas)");
  if (args.lotBudgets.length && args.resume === undefined && !args.add.length) throw new RafError("--budget projet:lot=+N ne vaut qu'avec --resume ou --add (--add <projet>:<lot> --budget <projet>:<lot>=+N)");
  if (args.integrate.length && args.resume === undefined) throw new RafError(`${args.integrate.some((t) => !t.replay) ? '--integrate' : '--replay'} ne vaut qu'avec --resume`);
}

/**
 * `--abandon-commits` ne vaut qu'avec `--remove-worktree`, qui va seul (L279).
 * L258 : l'objectif donné ne vaut que pour UN lot lancé (la clé goal: du lot sert quand plusieurs partent ; `--continue` et `--queue` tirent leurs lots eux-mêmes) ; L657 : avec `--add`, le lot est celui de l'unique `--add`.
 */
function checkAloneFlags(args: Args): void {
  if (args.abandonCommits && !args.removeWorktree) throw new RafError("--abandon-commits ne vaut qu'avec --remove-worktree");
  if (args.removeWorktree && anyOf(args.lots, args.resume, args.status, args.continue, args.queue, args.dryRun, args.drop, args.stopAfterCurrent, args.waits)) throw new RafError('--remove-worktree ne se combine avec aucune autre action');
  const launched = args.add.length ? args.add.length : args.lots.length;
  if (args.goal !== undefined && (launched !== 1 || anyOf(args.continue, args.queue, args.resume, args.status, args.waits, args.drop, args.stopAfterCurrent))) throw new RafError("--goal s'applique à un seul lot lancé : <projet>:<lot> --goal \"…\" (plusieurs lots : la clé goal: de chacun)");
}
