import { basename } from 'node:path';
import { LOT_LIKE } from './command-args.js';
import { DROPPED } from './cycle/budget.js';
import { planNoteHandBack } from './cycle/plan-writes.js';
import type { LotState } from './state.js';

/** Début de la cause d'un lot rendu parce que son écart docs.sync est ouvert (L317) : la seule source, lue par le renvoi (`openDocGap`) et par le geste. */
export const DOCS_GAP = 'documentation en retard (docs.sync)';

/**
 * La commande de reprise d'une vague, SEULE forme que le programme imprime (L309) : `--resume --wave <id>` et non `--resume <id>`, car un id qui ressemble à un lot
 * (`suite2`) est lu comme un lot à lancer sans `--wave` (et refusé), et `--resume` sans vague est refusé dès que le dossier en garde plusieurs non terminées.
 * `extra` : les options qui suivent (`--drop a:L1`, `--integrate a:L1`...).
 */
export function resumeCommand(waveId: string, ...extra: string[]): string {
  return ['cadence orchestrate --resume --wave', waveId, ...extra].join(' ');
}

/** « à la fin de la vague : » devant une commande qu'une vague vivante refuse tant qu'elle joue (L554). */
export const atWaveEnd = (command: string): string => `à la fin de la vague : ${command}`;

/** La commande de rejeu d'un lot (`--replay`), à jouer à la fin de la vague quand elle est vivante. */
export const replayGesture = (waveId: string, key: string, alive: boolean): string => (alive ? atWaveEnd : (c: string) => c)(resumeCommand(waveId, '--replay', key));

/**
 * Le geste d'un lot qui repart dans une NOUVELLE vague (retiré par `--drop`, ou écart docs.sync acquitté) : `--add` le refuse (déjà dans la vague). `launch` : le dossier qui a lancé la vague ; quand c'est le dépôt du lot
 * (clé `<dossier>:<lot>`), la commande rejouable est `.:<lot>` (`a:L1` y serait lu comme le sous-dossier `a/a`).
 */
export const newWaveGesture = (key: string, launch?: string): string => {
  const at = key.lastIndexOf(':');
  return `cadence orchestrate ${launch !== undefined && key.slice(0, at) === basename(launch) ? `.${key.slice(at)}` : key}`;
};

/**
 * LE geste suivant d'un lot rendu au lead (L554), chaîne vide quand il n'y en a pas un d'exact : écart docs.sync (acquitter dans le dépôt principal, puis une nouvelle vague qui retrouve le worktree), rendu à l'intégration (`--integrate`, déposé tout de suite même sur
 * une vague vivante), écriture de plan refusée (`--replay`), lot retiré (nouvelle vague). `wave.status === 'running'` : la vague est vivante, ses `--replay` se jouent à sa fin.
 */
export function lotGesture(wave: { id: string; status: string; cwd?: string }, l: Pick<LotState, 'project' | 'lot' | 'status' | 'next' | 'outcome'>): string {
  if (l.status !== 'handed-back') return '';
  const key = `${l.project}:${l.lot}`;
  const alive = wave.status === 'running';
  if (l.outcome === DROPPED) return alive ? atWaveEnd(newWaveGesture(key, wave.cwd)) : newWaveGesture(key, wave.cwd);
  if (l.outcome?.startsWith(DOCS_GAP)) return `raf docs-ok ${l.lot} --reason "…" (dépôt principal, plan commité), puis ${alive ? 'à la fin de la vague ' : ''}: ${newWaveGesture(key, wave.cwd)}`;
  if (l.next === 'integrate') return resumeCommand(wave.id, '--integrate', key);
  if (planNoteHandBack(l as LotState)) return replayGesture(wave.id, key, alive);
  return '';
}

/** Le suffixe d'un refus « le lot n'est pas rendu à… » : le geste du lot s'il en a un (L554). */
export function gestureSuffix(wave: { id: string; status: string; cwd?: string }, l: Parameters<typeof lotGesture>[1]): string {
  const gesture = lotGesture(wave, l);
  return gesture ? ` — le geste : ${gesture}` : '';
}

/** Le refus « la vague tourne encore » : avec les options de reprise visées (--replay, --integrate), la commande identique à jouer à la fin de la vague (L554). */
export function stillRunningRefusal(alive: { wave: string; pid: number }, targets: { project?: string; lot: string; replay?: boolean }[]): string {
  const options = targets.flatMap((t) => [t.replay ? '--replay' : '--integrate', `${t.project ? `${t.project}:` : ''}${t.lot}`]);
  return `la vague ${alive.wave} tourne encore (pid ${alive.pid})${targets.length ? ` : ${atWaveEnd(resumeCommand(alive.wave, ...options))}` : ''}`;
}

/** Le suffixe du refus d'un `--add` (vague vivante) dont le lot est déjà dans la vague : retiré par --drop, il se relance dans une nouvelle vague, à la fin de celle-ci (L554). */
export function droppedAddSuffix(known: { status?: string; outcome?: string | null }, key: string, launch?: string): string {
  return known.status === 'handed-back' && known.outcome === DROPPED ? ` : retiré de la vague : le lancer dans une nouvelle vague, ${atWaveEnd(newWaveGesture(key, launch))}` : '';
}

/** La colonne « geste » d'un tableau de vague (L554) : son en-tête et la cellule de chaque lot, rien quand aucun lot n'a un geste. */
export function gestureColumn(wave: { id: string; status: string; cwd?: string }, lots: Parameters<typeof lotGesture>[1][]): { head: string[]; cells: string[][] } {
  const gestes = lots.map((l) => lotGesture(wave, l));
  const any = gestes.some(Boolean);
  return { head: any ? ['geste'] : [], cells: gestes.map((g) => (any ? [g] : [])) };
}

/** Un argument rendu rejouable dans le shell : entre guillemets doubles dès qu'il contient autre chose que des caractères sûrs (ou qu'il est vide). */
const doubleQuoted = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`);

/**
 * La reprise d'une vague SANS ses `--replay` (L554) : un `--replay` refusé fait sortir toute la reprise en 2 ; cette ligne nomme la commande qui reprend le reste. Chaîne vide quand `--replay` était la seule option
 * (rien d'autre à reprendre). `--answer` prend deux valeurs (un `--answer` incomplet n'est pas reproduit), les arguments à espaces sont entre guillemets, `--resume` une vague facultative, `--wave` une vague.
 */
export function resumeWithoutReplay(waveId: string, argv: string[]): string {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--wave' || t === '--replay') i++;
    else if (t === '--resume') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !LOT_LIKE.test(next)) i++;
    } else if (t === '--answer') {
      const [key, text] = [argv[i + 1], argv[i + 2]];
      i += 2;
      if (key !== undefined && text !== undefined) rest.push(t, doubleQuoted(key), doubleQuoted(text));
    } else rest.push(doubleQuoted(t));
  }
  return rest.length ? resumeCommand(waveId, ...rest) : '';
}

/** Les refus d'une reprise, suivis (quand l'un d'eux vise un `--replay`) de la ligne qui nomme la reprise sans `--replay` (L554). */
export function withReplayHint(refusals: string[], waveId: string, argv: string[]): string[] {
  const without = refusals.some((r) => r.startsWith('--replay ')) ? resumeWithoutReplay(waveId, argv) : '';
  return without ? [...refusals, `un --replay refusé refuse toute la reprise : la reprise sans --replay : ${without}`] : refusals;
}
