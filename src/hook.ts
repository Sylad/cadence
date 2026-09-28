import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from './git.js';
import { RafError } from './plan.js';

const BEGIN = '# >>> raf (cadence)';
const END = '# <<< raf (cadence)';
const BLOCK = `${BEGIN}\ncommand -v raf >/dev/null 2>&1 && raf hook post-commit || true\n${END}\n`;

/** Adds the raf block to post-commit without touching anything else already there. */
export function installHook(cwd: string): { path: string; changed: boolean } {
  const dir = hooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'post-commit');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.includes(BEGIN)) return { path, changed: false };
  if (current !== '' && !/^#!.*\b(sh|bash|zsh|dash)\b/.test(current)) {
    throw new RafError(`${path} n'est pas un script shell : y ajouter à la main « raf hook post-commit »`);
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
