import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from './git.js';
import { RafError } from './plan.js';

const BEGIN = '# >>> raf (cadence)';
const END = '# <<< raf (cadence)';
/** Code de sortie de `raf hook pre-commit` qui refuse le commit. */
export const REFUSED = 3;

const BLOCKS = {
  'post-commit': `${BEGIN}\ncommand -v raf >/dev/null 2>&1 && raf hook post-commit || true\n${END}\n`,
  // Seul un refus (hook.autostart: refuse, code 3) arrête le commit : un raf plus ancien ou en panne le laisse passer.
  'pre-commit': `${BEGIN}\ncommand -v raf >/dev/null 2>&1 && { raf hook pre-commit || { [ $? -ne ${REFUSED} ] || exit 1; }; }\n${END}\n`,
};

/** Adds the raf blocks to post-commit and pre-commit without touching anything else already there. */
export function installHook(cwd: string): { path: string; changed: boolean } {
  const post = installBlock(cwd, 'post-commit');
  const pre = installBlock(cwd, 'pre-commit');
  return { path: post.path, changed: post.changed || pre.changed };
}

function installBlock(cwd: string, name: keyof typeof BLOCKS): { path: string; changed: boolean } {
  const BLOCK = BLOCKS[name];
  const dir = hooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.includes(BEGIN)) return { path, changed: false };
  if (current !== '' && !/^#!.*\b(sh|bash|zsh|dash)\b/.test(current)) {
    throw new RafError(`${path} n'est pas un script shell : y ajouter à la main « raf hook ${name} »`);
  }
  let next: string;
  if (current === '') {
    next = `#!/bin/sh\n${BLOCK}`;
  } else {
    const lines = current.replace(/\n*$/, '').split('\n');
    // Un « exit » final empêcherait le bloc de s'exécuter : on l'insère juste avant.
    const last = lines.length - 1;
    if (/^\s*exit\b/.test(lines[last])) lines.splice(last, 0, BLOCK.trimEnd());
    else lines.push(BLOCK.trimEnd());
    next = `${lines.join('\n')}\n`;
  }
  writeFileSync(path, next);
  chmodSync(path, 0o755);
  return { path, changed: true };
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
