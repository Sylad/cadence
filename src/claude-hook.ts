import { killedGesture, MAX_GESTURES, refusalGestures } from './orchestrate/geste.js';

/** Le rappel de la commande `attente` (L556) : une boucle d'attente sur un processus ne remplace ni la notification de fin ni le journal de la vague. */
const WAIT_REMINDER = "rappel : pas de boucle d'attente sur un processus (while/until + pgrep -f) : lancer la commande en tâche de fond et attendre sa notification de fin, suivre le journal de la vague avec Monitor, lire l'état avec cadence orchestrate --status.";

/** Une boucle d'attente : while ou until suivi, avant le do de la boucle, d'un pgrep à l'option -f (-f, -af, -fl…). Détection textuelle : un faux positif ne coûte qu'un rappel de trop. */
const WAIT_LOOP = /\b(?:while|until)\b(?:(?!\bdo\b)[\s\S])*?\bpgrep\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*f/;

/** Les séparateurs de commandes du shell (le premier mot de chaque segment est la commande jouée). */
const SEPARATORS = /&&|\|\||;|\||\n/;

/** Un segment cadence/raf : après d'éventuelles affectations NOM=valeur et `npx`, le premier mot est cadence ou raf (avec ou sans chemin). Rend ses mots après ce premier, ou null. */
function cadenceArgs(segment: string): string[] | null {
  let rest = segment.trim();
  for (;;) {
    const next = rest.replace(/^(?:[A-Za-z_]\w*=\S*|npx)\s+/, '');
    if (next === rest) break;
    rest = next;
  }
  const words = rest.split(/\s+/);
  return /^(?:\S*\/)?(?:cadence|raf)$/.test(words[0]!) ? words.slice(1) : null;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Tout ce que la commande a dit : la sortie (stdout, stderr, ou un texte) de PostToolUse et le texte d'erreur de PostToolUseFailure, lus quel que soit l'événement annoncé. */
function outputOf(input: Record<string, unknown>): string {
  const r = input.tool_response;
  const response = typeof r === 'string' ? r : r && typeof r === 'object' ? [asText((r as Record<string, unknown>).stdout), asText((r as Record<string, unknown>).stderr)].join('\n') : '';
  return [response, asText(input.error)].join('\n');
}

/** Vrai quand le code de sortie est 137 : « Exit code 137 » du texte d'erreur, ou un code numérique de la réponse de l'outil. */
function killed(input: Record<string, unknown>, text: string): boolean {
  const response = input.tool_response as Record<string, unknown> | string | undefined;
  const code = typeof response === 'object' ? (response.exit_code ?? response.exitCode) : undefined;
  return code === 137 || /Exit code 137(?!\d)/.test(text);
}

/** Le geste du 137 : la reprise de la vague d'un `cadence orchestrate` (son `--wave`, ou `--wave=`), sinon la relance en tâche de fond. */
function killedGestureOf(segments: string[][]): string {
  const orchestrate = segments.find((a) => a[0] === 'orchestrate');
  const at = orchestrate?.findIndex((w) => w === '--wave' || w.startsWith('--wave=')) ?? -1;
  const word = orchestrate?.[at];
  const wave = word === '--wave' ? orchestrate?.[at + 1] : word?.slice('--wave='.length);
  return killedGesture(orchestrate !== undefined, wave && !wave.startsWith('-') ? wave : undefined);
}

/** Les gestes d'une commande cadence/raf : ceux des refus de sa sortie, puis celui du 137 ; rien quand la commande n'a aucun segment cadence/raf. */
function returnGestures(data: Record<string, unknown>, command: string): string[] {
  const segments = command.split(SEPARATORS).map(cadenceArgs).filter((a): a is string[] => a !== null);
  if (!segments.length) return [];
  const text = outputOf(data);
  const gestures = refusalGestures(text);
  return killed(data, text) && gestures.length < MAX_GESTURES ? [...gestures, killedGestureOf(segments)] : gestures;
}

/** Le texte que le lead doit lire, ou null : `retour` (geste d'un refus de cadence/raf, ou du code 137) et `attente` (rappel contre la boucle d'attente). Toujours null pour un sous-agent (agent_id). */
export function claudeHookContext(name: string, input: unknown): { event: string; text: string } | null {
  const data = input as Record<string, unknown> | null;
  const command = (data?.tool_input as { command?: unknown } | undefined)?.command;
  if (!data || data.agent_id || typeof command !== 'string') return null;
  if (name === 'attente') return WAIT_LOOP.test(command) ? { event: 'PreToolUse', text: WAIT_REMINDER } : null;
  const gestures = returnGestures(data, command);
  if (!gestures.length) return null;
  return { event: data.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse', text: ['retour → geste :', ...gestures].join('\n') };
}

/** `cadence claude-hook retour|attente` : l'entrée standard est le JSON de Claude Code ; la sortie, le JSON additionalContext ou rien. Sort toujours en 0, sans rien dire d'une entrée illisible. */
export function claudeHook(name: string | undefined, readInput: () => string, out: (line: string) => void): number {
  if (name !== 'retour' && name !== 'attente') return 0;
  try {
    const said = claudeHookContext(name, JSON.parse(readInput()));
    if (said) out(JSON.stringify({ hookSpecificOutput: { hookEventName: said.event, additionalContext: said.text } }));
  } catch {
    // Entrée vide ou illisible : le hook ne gêne jamais.
  }
  return 0;
}
