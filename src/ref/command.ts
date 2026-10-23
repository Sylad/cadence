import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { RafError } from '../plan.js';
import { add } from './add.js';
import { referencesDir } from './store.js';

const USAGE = 'usage : cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]';

/** `cadence ref <sous-verbe> …` : les documents de référence (issue #14). */
export function refCommand(rest: string[], values: { sections?: string; slug?: string; config?: string }, root: string, io: Io): number {
  const [verb, ...args] = rest;
  if (verb !== 'add' || args.length !== 1) throw new RafError(USAGE);
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  add({ document: args[0]!, slug: values.slug, sections: values.sections, env: io.env, cwd: io.cwd, refsDir: () => referencesDir(root, configPath, io.env), now: io.now(), out: io.out });
  return 0;
}
