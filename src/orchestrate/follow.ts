import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import { cadenceHome, liveWaves } from './registry.js';
import { RunStore } from './state.js';
import type { OrchestrateDeps, OrchestrateIo } from './command.js';
import type { Args } from './command-args.js';

/** Secondes entre deux relevés du journal par défaut. */
const DEFAULT_FOLLOW_INTERVAL = 5;
/** Relevés accordés à une vague nommée d'avance (`--wave`) pour écrire son état avant qu'elle soit déclarée inconnue. */
const STATE_WAIT_POLLS = 30;

/** Le texte d'une ligne du journal, sans l'horodatage ISO qui la précède. */
function body(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '');
}

/**
 * Cette ligne du journal demande-t-elle un geste du lead (L588) ? Oui : un lot prêt, rendu (rendu, échoué, rendu à l'intégration), en question, arrêté sur budget ou quota, ou intégré.
 * Non : les transitions de travail (implementing, reviewing, fixing), les sessions, les worktrees, les demandes de contrôle et le reste — 91 lignes utiles sur 453 le 04-11.
 * Seul l'état écrit APRÈS la flèche compte : « → fixing — … ready … » ne remonte pas.
 */
export function leadLine(line: string): boolean {
  const text = body(line);
  if (/^\S+ → (?:ready|handed-back|failed|question)(?: — |$)/.test(text)) return true;
  if (/^\S+ → suspended — (?:budget|quota) atteint/.test(text)) return true;
  if (/^\S+ intégré : \S+\.\.\S+$/.test(text)) return true;
  return /^orchestrate : \S+ : rendu à l'intégration/.test(text);
}

/**
 * `--follow` (L588) : suit le journal d'une vague et n'imprime que les lignes de `leadLine`, avec leur horodatage, depuis le début du journal ; à l'arrêt de la vague, une dernière ligne « fin de vague » dit son statut.
 * Remplace `tail -F journal.log` du skill lead : la vague écrit ~450 lignes, le lead n'a à agir que sur un cinquième.
 */
export async function followCommand(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string): Promise<number> {
  const sleep = deps.watchSleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const ms = (args.interval ?? DEFAULT_FOLLOW_INTERVAL) * 1000;
  const find = () => (args.wave !== undefined ? RunStore.find(launch, args.wave) : RunStore.last(launch));
  let store = find();
  // sans --wave : « aucune vague » est définitif ; avec, la vague peut ne pas avoir écrit son état encore
  for (let polls = 0; !store && args.wave !== undefined && polls < STATE_WAIT_POLLS; polls++) {
    await sleep(ms);
    store = find();
  }
  if (!store) throw new RafError(args.wave !== undefined ? `vague inconnue : ${args.wave}` : 'aucune vague dans ce dossier');
  const file = join(store.dir, 'journal.log');
  let done = 0; // caractères du journal déjà traités : une ligne non terminée attend sa fin
  for (;;) {
    const running = liveWaves(cadenceHome()).some((w) => w.wave === store!.id);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const end = text.lastIndexOf('\n') + 1;
    if (end > done) {
      for (const line of text.slice(done, end).split('\n')) if (leadLine(line)) io.out(line);
      done = end;
    }
    if (!running) {
      io.out(`fin de vague ${store.id} : ${store.readWave()?.status ?? 'illisible'}`);
      return 0;
    }
    await sleep(ms);
  }
}
