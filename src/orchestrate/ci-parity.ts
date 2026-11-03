import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import { readOrchestrateConfig } from '../config.js';
import { isObject } from '../yaml-keys.js';
import type { GateTest } from './gate-parts.js';

/** Une commande de test que la CI du dépôt joue (L499) et que la porte (`orchestrate.test`, `orchestrate.build`) ne joue pas. */
export interface CiGap {
  command: string;
  /** Le fichier de workflow où elle est lue, sous `.github/workflows/`. */
  workflow: string;
}

const WORKFLOWS = '.github/workflows';
/** Profondeur à laquelle un script npm qui en appelle un autre est suivi (garde contre `a` → `b` → `a`). */
const SCRIPT_DEPTH = 3;
/** Les lanceurs de tests reconnus, au début d'une commande (après `npx`, les variables d'environnement et les scripts npm dépliés). */
const TEST_RUNNER = /^((npm|pnpm|yarn) (run )?test(?![\w-])|(vitest|jest|mocha|playwright test|cypress run|pytest|python3? -m pytest|tox|rspec|phpunit|mvn (test|verify)|gradlew? test|go test|cargo test|dotnet test|ng (test|e2e))(?![\w-]))/;
/** Un script npm de test que package.json ne définit pas (ou illisible) : le nom suffit. */
const TEST_SCRIPT = /^(npm|pnpm|yarn) run (test|e2e)\S*/;
/** Les enveloppes d'un lanceur (écran virtuel, délai…), retirées avant la reconnaissance. */
const WRAPPER = /^(xvfb-run|timeout|time|env|nice)(\s+-\S+)*(\s+\d+[smhd]?)?\s+/;
/** Les variables d'environnement en tête de commande, valeur entre guillemets comprise. */
const ENV_PREFIX = /^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/;

function packageScripts(repo: string, dir: string): Record<string, string> {
  if (dir.startsWith('..') || isAbsolute(dir)) return {}; // hors du dépôt : rien à lire
  try {
    const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as { scripts?: unknown };
    return isObject(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {}; // pas de package.json, ou illisible : les commandes npm restent telles quelles
  }
}

/** Découpe une ligne sur `&&`, `||`, `|` et `;` hors des guillemets. */
function splitLine(line: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '&' || c === '|' || c === ';') {
      parts.push(line.slice(from, i));
      if ((c === '&' || c === '|') && line[i + 1] === c) i++;
      from = i + 1;
    }
  }
  parts.push(line.slice(from));
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Les commandes simples d'un texte shell : lignes (continuations `\` jointes, commentaires et vides écartés) puis `&&`, `||`, `|` et `;` hors guillemets. */
function segments(text: string): string[] {
  const lines = text.replace(/\s*\\\r?\n\s*/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.flatMap(splitLine);
}

/** Les commandes feuilles de `text`, `npm test` / `npm run x` remplacés par le script de package.json de `dir` (suivi à travers les `cd`) quand il existe. */
function leaves(repo: string, dir: string, text: string, depth = SCRIPT_DEPTH): string[] {
  let cwd = dir;
  return segments(text).flatMap((s) => {
    const cd = /^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(s);
    if (cd) {
      cwd = posix.normalize(posix.join(cwd, cd[1] ?? cd[2] ?? cd[3]!));
      return [];
    }
    const m = /^(?:npm|pnpm|yarn)(?: run)? ([\w:.-]+)\s*(?:--(?:\s.*)?)?$/.exec(s);
    const body = m && depth > 0 ? packageScripts(repo, cwd)[m[1]!] : undefined;
    return body === undefined ? [s] : leaves(repo, cwd, body, depth - 1);
  });
}

/** La clé de comparaison : sans variables d'environnement ni `npx`, et coupée au premier argument qui commence par `-` (les options ne font pas une autre commande). */
function key(command: string): string {
  let rest = command;
  for (let again = true; again; ) {
    const next = rest.replace(ENV_PREFIX, '').replace(WRAPPER, '').replace(/^npx(\s+(--no-install|-y|--yes))?\s+/, '');
    again = next !== rest;
    rest = next;
  }
  const words = rest.replace(/^python3?\s+-m\s+pytest\b/, 'pytest').replace(/^mvn(\s+-\S+)*\s+/, 'mvn ').split(/\s+/);
  const end = words.findIndex((w) => w.startsWith('-'));
  return (end < 0 ? words : words.slice(0, end)).join(' ');
}

const isTest = (command: string): boolean => TEST_RUNNER.test(key(command)) || TEST_SCRIPT.test(key(command));

/** Les commandes `run:` d'un workflow avec leur dossier de travail (étape, sinon défaut du job) ; vide si le fichier ne se lit pas ou n'a pas la forme attendue. */
function workflowRuns(file: string): { run: string; dir: string }[] {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const jobs = isObject(doc) && isObject(doc.jobs) ? Object.values(doc.jobs) : [];
  return jobs.filter(isObject).flatMap((job) => {
    const defaults = isObject(job.defaults) && isObject(job.defaults.run) ? job.defaults.run['working-directory'] : undefined;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    return steps.filter(isObject).flatMap((step) => {
      if (typeof step.run !== 'string') return [];
      const dir = step['working-directory'] ?? defaults;
      return [{ run: step.run, dir: typeof dir === 'string' ? posix.normalize(dir) : '.' }];
    });
  });
}

/** Les commandes que la porte joue : `orchestrate.test` (chaque partie dans son dossier) et `orchestrate.build`. */
function gateKeys(repo: string, test: GateTest | undefined, build: string | undefined): Set<string> {
  const parts = typeof test === 'string' || test === undefined ? [{ dir: '.', run: test }] : test.map((p) => ({ dir: posix.normalize(p.dir), run: p.run }));
  return new Set([...parts, { dir: '.', run: build }].flatMap((p) => (p.run ? leaves(repo, p.dir, p.run).map(key) : [])));
}

/**
 * Les commandes de test des workflows CI du dépôt que la porte ne joue pas (L499), dans l'ordre des fichiers, chacune une fois ; vide sans workflows,
 * sans `orchestrate.test` ni `orchestrate.build` (rien à comparer : `noTestGate` le dit déjà) ou avec un cadence.yaml illisible (il a sa propre erreur).
 * Une commande est une commande de test (lanceur reconnu, `npm test` et `npm run <script>` dépliés par le package.json de son dossier) ; deux commandes sont la même
 * si elles ne diffèrent que par les variables d'environnement, `npx` et les options (`--coverage`) : un fichier ou un projet nommé reste une autre commande.
 */
export function ciParityGaps(repo: string): CiGap[] {
  let test: GateTest | undefined;
  let build: string | undefined;
  try {
    ({ test, build } = readOrchestrateConfig(join(repo, 'cadence.yaml')));
  } catch {
    return [];
  }
  const dir = join(repo, WORKFLOWS);
  if ((!test && !build) || !existsSync(dir)) return [];
  const played = gateKeys(repo, test, build);
  const seen = new Set<string>();
  const gaps: CiGap[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // .github/workflows n'est pas un dossier
  }
  for (const workflow of files.filter((f) => /\.ya?ml$/.test(f)).sort()) {
    for (const { run, dir: cwd } of workflowRuns(join(dir, workflow))) {
      for (const command of leaves(repo, cwd, run)) {
        if (!isTest(command) || played.has(key(command)) || seen.has(key(command))) continue;
        seen.add(key(command));
        gaps.push({ command, workflow });
      }
    }
  }
  return gaps;
}

/** La phrase du signalement, sans le nom du projet. */
export function ciParityText(g: CiGap): string {
  return `parité porte ↔ CI : la CI (${g.workflow}) joue « ${g.command} », que orchestrate.test et orchestrate.build ne jouent pas — une porte verte ne dit rien de ce test, il ne rougira qu'à la CI`;
}


/** Écrit une ligne par écart (L499) ; `prefix` précède chacune (indentation et nom du dépôt du dry-run). */
export function reportCiParity(repo: string, out: (line: string) => void, prefix = ''): void {
  ciParityGaps(repo).forEach((g) => out(`${prefix}${ciParityText(g)}`));
}

/** Le champ `ciGaps` d'une ligne du tour : vide quand la porte couvre la CI. */
export function ciGapsField(repo: string): { ciGaps?: CiGap[] } {
  const ciGaps = ciParityGaps(repo);
  return ciGaps.length ? { ciGaps } : {};
}
