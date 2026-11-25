// L781 (revue r1) : `run.regenerate` de cadence.yaml déclare les commandes que cadence run joue avant sa porte (rien n'est deviné d'un nom de script).
// Lue avec le même code (scripts/regeneration.mjs) par cadence run (v2/src/run/regenerer.ts) et par validateConfig : une forme mal formée est refusée
// par les deux en nommant la clé, jamais lue comme « rien à régénérer ». L'exemple de docs/config.md se relit tel quel.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config-set.js';
import { RafError } from '../src/plan.js';
import { lireRegeneration } from '../scripts/regeneration.mjs';
import { commandesDeRegeneration } from '../v2/src/run/regenerer.js';
import { tempDir } from './helpers.js';

function projet(yaml: string): { dir: string; file: string } {
  const dir = tempDir();
  const file = join(dir, 'cadence.yaml');
  writeFileSync(file, yaml);
  return { dir, file };
}

describe('run.regenerate de cadence.yaml (L781)', () => {
  it('lit la liste { command, dir } ; dir absent = racine ; sans la clé : rien', () => {
    expect(lireRegeneration(undefined, 'f')).toEqual([]);
    expect(lireRegeneration({ purgeAfterDays: 3, worktreeOutside: true }, 'f')).toEqual([]);
    expect(lireRegeneration({ regenerate: [{ command: ' npm run news ', dir: 'frontend/' }, { command: 'npm run plan' }] }, 'f'))
      .toEqual([{ command: 'npm run news', dir: 'frontend' }, { command: 'npm run plan', dir: '.' }]);
    const p = projet('run:\n  purgeAfterDays: 14\n  regenerate:\n    - { command: npm run news, dir: frontend }\n');
    expect(commandesDeRegeneration(p.dir)).toEqual([{ command: 'npm run news', dir: 'frontend' }]);
    expect(() => validateConfig(p.file, p.dir)).not.toThrow();
  });

  it('une forme mal formée est refusée pareil par validateConfig et cadence run, en nommant la clé', () => {
    for (const [yaml, raison] of [
      ['run: abc\n', 'run doit être un objet'],
      ['run:\n  regenerat: []\n', 'run.regenerat inconnu (attendu : purgeAfterDays, worktreeOutside, regenerate, fastGate)'],
      ['run:\n  regenerate: npm run news\n', 'run.regenerate : liste non vide de { command, dir } attendue'],
      ['run:\n  regenerate: []\n', 'run.regenerate : liste non vide de { command, dir } attendue'],
      ['run:\n  regenerate:\n    - npm run news\n', 'run.regenerate[0] : objet { command, dir } attendu'],
      ['run:\n  regenerate:\n    - { command: "" }\n', 'run.regenerate[0].command : commande non vide attendue'],
      ['run:\n  regenerate:\n    - { command: x, cwd: a }\n', 'run.regenerate[0].cwd inconnu (attendu : command, dir)'],
      ['run:\n  regenerate:\n    - { command: x, dir: /tmp }\n', 'run.regenerate[0].dir : « /tmp » sort du dépôt'],
      ['run:\n  regenerate:\n    - { command: x, dir: a/../../b }\n', 'run.regenerate[0].dir : « a/../../b » sort du dépôt'],
      ['run:\n  regenerate:\n    - { command: x, dir: "~/b" }\n', 'run.regenerate[0].dir : « ~/b » sort du dépôt'],
    ] as const) {
      const p = projet(yaml);
      expect(() => validateConfig(p.file, p.dir), yaml).toThrow(RafError);
      expect(() => validateConfig(p.file, p.dir), yaml).toThrow(raison);
      expect(() => commandesDeRegeneration(p.dir), yaml).toThrow(raison);
    }
  });

  it('l\'exemple de docs/config.md se relit et déclare news dans frontend/ puis la régénération du plan', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'config.md'), 'utf8');
    const bloc = /```yaml\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('## Generated files: `run.regenerate`')))?.[1] ?? '';
    expect(lireRegeneration((parse(bloc) as { run: unknown }).run, 'docs/config.md')).toEqual([
      { command: 'npm run news', dir: 'frontend' }, { command: 'npm run plan', dir: '.' },
    ]);
  });
});
