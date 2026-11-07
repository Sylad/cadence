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
/**
 * Relevés consécutifs hors du registre des vagues vivantes avant que la vague soit tenue pour finie. Une vague reprise (`--resume`, même sur un statut `done` avec `--integrate` ou `--budget projet:lot=+N`)
 * ne s'y inscrit qu'après l'instantané, les verrous et les gardes de push, et une vague `--continue` le quitte entre deux tours (0,8 à 7,6 s mesurés) : un seul relevé absent n'est pas une fin.
 */
const ABSENT_POLLS = 6;

/** Le texte d'une ligne du journal, sans l'horodatage ISO qui la précède. */
function body(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '');
}

/**
 * Cette ligne du journal demande-t-elle un geste du lead (L588) ? Oui : un lot prêt, rendu (rendu, échoué, rendu à l'intégration), en question, intégré, ou suspendu — sur budget ou quota,
 * ou par un incident (push détecté, dépôt sali ou HEAD déplacé par une revue : à nettoyer par le lead avant de reprendre).
 * Non : les transitions de travail (implementing, reviewing, fixing), les suspensions qui sont le geste du lead lui-même (`--stop-after-current`, `--resume --integrate|--replay|--budget`,
 * nommé entre parenthèses dans leur texte), les sessions, les worktrees, les demandes de contrôle et le reste — 91 lignes utiles sur 453 le 04-11.
 * Seul l'état écrit APRÈS la flèche compte : « → fixing — … ready … » ne remonte pas.
 */
export function leadLine(line: string): boolean {
  const text = body(line);
  if (/^\S+ → (?:ready|handed-back|failed|question)(?: — |$)/.test(text)) return true;
  if (/^\S+ → suspended — /.test(text)) return !/\(--[a-z-]+(?: --[a-z-]+)*\)/.test(text);
  if (/^\S+ intégré : \S+\.\.\S+$/.test(text)) return true;
  return /^orchestrate : \S+ : rendu à l'intégration/.test(text);
}

/** Les refus d'options de suivi (`--status --watch`, `--detail`, `--interval`, `--follow`), qui sortaient d'`orchestrate` : le premier qui s'applique lève. */
export function checkFollowFlags(args: Args): void {
  const other = [args.lots.length > 0, args.status !== undefined, args.watch, args.resume !== undefined, args.continue, args.dryRun, args.waits, args.drop.length > 0, args.add.length > 0, args.stopAfterCurrent, args.integrate.length > 0, args.removeWorktree !== undefined, args.goal !== undefined, args.answers.length > 0, args.lotBudgets.length > 0, args.budget !== undefined];
  const refusals: [boolean, string][] = [
    [args.follow && other.includes(true), "--follow ne se combine qu'avec --wave, --interval et --since (il suit le journal d'une vague, il n'en pilote pas)"],
    [args.watch && args.status === undefined, "--watch s'utilise avec --status"],
    [args.detail !== undefined && args.status === undefined, "--detail s'utilise avec --status"],
    [args.detail !== undefined && args.watch, "--detail ne se combine pas avec --watch (il donne le détail d'un lot, pas le tableau)"],
    [args.interval !== undefined && !args.watch && !args.follow, "--interval s'utilise avec --status --watch ou --follow"],
  ];
  const refused = refusals.find(([cond]) => cond);
  if (refused) throw new RafError(refused[1]);
}

/**
 * `--follow` (L588) : suit le journal d'une vague et n'imprime que les lignes de `leadLine`, avec leur horodatage, écrites après son armement (un suivi réarmé après `--resume` ne rejoue pas
 * les prêts et les questions déjà relayés ; le journal entier reste dans `--status` et `tail`) ; quand la vague a quitté le registre depuis `ABSENT_POLLS` relevés, une dernière ligne « fin de vague » dit son statut.
 * Remplace `tail -F journal.log` du skill lead : la vague écrit ~450 lignes, le lead n'a à agir que sur un cinquième.
 */
export async function followCommand(args: Args, io: OrchestrateIo, deps: OrchestrateDeps, launch: string): Promise<number> {
  const sleep = deps.watchSleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const ms = (args.interval ?? DEFAULT_FOLLOW_INTERVAL) * 1000;
  const store = await waveStore(args.wave, launch, () => sleep(ms));
  const reader = journalReader(join(store.dir, 'journal.log'), args.since);
  const live = () => liveWaves(cadenceHome()).some((w) => w.wave === store.id);
  let absent = 0;
  for (;;) {
    absent = live() ? 0 : absent + 1;
    for (const line of reader()) io.out(line);
    if (absent > ABSENT_POLLS) {
      io.out(`fin de vague ${store.id} : ${store.readWave()?.status ?? 'illisible'}`);
      return 0;
    }
    await sleep(ms);
  }
}

/** La vague suivie : `--wave`, ou la dernière du dossier. Sans `--wave`, « aucune vague » est définitif ; avec, la vague peut ne pas avoir écrit son état encore : elle est attendue. */
async function waveStore(wave: string | undefined, launch: string, wait: () => Promise<void>): Promise<RunStore> {
  const find = () => (wave !== undefined ? RunStore.find(launch, wave) : RunStore.last(launch));
  let store = find();
  for (let polls = 0; !store && wave !== undefined && polls < STATE_WAIT_POLLS; polls++) {
    await wait();
    store = find();
  }
  if (!store) throw new RafError(wave !== undefined ? `vague inconnue : ${wave}` : 'aucune vague dans ce dossier');
  return store;
}

/** La ligne porte-t-elle l'horodatage ISO qui ouvre chaque entrée du journal ? Sinon c'est une ligne de suite : `store.journal()` écrit le texte brut d'une entrée, sauts de ligne compris. */
const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;

/** Une entrée du journal : sa première ligne, son rang (1 pour la première ligne du fichier) et ses lignes de suite. */
interface Entry { rank: number; lines: string[] }

function entriesOf(text: string): Entry[] {
  const entries: Entry[] = [];
  text.split('\n').forEach((line, i) => {
    if (TIMESTAMPED.test(line) || entries.length === 0) entries.push({ rank: i + 1, lines: [line] });
    else entries[entries.length - 1].lines.push(line);
  });
  return entries;
}

/**
 * Les entrées de geste que le suivi rejoue à son armement (L668). Avec `--since` : celles écrites à cet horodatage ISO ou après (un jour AAAA-MM-JJ vaut minuit), ou à partir de cette ligne du journal
 * (un entier : le numéro de la première ligne de l'entrée). Sans : les questions encore ouvertes, c'est-à-dire dont le lot n'a écrit aucun autre état depuis — un suivi réarmé les relit au lieu
 * de les perdre (06-11, la question de L477 de 22:00:39Z a attendu 33 min). Les prêts déjà relayés, eux, ne sont pas rejoués.
 */
function replayed(entries: Entry[], since: string | undefined): Entry[] {
  const lead = entries.filter((e) => leadLine(e.lines[0]));
  if (since !== undefined) {
    const from = /^\d+$/.test(since) ? Number(since) : undefined;
    const at = Date.parse(since);
    return lead.filter((e) => (from !== undefined ? e.rank >= from : Date.parse(/^\S+/.exec(e.lines[0])![0]) >= at));
  }
  const last = new Map<string, Entry>();
  for (const e of entries) {
    const lot = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z )?(\S+) → /.exec(e.lines[0])?.[1];
    if (lot !== undefined) last.set(lot, e);
  }
  return lead.filter((e) => /^\S+ → question(?: — |$)/.test(body(e.lines[0])) && [...last.values()].includes(e));
}

/**
 * Relève le journal : à chaque appel, les lignes de geste écrites depuis le précédent ; au premier, ce que `replayed` rejoue puis ce qui est écrit depuis. Une ligne non terminée attend sa fin. Un journal absent est un journal vide.
 * Une ligne sans horodatage appartient à l'entrée précédente et suit son sort (une question « 3 fichiers diffèrent : » suivie de 3 lignes « — … » sort entière, 67 lignes de suite dans les journaux d'oct.-nov.),
 * même quand la suite arrive dans un relevé plus tard que sa première ligne.
 */
function journalReader(file: string, since: string | undefined): () => string[] {
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const endOf = (text: string) => text.lastIndexOf('\n') + 1;
  const first = read();
  let done = endOf(first); // caractères déjà traités
  let emitting = false; // la dernière entrée relevée était-elle une ligne de geste ?
  let replay = replayed(entriesOf(first.slice(0, done === 0 ? 0 : done - 1)), since).flatMap((e) => e.lines);
  return () => {
    const text = read();
    const end = endOf(text);
    const past = replay;
    replay = [];
    if (end <= done) return past;
    const lines = text.slice(done, end - 1).split('\n').filter((line) => {
      if (TIMESTAMPED.test(line)) emitting = leadLine(line);
      return emitting;
    });
    done = end;
    return [...past, ...lines];
  };
}
