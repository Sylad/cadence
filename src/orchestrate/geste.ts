import { basename } from 'node:path';
import { LOT_LIKE } from './command-args.js';
import { DROPPED } from './cycle/budget.js';
import { planNoteHandBack } from './cycle/plan-writes.js';
import { FIN_DE_CYCLE_WHATS } from './cycle/review.js';
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
 * Un lot rendu que le lead peut reprendre par `--add` après avoir corrigé son worktree (L563) : rendu (`handed-back`), pas à l'intégration, et un outcome qui commence par
 * `<what> après ` pour l'un des `FIN_DE_CYCLE_WHATS` (liste blanche, la même que celle que `toFix` écrit). Tout autre rendu (incident, budget, étape spec ou accept, outcome inconnu ou vide) ne l'est pas.
 * Lu par le contrôle préalable de `--add` et par `lotGesture` : les deux lectures ne peuvent pas diverger.
 */
export const addableHandBack = (l: { status?: string; next?: string | null; outcome?: string | null }): boolean =>
  l.status === 'handed-back' && l.next !== 'integrate' && !!l.outcome && FIN_DE_CYCLE_WHATS.some((w) => l.outcome!.startsWith(`${w} après `));

/** La commande `--add` qui reprend un lot rendu dans la vague vivante (L563) ; `.:<lot>` quand le projet est le dossier de lancement (`newWaveGesture`). */
export const addGesture = (waveId: string, key: string, launch?: string): string => `cadence orchestrate --add ${newWaveGesture(key, launch).slice('cadence orchestrate '.length)} --wave ${waveId}`;

/**
 * LE geste suivant d'un lot rendu au lead (L554), chaîne vide quand il n'y en a pas un d'exact : écart docs.sync (acquitter dans le dépôt principal, puis une nouvelle vague qui retrouve le worktree), rendu à l'intégration (`--integrate`, déposé tout de suite même sur
 * une vague vivante), écriture de plan refusée (`--replay`), lot retiré (nouvelle vague), lot rendu en fin de cycle sur une vague vivante (`--add`, L563). `wave.status === 'running'` : la vague est vivante, ses `--replay` se jouent à sa fin.
 */
export function lotGesture(wave: { id: string; status: string; cwd?: string }, l: Pick<LotState, 'project' | 'lot' | 'status' | 'next' | 'outcome'>): string {
  if (l.status !== 'handed-back') return '';
  const key = `${l.project}:${l.lot}`;
  const alive = wave.status === 'running';
  if (l.outcome === DROPPED) return alive ? atWaveEnd(newWaveGesture(key, wave.cwd)) : newWaveGesture(key, wave.cwd);
  if (l.outcome?.startsWith(DOCS_GAP)) return `raf docs-ok ${l.lot} --reason "…" (dépôt principal, plan commité), puis ${alive ? 'à la fin de la vague ' : ''}: ${newWaveGesture(key, wave.cwd)}`;
  if (l.next === 'integrate') return resumeCommand(wave.id, '--integrate', key);
  if (planNoteHandBack(l as LotState)) return replayGesture(wave.id, key, alive);
  // L563 : sur une vague vivante, le lot rendu en fin de cycle se rajoute tout de suite ; le geste ne lit pas l'arbre, un arbre sale est refusé par `--add` avec ses fichiers (R4).
  if (alive && addableHandBack(l)) return addGesture(wave.id, key, wave.cwd);
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

/** Les repères que le geste porte quand la sortie ne donne pas la valeur (L556) : jamais un identifiant inventé. */
const WAVE_MARK = '<vague>';
const LOT_MARK = '<projet:lot>';

/** Les fragments par lesquels un refus dit DÉJÀ son geste sur sa propre ligne (suffixes de `gestureSuffix`, `stillRunningRefusal`, `droppedAddSuffix`, `addHint`) : le hook n'y ajoute rien. */
const OWN_GESTURE = ['— le geste :', 'à la fin de la vague :', 'retiré de la vague : le lancer dans une nouvelle vague', 'pour y ajouter ce lot :'];
/** Le fragment de `withReplayHint`, imprimé sur une ligne à part APRÈS les refus de la reprise (resume.ts) : il porte le geste de toute la reprise, les lignes au-dessus n'en reçoivent aucun. */
const REPLAY_HINT = 'la reprise sans --replay :';

/** Au plus ce nombre de gestes par sortie (une sortie qui répète ses refus ne noie pas le contexte du lead). */
export const MAX_GESTURES = 5;

/** Le geste de l'option inconnue : `cadence --help` liste les commandes et leurs options (`cadence orchestrate --help` est refusé comme option inconnue). */
const HELP_GESTURE = 'cadence --help (la liste des commandes et de leurs options)';

/** Une entrée de la table : le motif du refus dans une ligne, puis la clé du refus distinct (motif et valeurs) et son geste. */
type Refusal = { when: RegExp; gesture: (m: RegExpExecArray) => [key: string, gesture: string] };

const REFUSALS: Refusal[] = [
  {
    when: /une orchestration y est déjà en cours(?: \(([^\s,)]+))?/,
    gesture: (m) => [`held ${m[1] ?? ''}`, `la vague ${m[1] ?? WAVE_MARK} tient le dépôt : ne pas boucler, attendre la notification de fin de sa tâche de fond ; l'état : cadence orchestrate --status`],
  },
  { when: /pas rendu à l'étape d'intégration/, gesture: () => ['integration', "lire l'état de la vague (colonne geste) : cadence orchestrate --status"] },
  { when: /la vague (?:(\S+) )?tourne encore/, gesture: (m) => [`running ${m[1] ?? ''}`, atWaveEnd(resumeCommand(m[1] ?? WAVE_MARK))] },
  {
    when: /(?:^|\s)(?:([^\s:]+:[^\s:]+) : )?lot déjà (?:en file d'ajout dans|dans) la vague/,
    gesture: (m) => [`already ${m[1] ?? ''}`, `le lot ${m[1] ?? LOT_MARK} est déjà dans la vague : cadence orchestrate --status`],
  },
  { when: /^\s*(?:orchestrate : )?(?:([^\s:]+:[^\s:]+) : )?.*ne tient pas le budget du lot/, gesture: (m) => [`budget ${m[1] ?? ''}`, atWaveEnd(newWaveGesture(m[1] ?? LOT_MARK))] },
  {
    when: /Unknown option(?: '([^']*)')?|option inconnue : (\S+)/,
    gesture: (m) => [`option ${m[1] ?? m[2] ?? ''}`, (m[1] ?? m[2]) ? `l'option ${m[1] ?? m[2]} est inconnue : ${HELP_GESTURE}` : HELP_GESTURE],
  },
];

/**
 * LA table refus → geste (L556), lue par le hook « retour → geste » : chaque ligne de `text` qui porte un refus connu et pas déjà son geste rend le geste exact, construit avec
 * `resumeCommand`, `atWaveEnd` et `newWaveGesture`. Un refus distinct (même motif, mêmes valeurs) compte une fois, dans l'ordre de la sortie, au plus `MAX_GESTURES`.
 * La ligne d'avancement « tenu par la vague … attente de sa fin » n'est pas un refus : aucune entrée. Les lignes qui précèdent la ligne
 * « la reprise sans --replay : » (R8) sont les refus de la reprise que cette ligne couvre : elles ne rendent rien.
 */
export function refusalGestures(text: string): string[] {
  const found = new Map<string, string>();
  const lines = text.split('\n');
  const hint = lines.findIndex((l) => l.includes(REPLAY_HINT));
  for (const line of lines.slice(hint + 1)) {
    if (found.size >= MAX_GESTURES) break;
    if (OWN_GESTURE.some((m) => line.includes(m))) continue;
    for (const { when, gesture } of REFUSALS) {
      const m = when.exec(line);
      if (!m) continue;
      const [key, text] = gesture(m);
      if (!found.has(key)) found.set(key, text);
    }
  }
  return [...found.values()].slice(0, MAX_GESTURES);
}

/**
 * Le geste d'une commande cadence/raf sortie en 137 (le processus a été tué, L556) : pour `cadence orchestrate`, la reprise de la vague (`wave` : l'id de son `--wave`, `<vague>` sinon) ;
 * pour toute autre commande, la relance en tâche de fond.
 */
export function killedGesture(orchestrate: boolean, wave?: string): string {
  return orchestrate ? resumeCommand(wave ?? WAVE_MARK) : 'le processus a été tué (137) : relancer la même commande en tâche de fond';
}
