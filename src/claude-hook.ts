import { killedGesture, MAX_GESTURES, refusalGestures } from './orchestrate/geste.js';

/** Le rappel de la commande `attente` (L556) : une boucle d'attente sur un processus ne remplace ni la notification de fin ni le journal de la vague. */
const WAIT_REMINDER = "rappel : pas de boucle d'attente sur un processus (while/until + pgrep -f) : lancer la commande en tâche de fond et attendre sa notification de fin, suivre le journal de la vague avec Monitor, lire l'état avec cadence orchestrate --status.";

/** Les mots qui comptent pour une boucle d'attente : l'ouverture (while, until), le do qui la ferme, et pgrep. */
const LOOP_WORDS = /\b(?:while|until|do|pgrep)\b/g;

/** Une boucle d'attente : while ou until suivi, avant le do de la boucle, d'un pgrep à l'option -f (-f, -af, -fl…, même après une option à valeur : -u $USER -f). Détection textuelle en un seul passage : un faux positif ne coûte qu'un rappel de trop. */
function hasWaitLoop(command: string): boolean {
  let inHead = false;
  for (const m of command.matchAll(LOOP_WORDS)) {
    if (m[0] === 'while' || m[0] === 'until') inHead = true;
    else if (m[0] === 'do') inHead = false;
    else if (inHead) {
      const args = command.slice(m.index + m[0].length).split(/[;|&()\n]/, 1)[0]!;
      if (args.split(/\s+/).some((w) => /^-[A-Za-z]*f/.test(w))) return true;
    }
  }
  return false;
}

/** Les morceaux d'une commande : un texte entre guillemets, un caractère échappé, un séparateur (&& || ; | |& retour à la ligne) ou du texte courant. */
const SHELL_TOKEN = /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?|\\[\s\S]|&&|\|\||\|&|[;|\n]|[^"'\\;|&\n]+|&/g;
const SEPARATOR = /^(?:&&|\|\||\|&|[;|\n])$/;

/** Découpe la commande aux séparateurs du shell hors guillemets : le premier mot de chaque segment est la commande jouée. */
function splitSegments(command: string): string[] {
  const segments = [''];
  for (const [token] of command.matchAll(SHELL_TOKEN)) {
    if (SEPARATOR.test(token)) segments.push('');
    else segments[segments.length - 1] += token;
  }
  return segments;
}

/** Ce qui précède la commande jouée et ne la change pas : affectation NOM=valeur ou `NOM=$(`, ouvreur de groupe ou de sous-shell, `!`, mot-clé (if, then, time…), `env`/`command`/`exec`, `npx` et `npm|pnpm|yarn exec|dlx` avec leurs options. */
const COMMAND_PREFIX = /^(?:[A-Za-z_]\w*=\$\(|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+|[({!]+\s*|(?:if|then|elif|else|do|while|until|time|command|exec|sudo|nohup|env|npx|(?:npm|pnpm|yarn)\s+(?:exec|dlx))\s+(?:-[-\w=]*\s+)*)/;

/** Les mots d'un segment après ses préfixes (COMMAND_PREFIX), sans les `)` et `}` fermants collés au dernier mot. */
function commandWords(segment: string): string[] {
  let rest = segment.trim();
  for (;;) {
    const next = rest.replace(COMMAND_PREFIX, '');
    if (next === rest) break;
    rest = next;
  }
  return rest.split(/\s+/).map((w) => w.replace(/[)}]+$/, ''));
}

/** Un segment cadence/raf : le premier mot est cadence ou raf (avec ou sans chemin). Rend le programme (cadence ou raf) suivi de ses mots, ou null. */
function cadenceArgs(segment: string): string[] | null {
  const words = commandWords(segment);
  const program = /^(?:\S*\/)?(cadence|raf)$/.exec(words[0]!)?.[1];
  return program ? [program, ...words.slice(1)] : null;
}

/** Les commandes de raf qui écrivent le plan et peuvent refuser (R16). */
const RAF_REFUSING = new Set(['add', 'start', 'done', 'review', 'ux', 'docs-ok']);

/** Vrai pour un segment qui PEUT refuser (R16) : cadence orchestrate hors --status et --dry-run, cadence deliver, verify, local, spec reseal|green, raf add|start|done|review|ux|docs-ok. Une commande de lecture (raf show, list, now, cadence lead tour, orchestrate --status, session start) peut citer un refus dans un titre ou une note : sa sortie n'est pas lue. */
function canRefuse([program, sub, ...rest]: string[]): boolean {
  if (program === 'raf') return RAF_REFUSING.has(sub ?? '');
  if (sub === 'orchestrate') return !rest.some((w) => w === '--status' || w === '--dry-run');
  if (sub === 'spec') return rest[0] === 'reseal' || rest[0] === 'green';
  return sub === 'deliver' || sub === 'verify' || sub === 'local';
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Tout ce que la commande a dit : la sortie (stdout, stderr, ou un texte) de PostToolUse et le texte d'erreur de PostToolUseFailure, lus quel que soit l'événement annoncé. */
function outputOf(input: Record<string, unknown>): string {
  const r = input.tool_response;
  const response = typeof r === 'string' ? r : r && typeof r === 'object' ? [asText((r as Record<string, unknown>).stdout), asText((r as Record<string, unknown>).stderr)].join('\n') : '';
  return [response, asText(input.error)].join('\n');
}

/** Vrai quand le code de sortie est 137 (R5) : « Exit code 137 » du seul champ `error` (PostToolUseFailure), ou un code numérique de la réponse de l'outil. La sortie (stdout, stderr) n'est jamais lue ici : un titre qui cite « Exit code 137 » n'est pas un code de sortie. */
function killed(input: Record<string, unknown>): boolean {
  const response = input.tool_response as Record<string, unknown> | string | undefined;
  const code = typeof response === 'object' && response !== null ? (response.exit_code ?? response.exitCode) : undefined;
  return code === 137 || /Exit code 137(?!\d)/.test(asText(input.error));
}

/** Le geste du 137 : la reprise de la vague d'un `cadence orchestrate` (son `--wave`, ou `--wave=`), sinon la relance en tâche de fond. */
function killedGestureOf(segments: string[][]): string {
  const orchestrate = segments.find((a) => a[0] === 'cadence' && a[1] === 'orchestrate');
  const at = orchestrate?.findIndex((w) => w === '--wave' || w.startsWith('--wave=')) ?? -1;
  const word = orchestrate?.[at];
  const wave = word === '--wave' ? orchestrate?.[at + 1] : word?.slice('--wave='.length);
  return killedGesture(orchestrate !== undefined, wave && !wave.startsWith('-') ? wave : undefined);
}

/** Les gestes d'une commande cadence/raf : ceux des refus de sa sortie quand un segment peut refuser (R16), puis celui du 137 ; rien quand la commande n'a aucun segment cadence/raf. */
function returnGestures(data: Record<string, unknown>, command: string): string[] {
  const segments = splitSegments(command).map(cadenceArgs).filter((a): a is string[] => a !== null);
  if (!segments.length) return [];
  const gestures = segments.some(canRefuse) ? refusalGestures(outputOf(data)) : [];
  return killed(data) && gestures.length < MAX_GESTURES ? [...gestures, killedGestureOf(segments)] : gestures;
}

/** Les étages `a | b` (ou `a |& b`) de chaque pipeline de la commande (`&&`, `||`, `;`, retour à la ligne les séparent), hors guillemets. Un retour à la ligne ou un `\\` en fin de ligne après le `|` ne coupe pas le pipeline. */
function pipelines(command: string): string[][] {
  const result: string[][] = [['']];
  for (const [token] of command.matchAll(SHELL_TOKEN)) {
    const stages = result[result.length - 1]!;
    if (token === '|' || token === '|&') stages.push('');
    else if (token === '\n' && stages.length > 1 && !stages[stages.length - 1]!.trim()) continue;
    else if (SEPARATOR.test(token)) result.push(['']);
    else stages[stages.length - 1] += token === '\\\n' ? ' ' : token;
  }
  return result;
}

/** Les filtres dont le code de sortie remplace celui de la commande placée avant eux dans un pipe. */
const FILTERS = new Set(['tail', 'head', 'grep', 'egrep', 'fgrep', 'rg']);

/** La commande de test ou de push d'un segment hors cadence/raf, telle qu'écrite : git push, npm|pnpm|yarn test (ou run test), vitest, jest, pytest, tsc ; sinon null. */
function testGate(words: string[]): string | null {
  const [first = '', second, third] = words;
  const base = first.replace(/^.*\//, '');
  if (base === 'git') {
    let at = 1;
    while (words[at] === '-C' || words[at] === '-c') at += 2;
    return words[at] === 'push' ? words.slice(0, at + 1).join(' ') : null;
  }
  if (['npm', 'pnpm', 'yarn'].includes(base)) {
    if (second === 'test' || second === 't') return `${base} ${second}`;
    return second === 'run' && /^test(?::|$)/.test(third ?? '') ? `${base} run ${third}` : null;
  }
  return ['vitest', 'jest', 'pytest', 'tsc'].includes(base) ? words.slice(0, 2).join(' ') : null;
}

/** Le nom du filtre d'un étage (sans chemin), ou ''. */
const filterOf = (stage: string): string => commandWords(stage)[0]!.replace(/^.*\//, '');

/** Met à jour l'état de pipefail d'après un étage `set` : `-o pipefail` (ou `-eo pipefail`) l'arme, `+o pipefail` le désarme. */
function pipefailAfter(armed: boolean, stage: string): boolean {
  const words = commandWords(stage);
  if (words[0] !== 'set') return armed;
  let state = armed;
  words.forEach((w, i) => {
    if (/^[-+]\w*o$/.test(w) && words[i + 1] === 'pipefail') state = w[0] === '-';
  });
  return state;
}

/** La première commande de porte, de test, de push ou de livraison (cadence/raf qui peut refuser, ou testGate) des étages placés avant un filtre tail/head/grep, ou null s'il n'y a pas de filtre. */
function gateBeforeFilter(stages: string[]): string | null {
  const filterAt = stages.findIndex((stage, i) => i > 0 && FILTERS.has(filterOf(stage)));
  for (const stage of filterAt < 0 ? [] : stages.slice(0, filterAt)) {
    const cadence = cadenceArgs(stage);
    if (cadence && canRefuse(cadence)) return cadence.slice(0, 3).join(' ');
    const gate = testGate(commandWords(stage));
    if (gate) return gate;
  }
  return null;
}

/** La première porte, test, push ou livraison suivie d'un filtre dans le même pipe, quand pipefail n'est pas armé par un `set -o pipefail` joué avant (le mot cité, en commentaire ou dans un `set +o`, n'arme rien) et que la commande ne lit pas PIPESTATUS ; sinon null. Un `)` ou un `}` qui ouvre le pipeline le rattache au groupe ouvert avant. */
function maskedGate(command: string): string | null {
  if (/PIPESTATUS/.test(command)) return null;
  let armed = false;
  let group: string[] = [];
  for (const stages of pipelines(command)) {
    group = /^\s*[({]/.test(stages[0]!) ? [] : group;
    const closing = /^\s*[)}]/.test(stages[0]!);
    for (const stage of stages) armed = pipefailAfter(armed, stage);
    const gate = armed ? null : gateBeforeFilter(closing ? [...group, ...stages] : stages);
    if (gate) return gate;
    group.push(...stages);
  }
  return null;
}

/** Le refus : pourquoi, et les trois écritures qui gardent le code de sortie. */
function pipeReason(gate: string): string {
  return `refusé : « ${gate} » est suivi de | tail/head/grep, et le code de sortie du pipe est celui du filtre : un échec de la commande passe pour un succès. Écrire « set -o pipefail; <commande> | tail », ou lire « \${PIPESTATUS[0]} » juste après le pipe, ou rediriger vers un fichier de $TMPDIR (« > $TMPDIR/sortie.txt 2>&1 ») puis lire le fichier.`;
}

/** Le texte que le lead doit lire, ou null : `retour` (geste d'un refus de cadence/raf, ou du code 137), `attente` (rappel contre la boucle d'attente) et `pipe` (refus du pipe qui masque le code de sortie). Toujours null pour un sous-agent (agent_id). */
export function claudeHookContext(name: string, input: unknown): { event: string; text: string; deny?: true } | null {
  const data = input as Record<string, unknown> | null;
  const command = (data?.tool_input as { command?: unknown } | undefined)?.command;
  if (!data || data.agent_id || typeof command !== 'string') return null;
  if (name === 'pipe') {
    const gate = maskedGate(command);
    return gate ? { event: 'PreToolUse', text: pipeReason(gate), deny: true } : null;
  }
  if (name === 'attente') return hasWaitLoop(command) ? { event: 'PreToolUse', text: WAIT_REMINDER } : null;
  const gestures = returnGestures(data, command);
  if (!gestures.length) return null;
  return { event: data.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse', text: ['retour → geste :', ...gestures].join('\n') };
}

/** `cadence claude-hook retour|attente|pipe` : l'entrée standard est le JSON de Claude Code ; la sortie, le JSON additionalContext (pour `pipe` : permissionDecision deny) ou rien. Sort toujours en 0, sans rien dire d'une entrée illisible. */
export function claudeHook(name: string | undefined, readInput: () => string, out: (line: string) => void): number {
  if (name !== 'retour' && name !== 'attente' && name !== 'pipe') return 0;
  try {
    const said = claudeHookContext(name, JSON.parse(readInput()));
    if (said) out(JSON.stringify({ hookSpecificOutput: { hookEventName: said.event, ...(said.deny ? { permissionDecision: 'deny', permissionDecisionReason: said.text } : { additionalContext: said.text }) } }));
  } catch {
    // Entrée vide ou illisible : le hook ne gêne jamais.
  }
  return 0;
}
