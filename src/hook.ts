import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from './git.js';
import { RafError } from './plan.js';

const BEGIN = '# >>> raf (cadence)';
const END = '# <<< raf (cadence)';
/** Code de sortie de `raf hook pre-commit` qui refuse le commit. */
export const REFUSED = 3;

/** La marque du hook pre-push qu'une vague pose le temps de la vague (src/orchestrate/guard.ts). */
export const WAVE_PRE_PUSH_MARK = '# cadence orchestrate — hook pre-push temporaire (retiré à la fin de la vague)';
/** La marque du hook pre-push de la porte que la vague laisse derrière elle (L426). */
export const GATE_PRE_PUSH_MARK = '# cadence — hook pre-push de la porte (L426) : refuse un push sans verdict vert de `cadence verify --gate`';

const BLOCKS = {
  'post-commit': `${BEGIN}\ncommand -v raf >/dev/null 2>&1 && raf hook post-commit || true\n${END}\n`,
  // Seul un refus (hook.autostart: refuse, code 3) arrête le commit : un raf plus ancien ou en panne le laisse passer.
  'pre-commit': `${BEGIN}\nif command -v raf >/dev/null 2>&1; then raf hook pre-commit; [ $? -ne ${REFUSED} ] || exit 1; fi\n${END}\n`,
  // L766 r1 : la garde du push hors vague (porte, revue de code, lots de la vague vivante). Une session d'orchestrate ne pousse jamais, comme sous le hook de
  // la vague. L'entrée de git (les lignes des réfs poussées) est lue une fois, donnée à raf, puis rendue au script maison qui suit le bloc.
  'pre-push': `${BEGIN}
if [ -n "$CADENCE_ORCHESTRATED" ]; then echo "cadence : push refusé pendant la vague $CADENCE_ORCHESTRATED (le lead pousse)" >&2; exit 1; fi
if command -v raf >/dev/null 2>&1; then
  raf_push_input=$(cat)
  printf '%s\\n' "$raf_push_input" | raf hook pre-push "$@"
  [ $? -ne ${REFUSED} ] || exit 1
  exec 0<<raf_push_input_end
$raf_push_input
raf_push_input_end
fi
${END}
`,
};

/** Un hook pre-push qui porte le bloc raf : il joue `raf hook pre-push` à chaque push, vague ou pas (L766 r1). */
export const hasRafPrePush = (text: string): boolean => text.includes(BEGIN) && text.includes('raf hook pre-push');

/**
 * Adds the raf blocks to post-commit, pre-commit and pre-push (L766 r1) without touching anything else already there.
 * The pre-commit block goes at the HEAD of the script (L697): a hand-written pre-commit that exits early (`exit 0` when nothing
 * it checks is staged) would never reach a block appended at the end, and a commit on a held branch would go through.
 * A block already there but lower is moved to the head, never duplicated.
 */
export function installHook(cwd: string): { path: string; changed: boolean; moved: string | null } {
  const post = installBlock(cwd, 'post-commit');
  const pre = installBlock(cwd, 'pre-commit');
  const push = installBlock(cwd, 'pre-push');
  const moved = [pre, push].filter((b) => b.moved).map((b) => b.path);
  return { path: post.path, changed: post.changed || pre.changed || push.changed, moved: moved.length ? moved.join(', ') : null };
}

/** Where each block goes in an existing script: pre-commit at the head (after the shebang), post-commit at the end (read-only, never refuses). */
const AT_HEAD: Record<keyof typeof BLOCKS, boolean> = { 'pre-commit': true, 'post-commit': false, 'pre-push': true };

/** Un hook pre-push posé par une vague ou laissé pour la porte : il ne porte aucune règle du projet, le bloc durable le remplace entier (il joue le même `raf hook pre-push`). */
const cadencePrePush = (name: keyof typeof BLOCKS, text: string) => name === 'pre-push' && (text.includes(WAVE_PRE_PUSH_MARK) || text.includes(GATE_PRE_PUSH_MARK));

function installBlock(cwd: string, name: keyof typeof BLOCKS): { path: string; changed: boolean; moved: boolean } {
  const dir = hooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const current = cadencePrePush(name, existing) ? '' : existing;
  const present = current.includes(BEGIN);
  const next = present ? (AT_HEAD[name] ? moveBlockToHead(current) : null) : placeBlock(current, name, path);
  if (next === null) return { path, changed: false, moved: false };
  writeFileSync(path, next);
  chmodSync(path, 0o755);
  return { path, changed: true, moved: present };
}

/** The script `current` (without a raf block) with the block of `name` added: at the head, or at the end before a final « exit ». */
function placeBlock(current: string, name: keyof typeof BLOCKS, path: string): string {
  const BLOCK = BLOCKS[name];
  if (current === '') return `#!/bin/sh\n${BLOCK}`;
  if (!/^#!.*\b(sh|bash|zsh|dash)\b/.test(current)) {
    throw new RafError(`${path} n'est pas un script shell : y ajouter à la main « raf hook ${name} »`);
  }
  const lines = current.replace(/\n*$/, '').split('\n');
  // En tête : juste après le shebang, avant toute commande du script maison, dont un « exit 0 » précoce.
  // À la fin : un « exit » final empêcherait le bloc de s'exécuter, on l'insère juste avant.
  const last = lines.length - 1;
  const at = AT_HEAD[name] ? 1 : /^\s*exit\b/.test(lines[last]) ? last : lines.length;
  lines.splice(at, 0, BLOCK.trimEnd());
  return `${lines.join('\n')}\n`;
}

/**
 * The script with its raf block moved right after the shebang, or null when it is already at the head (only the shebang,
 * blank lines and comments before it) or when the block's end marker is missing (a hand-edited block is left alone).
 */
export function moveBlockToHead(script: string): string | null {
  const lines = script.replace(/\n*$/, '').split('\n');
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END, begin);
  if (begin < 0 || end < 0) return null;
  const head = lines[0]?.startsWith('#!') ? 1 : 0;
  if (lines.slice(head, begin).every((l) => /^\s*(#.*)?$/.test(l))) return null;
  const block = lines.splice(begin, end - begin + 1);
  lines.splice(head, 0, ...block);
  return `${lines.join('\n')}\n`;
}

/**
 * Message d'un `git commit` d'après ses arguments (-m, -am, --message, plusieurs -m, -F) ; null sans message
 * en ligne de commande (éditeur, --amend, -C…) ou si ce n'est pas un commit.
 */
export function messageFromArgv(argv: string[]): string | null {
  const at = argv.indexOf('commit');
  if (at < 0) return null;
  const parts: string[] = [];
  let file: string | null = null;
  for (let i = at + 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a.startsWith('--message=')) parts.push(a.slice('--message='.length));
    else if (a === '--message') parts.push(argv[++i] ?? '');
    else if (a.startsWith('--file=')) file = a.slice('--file='.length);
    else if (a === '--file') file = argv[++i] ?? null;
    else if (/^-[A-Za-z]+$/.test(a) && /[mF]$/.test(a)) {
      // « -am », « -qm » : la dernière lettre prend l'argument suivant.
      const value = argv[++i] ?? '';
      if (a.endsWith('m')) parts.push(value);
      else file = value;
    } else if (/^-[A-Za-z]*m./.test(a) && !a.startsWith('--')) parts.push(a.slice(a.indexOf('m') + 1));
    else if (/^-F./.test(a)) file = a.slice(2);
  }
  if (parts.length > 0) return parts.join('\n\n');
  if (file !== null) {
    try {
      return readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/** Arguments du processus `pid` (Linux : /proc) ; null si illisibles. */
function argvOf(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
  } catch {
    return null;
  }
}

function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Message du commit en cours depuis un pre-commit, quand git ne le donne pas encore : celui de la ligne de
 * commande du `git commit` qui nous a lancés (ancêtres du hook), ou CADENCE_COMMIT_MESSAGE. Null sinon.
 */
export function pendingCommitMessage(env: NodeJS.ProcessEnv, pid = process.ppid): string | null {
  if (env.CADENCE_COMMIT_MESSAGE) return env.CADENCE_COMMIT_MESSAGE;
  let cur: number | null = pid;
  for (let depth = 0; cur !== null && depth < 6; depth++) {
    const argv = argvOf(cur);
    const msg = argv && /(^|\/)git$/.test(argv[0] ?? '') ? messageFromArgv(argv) : null;
    if (msg !== null) return msg;
    cur = parentOf(cur);
  }
  return null;
}
