import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { RafError } from '../plan.js';
import { add } from './add.js';
import { measure } from './measure.js';
import { referencesDir } from './store.js';

const USAGE_ADD = 'usage : cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]';
const USAGE_MEASURE = 'usage : cadence ref measure <slug> <page> <page | x,y | x,y,l,h> [--quoi couleurs|contraste|boites|texte] [--largeur 1440] [--json]';

/** `cadence ref <sous-verbe> …` : les documents de référence (issue #14). */
export function refCommand(rest: string[], values: { sections?: string; slug?: string; config?: string; quoi?: string; largeur?: string; json?: boolean }, root: string, io: Io): number {
  const [verb, ...args] = rest;
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  const refsDir = (): string => referencesDir(root, configPath, io.env);
  if (verb === 'add' && args.length === 1) {
    add({ document: args[0]!, slug: values.slug, sections: values.sections, env: io.env, cwd: io.cwd, refsDir, now: io.now(), out: io.out });
    return 0;
  }
  if (verb === 'measure' && args.length === 3) {
    measure({ slug: args[0]!, page: args[1]!, zone: args[2]!, quoi: values.quoi, largeur: values.largeur, env: io.env, refsDir, json: values.json === true, out: io.out });
    return 0;
  }
  throw new RafError(verb === 'add' ? USAGE_ADD : verb === 'measure' ? USAGE_MEASURE : `${USAGE_ADD}\n       ${USAGE_MEASURE.replace('usage : ', '')}`);
}
