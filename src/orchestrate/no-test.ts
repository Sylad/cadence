import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../config.js';

/** Un projet sans `orchestrate.test` (L327) : `probable` est la commande que ses fichiers laissent deviner, ou null. */
export interface NoTestGate {
  probable: string | null;
}

/** Le script que `npm init` écrit quand on ne dit rien : il échoue toujours, ce n'est pas une suite. */
const NPM_PLACEHOLDER = /no test specified/i;

/** La commande de test que le dépôt laisse deviner : `scripts.test` de package.json, pytest de pyproject.toml, pom.xml ; null sinon. */
export function probableTestCommand(repo: string): string | null {
  const pkg = join(repo, 'package.json');
  if (existsSync(pkg)) {
    try {
      const test = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: { test?: unknown } }).scripts?.test;
      if (typeof test === 'string' && test.trim() && !NPM_PLACEHOLDER.test(test)) return 'npm test';
    } catch {
      // un package.json illisible ne donne aucune commande
    }
  }
  const py = join(repo, 'pyproject.toml');
  if (existsSync(py) && /pytest/i.test(readFileSync(py, 'utf8'))) return 'pytest';
  if (existsSync(join(repo, 'pom.xml'))) return 'mvn test';
  return null;
}

/** Le projet n'a pas de `orchestrate.test` : ce qu'on en dit, ou null quand il en a un. Un cadence.yaml illisible ne se signale pas ici (il a déjà sa propre erreur). */
export function noTestGate(repo: string): NoTestGate | null {
  let test: string | undefined;
  try {
    test = readOrchestrateConfig(join(repo, 'cadence.yaml')).test;
  } catch {
    return null;
  }
  return test ? null : { probable: probableTestCommand(repo) };
}

/** La phrase du signalement, sans le nom du projet. */
export function noTestText(g: NoTestGate): string {
  const probable = g.probable ? ` · commande probable : ${g.probable} (à déclarer en orchestrate.test)` : '';
  return `porte de tests absente : orchestrate.test n'est pas déclaré, la vague ne lancera pas la suite (seule la revue le fera si elle le décide)${probable}`;
}
