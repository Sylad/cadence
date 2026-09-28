import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from './git.js';

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
  const base = current === '' ? '#!/bin/sh\n' : current.endsWith('\n') ? current : `${current}\n`;
  writeFileSync(path, `${base}${BLOCK}`);
  chmodSync(path, 0o755);
  return { path, changed: true };
}
